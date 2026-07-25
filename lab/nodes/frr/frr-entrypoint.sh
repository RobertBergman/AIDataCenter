#!/bin/bash
# Zero-touch provisioning agent for an FRR fabric switch.
#
# Identical contract to the sonic-vs agent: the device boots knowing only its MACs, takes
# a DHCP lease, follows option 67, and applies whatever the seed says it should be. The
# difference is what happens underneath -- here the Linux kernel is the data plane, so the
# rendered config becomes real bridges, real routed interfaces and real ECMP.

set -uo pipefail

export STATE_DIR=/ztp-state
export LOG_TAG=ztp-frr
# shellcheck source=../common/ztp-lib.sh
. /ztp/ztp-lib.sh

SEED_FALLBACK=${SEED_FALLBACK:-10.10.0.10}
export SYSLOG_SERVER=${SYSLOG_SERVER:-$SEED_FALLBACK}

rm -f "$STATE_DIR/ztp-complete" "$STATE_DIR/ztp-failed"
: > "$STATE_DIR/ztp.log"
: > "$STATE_DIR/installed.tsv"

log "=== ZTP start (hint: ${LAB_HINT_NAME:-unknown}, profile: frr) ==="

# ---------------------------------------------------------------- 1. cabling
wait_for_interfaces
if ! stage_interfaces; then
    fail "could not identify the management interface"
    exec sleep infinity
fi
MGMT_MAC=$(cat /sys/class/net/eth0/address)
log "management MAC $MGMT_MAC"

# ---------------------------------------------------------------- 2. DHCP
if ! run_dhcp eth0; then
    fail "no DHCP lease on eth0 -- seed unreachable or MAC not in the reservation list"
    exec sleep infinity
fi
# shellcheck disable=SC1091
. "$STATE_DIR/dhcp.env"

ZTP_URL=${DHCP_BOOTFILE:-"http://$SEED_FALLBACK:8080/ztp/ztp.json"}

# ---------------------------------------------------------------- 3. descriptor
log "fetching ZTP descriptor $ZTP_URL"
if ! fetch_ztp_descriptor "$ZTP_URL" "$MGMT_MAC" "$STATE_DIR/ztp.json"; then
    fail "could not fetch ZTP descriptor"
    exec sleep infinity
fi

HOSTNAME_ASSIGNED=$(jq -r '.hostname' "$STATE_DIR/ztp.json")
if [ -z "$HOSTNAME_ASSIGNED" ] || [ "$HOSTNAME_ASSIGNED" = "null" ]; then
    fail "seed did not recognise MAC $MGMT_MAC"
    exec sleep infinity
fi
log "seed identified this device as '$HOSTNAME_ASSIGNED'"
hostname "$HOSTNAME_ASSIGNED" 2>/dev/null
echo "$HOSTNAME_ASSIGNED" > "$STATE_DIR/hostname"
API=$(jq -r '.api' "$STATE_DIR/ztp.json")

# Name the interfaces after the cable plan's front-panel ports.
apply_link_map "$STATE_DIR/ztp.json" "@port" 0

# ---------------------------------------------------------------- 4. artifacts
count=$(jq -r '.configs | length' "$STATE_DIR/ztp.json")
log "installing $count config artifact(s)"
for i in $(seq 0 $((count - 1))); do
    url=$(jq -r ".configs[$i].url" "$STATE_DIR/ztp.json")
    dest=$(jq -r ".configs[$i].dest" "$STATE_DIR/ztp.json")
    sha=$(jq -r ".configs[$i].sha256 // \"\"" "$STATE_DIR/ztp.json")
    if ! install_artifact "$url" "$dest" "$sha"; then
        fail "failed installing $dest from $url"
        exec sleep infinity
    fi
done

CFG=/etc/aidc/fabric.json
if [ ! -f "$CFG" ]; then
    fail "seed did not deliver fabric.json"
    exec sleep infinity
fi

# ---------------------------------------------------------------- 5. data plane
# Forwarding, and a hash policy that actually looks at L4. With the default policy an AI
# fabric's handful of elephant flows hash on 3-tuple alone and pile onto one uplink --
# the exact ECMP polarisation this topology exists to avoid.
sysctl -qw net.ipv4.ip_forward=1
sysctl -qw net.ipv4.fib_multipath_hash_policy=1
sysctl -qw net.ipv6.conf.all.forwarding=1
# ARP on a router with many equal-cost paths: keep entries stable and answer only for
# addresses actually configured on the ingress interface.
sysctl -qw net.ipv4.conf.all.arp_ignore=0
sysctl -qw net.ipv4.conf.all.arp_announce=2
sysctl -qw net.ipv4.neigh.default.gc_thresh1=2048
sysctl -qw net.ipv4.neigh.default.gc_thresh2=4096
sysctl -qw net.ipv4.neigh.default.gc_thresh3=8192

MTU=$(jq -r '.mtu' "$CFG")

# Loopback: the address the fabric actually routes to, and the BGP router-id.
LOOPBACK=$(jq -r '.loopback // empty' "$CFG")
if [ -n "$LOOPBACK" ]; then
    ip addr replace "$LOOPBACK" dev lo
    log "loopback $LOOPBACK"
fi

# Rail bridge: the leaf's L2 domain for its rail, with the gateway SVI on top. This is
# what makes same-rail traffic a single switched hop.
BRIDGE=$(jq -r '.bridge.name // empty' "$CFG")
if [ -n "$BRIDGE" ]; then
    BR_IP=$(jq -r '.bridge.ip' "$CFG")
    ip link add name "$BRIDGE" type bridge 2>/dev/null
    ip link set dev "$BRIDGE" mtu "$MTU" up
    ip addr replace "$BR_IP" dev "$BRIDGE"
    log "rail bridge $BRIDGE $BR_IP mtu $MTU"
fi

nports=$(jq -r '.ports | length' "$CFG")
for i in $(seq 0 $((nports - 1))); do
    name=$(jq -r ".ports[$i].name" "$CFG")
    mode=$(jq -r ".ports[$i].mode" "$CFG")
    pmtu=$(jq -r ".ports[$i].mtu" "$CFG")

    if [ ! -e "/sys/class/net/$name" ]; then
        log "ERROR: port $name is missing -- cabling does not match the cable plan"
        continue
    fi
    ip link set dev "$name" mtu "$pmtu"

    if [ "$mode" = "routed" ]; then
        pip=$(jq -r ".ports[$i].ip" "$CFG")
        ip addr replace "$pip" dev "$name"
        ip link set dev "$name" up
        log "port $name routed $pip mtu $pmtu"
    else
        ip link set dev "$name" master "$BRIDGE"
        ip link set dev "$name" up
        log "port $name access -> $BRIDGE mtu $pmtu"
    fi
done

# ---------------------------------------------------------------- 6. routing
# Enable exactly the daemons this device needs, then let FRR read the seed's config.
cat > /etc/frr/daemons <<'EOF'
zebra=yes
bgpd=yes
staticd=yes
mgmtd=yes
vtysh_enable=yes
zebra_options="  -A 127.0.0.1 -s 90000000"
bgpd_options="   -A 127.0.0.1"
staticd_options="-A 127.0.0.1"
mgmtd_options="  -A 127.0.0.1"
EOF

# Integrated config must be declared in vtysh.conf, not only inside frr.conf. Without it
# each daemon looks for its own /etc/frr/<daemon>.conf, finds nothing, and starts empty --
# which is survivable until watchfrr restarts bgpd and the router comes back with no BGP
# configuration at all and no error anywhere.
echo 'service integrated-vtysh-config' > /etc/frr/vtysh.conf
chown frr:frr /etc/frr/frr.conf /etc/frr/vtysh.conf /etc/frr/daemons 2>/dev/null
chmod 640 /etc/frr/frr.conf /etc/frr/vtysh.conf 2>/dev/null

log "starting FRR"
/usr/lib/frr/frrinit.sh start >> "$STATE_DIR/ztp.log" 2>&1
sleep 6

if [ -f /etc/frr/frr.conf ]; then
    # frrinit.sh already loaded frr.conf; re-applying is idempotent and covers the case
    # where a daemon came up after the initial read.
    vtysh -f /etc/frr/frr.conf >> "$STATE_DIR/ztp.log" 2>&1 || \
        log "WARNING: vtysh rejected part of frr.conf"
    # Persist in integrated format so a daemon restart reloads the same configuration.
    vtysh -w >> "$STATE_DIR/ztp.log" 2>&1
    asn=$(vtysh -c 'show run' 2>/dev/null | sed -n 's/^router bgp \([0-9]*\).*/\1/p' | head -1)
    if [ -n "$asn" ]; then
        log "BGP configured: AS $asn"
    else
        fail "FRR started but no BGP configuration is present"
    fi
fi

# ---------------------------------------------------------------- 7. LLDP
log "starting LLDP"
mkdir -p /var/run/lldpd
PORTS=$(jq -r '.ports[].name' "$CFG" | paste -sd, -)
lldpd -c -s -e -I "$PORTS" >> "$STATE_DIR/lldpd.log" 2>&1 &
sleep 3
lldpcli configure system hostname "$HOSTNAME_ASSIGNED" >/dev/null 2>&1
for p in $(jq -r '.ports[].name' "$CFG"); do
    # Interfaces are already named after the cable plan, so the advertised port id is
    # simply the interface name.
    lldpcli configure ports "$p" lldp portidsubtype local "$p" >/dev/null 2>&1
    lldpcli configure ports "$p" lldp portdescription "$p" >/dev/null 2>&1
done

# ---------------------------------------------------------------- 8. register
register_with_seed "$API" "$(jq -n \
    --arg host "$HOSTNAME_ASSIGNED" \
    --arg mac "$MGMT_MAC" \
    --arg ip "$DHCP_IP" \
    '{hostname:$host, mac:$mac, ip:$ip, role:"switch", profile:"frr", status:"provisioned"}')"

log "=== ZTP complete: $HOSTNAME_ASSIGNED provisioned from seed ==="
date -u +%FT%TZ > "$STATE_DIR/ztp-complete"

exec sleep infinity
