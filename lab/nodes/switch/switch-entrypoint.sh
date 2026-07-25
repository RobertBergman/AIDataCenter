#!/bin/bash
# Zero-touch provisioning agent for a sonic-vs fabric switch.
#
# The device boots knowing nothing but its own MAC addresses. Everything else -- its
# hostname, its port layout, its addressing, its BGP configuration, its QoS policy --
# arrives from the seed node over DHCP and HTTP.
#
# Ordering is not negotiable:
#   1. every cable attached and named       (sonic-vs derives its front-panel port list
#   2. config in place                       from the interfaces present at start.sh time,
#   3. only then start the NOS               and reads config_db.json once, at startup)

set -uo pipefail

export STATE_DIR=/ztp-state
export LOG_TAG=ztp-switch
# shellcheck source=ztp-lib.sh
. /ztp/ztp-lib.sh

SEED_FALLBACK=${SEED_FALLBACK:-10.10.0.10}
export SYSLOG_SERVER=${SYSLOG_SERVER:-$SEED_FALLBACK}

rm -f "$STATE_DIR/ztp-complete" "$STATE_DIR/ztp-failed"
: > "$STATE_DIR/ztp.log"

log "=== ZTP start (hint: ${LAB_HINT_NAME:-unknown}) ==="

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
    log "holding container up for diagnosis"
    exec sleep infinity
fi
# shellcheck disable=SC1091
. "$STATE_DIR/dhcp.env"

ZTP_URL=${DHCP_BOOTFILE:-}
if [ -z "$ZTP_URL" ]; then
    log "no DHCP option 67; falling back to http://$SEED_FALLBACK:8080/ztp/ztp.json"
    ZTP_URL="http://$SEED_FALLBACK:8080/ztp/ztp.json"
fi

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
echo "$HOSTNAME_ASSIGNED" > /etc/hostname
echo "$HOSTNAME_ASSIGNED" > "$STATE_DIR/hostname"

API=$(jq -r '.api' "$STATE_DIR/ztp.json")

# ------------------------------------------------- 3b. port layout from the seed
# Must happen before SONiC starts: start.sh derives the front-panel port list from the
# ethN interfaces that exist at that moment.
apply_link_map "$STATE_DIR/ztp.json" "eth" 1

# sonic-vs binds container interface N to front-panel port Ethernet(4*(N-1)).
declare -A PORT_OF
for ifc in /sys/class/net/eth*; do
    ifc=$(basename "$ifc")
    [ "$ifc" = "eth0" ] && continue
    n=${ifc#eth}
    PORT_OF[$ifc]="Ethernet$(( 4 * (n - 1) ))"
done
log "front-panel map: $(for k in $(printf '%s\n' "${!PORT_OF[@]}" | sort -V); do echo -n "$k->${PORT_OF[$k]} "; done)"

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

# The platform's control-plane policing defaults ship with the NOS image, not with the
# golden config -- on real SONiC the swss container loads them alongside config_db.json.
# Without them the ASIC installs no IP2ME trap, so the switch answers ARP but silently
# ignores every packet addressed to itself: no ping, no BGP, no management. Merge them in
# before startup so CONFIG_DB is complete the first time orchagent reads it.
if [ -f /etc/sonic/copp_cfg.json ]; then
    if jq -s '.[0] * .[1]' /etc/sonic/config_db.json /etc/sonic/copp_cfg.json > /tmp/cdb.merged 2>/dev/null; then
        mv /tmp/cdb.merged /etc/sonic/config_db.json
        log "merged platform CoPP defaults into config_db"
    else
        log "WARNING: could not merge copp_cfg.json"
    fi
fi

# ---------------------------------------------------------------- 5. start NOS
log "starting SONiC (supervisord)"
/usr/local/bin/supervisord > /var/log/supervisord.boot.log 2>&1 &

log "waiting for the virtual ASIC to program the front-panel ports"
sonic_ready=0
for _ in $(seq 1 90); do
    sleep 5
    if redis-cli -n 6 keys 'PORT_TABLE|Ethernet0' 2>/dev/null | grep -q Ethernet0; then
        sonic_ready=1
        break
    fi
done
if [ "$sonic_ready" -ne 1 ]; then
    fail "SONiC did not reach a ready state"
    exec sleep infinity
fi
log "SONiC up: $(redis-cli -n 6 keys 'PORT_TABLE|Ethernet*' 2>/dev/null | wc -l) ports in STATE_DB"

# Give intfmgrd a moment to program the L3 addresses out of CONFIG_DB.
sleep 5

# libsaivs returns SAI_STATUS_FAILURE when a next-hop is removed, and orchagent responds
# by aborting syncd -- so ordinary neighbour ageing can take the virtual ASIC down. Real
# hardware has no such bug. Holding neighbour entries for far longer keeps the emulator
# stable for the length of a lab session; it is a workaround for the simulator, not a
# fabric setting anyone should copy.
sysctl -qw net.ipv4.neigh.default.base_reachable_time_ms=1800000 2>/dev/null
sysctl -qw net.ipv4.neigh.default.gc_stale_time=1800000 2>/dev/null
sysctl -qw net.ipv4.neigh.default.gc_thresh1=2048 2>/dev/null
sysctl -qw net.ipv4.neigh.default.gc_thresh2=4096 2>/dev/null
sysctl -qw net.ipv4.neigh.default.gc_thresh3=8192 2>/dev/null

# ---------------------------------------------------------------- 6. routing
# This image ships no bgpcfgd, so CONFIG_DB is never translated into FRR config.
# The seed renders frr.conf directly and it is applied here.
if [ -f /etc/frr/frr.conf ]; then
    log "applying BGP configuration"
    supervisorctl start bgpd  >/dev/null 2>&1
    supervisorctl start zebra >/dev/null 2>&1
    sleep 3
    if vtysh -f /etc/frr/frr.conf >> "$STATE_DIR/ztp.log" 2>&1; then
        vtysh -c 'write memory' >/dev/null 2>&1
        log "BGP configured: AS $(vtysh -c 'show bgp summary json' 2>/dev/null | jq -r '.ipv4Unicast.as // "?"')"
    else
        log "WARNING: vtysh rejected part of frr.conf -- see ztp.log"
    fi
fi

# ---------------------------------------------------------------- 7. LLDP
# LLDP runs on the container-side link interfaces (the actual cable) and advertises the
# front-panel port name, so discovered neighbours can be diffed against the cable plan.
log "starting LLDP"
mkdir -p /var/run/lldpd
# Bind lldpd to the cable-side interfaces only. If it also listened on the ASIC's
# Ethernet* tap devices it would receive its own frames back through the virtual switch
# and report the device as its own neighbour.
LLDP_IFACES=$(printf '%s\n' "${!PORT_OF[@]}" | sort -V | paste -sd, -)
lldpd -c -s -e -I "$LLDP_IFACES" >> "$STATE_DIR/lldpd.log" 2>&1 &
sleep 3
lldpcli configure system hostname "$HOSTNAME_ASSIGNED" >/dev/null 2>&1
for ifc in "${!PORT_OF[@]}"; do
    lldpcli configure ports "$ifc" lldp portidsubtype local "${PORT_OF[$ifc]}" >/dev/null 2>&1
    lldpcli configure ports "$ifc" lldp portdescription "${PORT_OF[$ifc]}" >/dev/null 2>&1
done

# ---------------------------------------------------------------- 8. register
register_with_seed "$API" "$(jq -n \
    --arg host "$HOSTNAME_ASSIGNED" \
    --arg mac "$MGMT_MAC" \
    --arg ip "$DHCP_IP" \
    --arg role switch \
    '{hostname:$host, mac:$mac, ip:$ip, role:$role, status:"provisioned"}')"

log "=== ZTP complete: $HOSTNAME_ASSIGNED provisioned from seed ==="
date -u +%FT%TZ > "$STATE_DIR/ztp-complete"

# PID 1 must stay alive; SONiC's daemons run under the supervisord started above.
exec sleep infinity
