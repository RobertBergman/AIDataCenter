# Shared ZTP helpers for switch and compute nodes.
# shellcheck shell=bash

STATE_DIR=${STATE_DIR:-/ztp-state}
LOG_TAG=${LOG_TAG:-ztp}

mkdir -p "$STATE_DIR"

log() {
    local msg="[$(date -u +%H:%M:%S)] $*"
    echo "$msg"
    echo "$msg" >> "$STATE_DIR/ztp.log"
    # Best effort: the seed's syslog collector may not be up yet during early boot.
    if [ -n "${SYSLOG_SERVER:-}" ]; then
        printf '<134>%s %s %s\n' "$(date '+%b %e %H:%M:%S')" "$(hostname)" "$LOG_TAG: $*" \
            > /dev/udp/"$SYSLOG_SERVER"/514 2>/dev/null || true
    fi
}

fail() {
    log "ZTP FAILED: $*"
    echo "$*" > "$STATE_DIR/ztp-failed"
    return 1
}

# Wait until the interface count has been stable for a couple of seconds. Docker attaches
# each network as a separate operation; starting the NOS mid-attach would make it derive
# the wrong front-panel port list.
wait_for_interfaces() {
    local expected=${1:-0} stable=0 last=-1 count
    for _ in $(seq 1 60); do
        count=$(find /sys/class/net -maxdepth 1 -name 'eth*' -o -maxdepth 1 -name 'ztptmp*' | wc -l)
        if [ "$count" -eq "$last" ] && [ "$count" -gt 0 ]; then
            stable=$((stable + 1))
            [ "$stable" -ge 2 ] && break
        else
            stable=0
        fi
        last=$count
        sleep 1
    done
    log "interfaces settled: $count present (expected ${expected:-any})"
}

# --- interface identification -------------------------------------------------
#
# Docker names container interfaces in whatever order it happens to attach the networks;
# `priority` in compose does not reliably determine it. The NOS, however, cares deeply:
# sonic-vs binds container interface N to front-panel port Ethernet(4*(N-1)), so an
# arbitrary order silently produces a switch whose ports are cabled to the wrong things.
#
# Each cable in the plan is its own Docker network on its own 172.30.<n>.0/24, so the
# address Docker assigns identifies which cable an interface is. That is the stable handle
# used to put interfaces into their intended order.
#
# The management port is identified by its MAC, which is the one MAC the topology assigns.
# Fabric links deliberately get none: assigning a MAC makes Docker pin a static FDB entry
# and stop learning on that bridge port, and since a router sources every frame from a
# single system MAC, every frame would then be unknown unicast and be dropped.

# Phase 1 -- move every interface to a stable temporary name, keyed by its cable.
stage_interfaces() {
    local ifc mac addr octet

    : > "$STATE_DIR/link-map.txt"

    for ifc in $(ls /sys/class/net); do
        [ "$ifc" = "lo" ] && continue
        mac=$(cat "/sys/class/net/$ifc/address" 2>/dev/null) || continue
        case "$mac" in
            02:aa:00:00:00:*)
                ip link set dev "$ifc" down 2>/dev/null
                ip link set dev "$ifc" name ztpmgmt 2>/dev/null
                ;;
            *)
                addr=$(ip -4 -o addr show dev "$ifc" 2>/dev/null | awk '{print $4}' | head -1)
                octet=$(echo "$addr" | cut -d. -f3)
                if [ -z "$octet" ]; then
                    log "WARNING: $ifc has no address and cannot be matched to a cable"
                    continue
                fi
                echo "$octet $mac $addr" >> "$STATE_DIR/link-map.txt"
                ip addr flush dev "$ifc" 2>/dev/null
                ip link set dev "$ifc" down 2>/dev/null
                ip link set dev "$ifc" name "ztpc$octet" 2>/dev/null
                ;;
        esac
    done

    if [ -e /sys/class/net/ztpmgmt ]; then
        ip link set dev ztpmgmt name eth0 2>/dev/null
        ip link set dev eth0 up
    else
        log "ERROR: no management interface found (expected MAC 02:aa:00:00:00:xx)"
        return 1
    fi
    log "staged $(wc -l < "$STATE_DIR/link-map.txt") cable interface(s); management port is eth0"
}

# Phase 2 -- rename each staged cable to the name the cable plan gives it. The mapping
# arrives from the seed in the ZTP descriptor: the device does not decide its own port
# layout any more than it decides its own IP address.
#
#   apply_link_map <descriptor.json> <prefix> <base>
#     sonic switches: apply_link_map ztp.json eth   1  -> eth1..ethN
#     compute nodes:  apply_link_map ztp.json rail  0  -> rail0..railN-1
#     frr switches:   apply_link_map ztp.json @port 0  -> the cable plan's port names
#
# The @port form names interfaces Ethernet0, Ethernet4, ... directly. sonic-vs cannot do
# that -- it insists on deriving front-panel ports from ethN -- but a Linux router has no
# such constraint, so the same cable plan reads identically on both profiles.
apply_link_map() {
    local desc=$1 prefix=$2 base=$3
    local octet idx target staged

    for octet in $(jq -r '.link_map | keys[]' "$desc" 2>/dev/null); do
        idx=$(jq -r ".link_map[\"$octet\"].ifindex" "$desc")
        staged="ztpc$octet"
        if [ "$prefix" = "@port" ]; then
            target=$(jq -r ".link_map[\"$octet\"].port" "$desc")
        else
            target="${prefix}$((idx - 1 + base))"
        fi
        if [ ! -e "/sys/class/net/$staged" ]; then
            log "ERROR: cable on subnet 172.30.$octet.0/24 is missing -- topology does not match the cable plan"
            continue
        fi
        ip link set dev "$staged" name "$target" 2>/dev/null
        ip link set dev "$target" up
        log "interface $target <- cable 172.30.$octet.0/24 ($(jq -r ".link_map[\"$octet\"].port" "$desc"))"
    done

    for staged in /sys/class/net/ztpc*; do
        [ -e "$staged" ] || continue
        log "WARNING: $(basename "$staged") is cabled but not in the cable plan -- unexpected link"
    done
}

# Real DHCP: DISCOVER/OFFER/REQUEST/ACK against the seed's dnsmasq. The lease supplies the
# management address and, in option 67, the URL of this device's ZTP descriptor.
run_dhcp() {
    local iface=${1:-eth0} tries=${2:-6}
    rm -f "$STATE_DIR/dhcp.env"
    ip addr flush dev "$iface"
    ip link set dev "$iface" up

    for attempt in $(seq 1 "$tries"); do
        log "DHCP DISCOVER on $iface (attempt $attempt/$tries)"
        if udhcpc -i "$iface" -n -q -t 5 -T 3 -f -s /ztp/udhcpc-handler.sh >>"$STATE_DIR/dhcp.log" 2>&1; then
            if [ -f "$STATE_DIR/dhcp.env" ]; then
                # shellcheck disable=SC1091
                . "$STATE_DIR/dhcp.env"
                log "DHCP lease: ip=$DHCP_IP router=$DHCP_ROUTER option67=$DHCP_BOOTFILE"
                return 0
            fi
        fi
        sleep 3
    done
    return 1
}

# Fetch the ZTP descriptor named by DHCP option 67, then pull down every artifact it lists
# and verify each against the digest the seed published.
fetch_ztp_descriptor() {
    local url=$1 mac=$2 out=$3
    curl -fsS --retry 10 --retry-delay 3 --retry-connrefused \
         -H "X-Device-MAC: $mac" \
         "${url}?mac=${mac}" -o "$out"
}

install_artifact() {
    local url=$1 dest=$2 want_sha=$3 tmp
    # Not mktemp: the FRR image's busybox does not ship it, and a predictable path here
    # is easier to inspect after a failed provisioning run anyway.
    tmp="$STATE_DIR/.fetch.$$.$(basename "$dest")"
    if ! curl -fsS --retry 5 --retry-delay 2 "$url" -o "$tmp"; then
        log "fetch failed: $url"
        rm -f "$tmp"
        return 1
    fi
    local got_sha
    got_sha=$(sha256sum "$tmp" | awk '{print $1}')
    if [ -n "$want_sha" ] && [ "$got_sha" != "$want_sha" ]; then
        log "digest mismatch for $dest: expected $want_sha got $got_sha"
        rm -f "$tmp"
        return 1
    fi
    mkdir -p "$(dirname "$dest")"
    mv "$tmp" "$dest"
    chmod 644 "$dest"
    # Record what was installed and with which digest. The files themselves get rewritten
    # in place afterwards -- `vtysh write memory` reformats frr.conf, and the platform's
    # CoPP defaults are merged into config_db.json -- so this ledger, not a later checksum
    # of the file, is the evidence that what the seed served is what arrived.
    echo "$dest	$got_sha	$url" >> "$STATE_DIR/installed.tsv"
    log "installed $dest (sha256 ${got_sha:0:12})"
}

register_with_seed() {
    local api=$1 payload=$2
    curl -fsS -X POST -H 'Content-Type: application/json' \
        --retry 5 --retry-delay 2 \
        -d "$payload" "$api/register" >/dev/null 2>&1 || true
}
