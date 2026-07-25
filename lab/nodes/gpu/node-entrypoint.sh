#!/bin/bash
# Zero-touch provisioning agent for a GPU compute node.
#
# Same contract as the switches: the node boots knowing only its MACs, takes a DHCP lease
# on the OOB network, fetches the descriptor named in option 67, and applies whatever the
# seed says it should be. Rail addressing in particular is never local knowledge -- NIC k
# belongs on rail k, and only the source of truth knows which is which.

set -uo pipefail

export STATE_DIR=/ztp-state
export LOG_TAG=ztp-node
# shellcheck source=../common/ztp-lib.sh
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
    fail "no DHCP lease on eth0"
    exec sleep infinity
fi
# shellcheck disable=SC1091
. "$STATE_DIR/dhcp.env"

ZTP_URL=${DHCP_BOOTFILE:-"http://$SEED_FALLBACK:8080/ztp/ztp.json"}

# Exercise the seed's TFTP/iPXE path. A container cannot PXE boot, but on real hardware
# this is the file that would have started the install, and it must be served correctly.
if busybox tftp -g -r ipxe/boot.ipxe -l "$STATE_DIR/boot.ipxe" "${DHCP_SERVER:-$SEED_FALLBACK}" 2>/dev/null; then
    log "TFTP OK: retrieved ipxe/boot.ipxe ($(wc -c < "$STATE_DIR/boot.ipxe") bytes)"
else
    log "WARNING: TFTP fetch of ipxe/boot.ipxe failed"
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
log "seed identified this node as '$HOSTNAME_ASSIGNED'"
hostname "$HOSTNAME_ASSIGNED" 2>/dev/null
echo "$HOSTNAME_ASSIGNED" > "$STATE_DIR/hostname"

API=$(jq -r '.api' "$STATE_DIR/ztp.json")

# Which NIC is on which rail is assigned by the source of truth, never guessed locally --
# a node that decides its own rail mapping is a node that can be silently wrong about it.
apply_link_map "$STATE_DIR/ztp.json" "rail" 0
log "rails present: $(ls -d /sys/class/net/rail* 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"

count=$(jq -r '.configs | length' "$STATE_DIR/ztp.json")
for i in $(seq 0 $((count - 1))); do
    url=$(jq -r ".configs[$i].url" "$STATE_DIR/ztp.json")
    dest=$(jq -r ".configs[$i].dest" "$STATE_DIR/ztp.json")
    sha=$(jq -r ".configs[$i].sha256 // \"\"" "$STATE_DIR/ztp.json")
    if ! install_artifact "$url" "$dest" "$sha"; then
        fail "failed installing $dest"
        exec sleep infinity
    fi
done

NODE_CFG=/etc/aidc/node.json

# ---------------------------------------------------------------- 4. rails
# Each rail interface gets its address, its jumbo MTU, and a route to every other rail
# via its own leaf. Getting the MTU wrong here is the classic silent killer: the fabric
# stays up and every large transfer fragments.
nrails=$(jq -r '.rails | length' "$NODE_CFG")
log "configuring $nrails rail interface(s)"

for i in $(seq 0 $((nrails - 1))); do
    ifc=$(jq -r ".rails[$i].interface" "$NODE_CFG")
    addr=$(jq -r ".rails[$i].address" "$NODE_CFG")
    gw=$(jq -r ".rails[$i].gateway" "$NODE_CFG")
    mtu=$(jq -r ".rails[$i].mtu" "$NODE_CFG")
    rail=$(jq -r ".rails[$i].rail" "$NODE_CFG")
    leaf=$(jq -r ".rails[$i].leaf" "$NODE_CFG")

    if [ ! -e "/sys/class/net/$ifc" ]; then
        log "ERROR: $ifc does not exist -- cabling does not match the source of truth"
        continue
    fi

    ip addr flush dev "$ifc"
    ip link set dev "$ifc" mtu "$mtu" up
    ip addr add "$addr" dev "$ifc"
    log "rail$rail: $ifc $addr mtu $mtu -> $leaf (gw $gw)"
done

# Reach other rails' subnets through this node's gateway on the matching rail.
for i in $(seq 0 $((nrails - 1))); do
    ifc=$(jq -r ".rails[$i].interface" "$NODE_CFG")
    gw=$(jq -r ".rails[$i].gateway" "$NODE_CFG")
    rail=$(jq -r ".rails[$i].rail" "$NODE_CFG")
    # A node's own rail-k NIC is the exit for traffic destined to rail k elsewhere.
    prefix=$(jq -r ".rail_prefixes[\"$rail\"]" "$NODE_CFG")
    ip route replace "$prefix" dev "$ifc" 2>/dev/null
    # Loopbacks (and anything else in the fabric) are reachable via any rail gateway.
    ip route add 10.0.0.0/16 via "$gw" dev "$ifc" 2>/dev/null
done

# ---------------------------------------------------------------- 5. LLDP
log "starting LLDP on rail interfaces"
mkdir -p /var/run/lldpd
lldpd -c -s -e >> "$STATE_DIR/lldpd.log" 2>&1 &
sleep 3
lldpcli configure system hostname "$HOSTNAME_ASSIGNED" >/dev/null 2>&1
for i in $(seq 0 $((nrails - 1))); do
    ifc=$(jq -r ".rails[$i].interface" "$NODE_CFG")
    lldpcli configure ports "$ifc" lldp portidsubtype local "$ifc" >/dev/null 2>&1
    lldpcli configure ports "$ifc" lldp portdescription "$ifc" >/dev/null 2>&1
done

# ---------------------------------------------------------------- 6. telemetry
log "starting node exporter on :9200"
NODE_CFG=$NODE_CFG python3 -u /ztp/node-exporter.py >> "$STATE_DIR/exporter.log" 2>&1 &

# A traffic sink, so throughput between nodes can be measured rather than asserted.
# Stands in for the ib_write_bw / nccl-tests baselines a real pre/post check would run.
if command -v iperf3 >/dev/null 2>&1; then
    iperf3 --server --daemon --port 5201 >> "$STATE_DIR/iperf3.log" 2>&1 || true
    log "iperf3 server listening on :5201"
fi

# ---------------------------------------------------------------- 7. register
register_with_seed "$API" "$(jq -n \
    --arg host "$HOSTNAME_ASSIGNED" \
    --arg mac "$MGMT_MAC" \
    --arg ip "$DHCP_IP" \
    --argjson rails "$(jq -c '[.rails[] | {rail, interface, address, leaf}]' "$NODE_CFG")" \
    '{hostname:$host, mac:$mac, ip:$ip, role:"gpu_node", status:"provisioned", rails:$rails}')"

log "=== ZTP complete: $HOSTNAME_ASSIGNED provisioned from seed ==="
date -u +%FT%TZ > "$STATE_DIR/ztp-complete"

exec sleep infinity
