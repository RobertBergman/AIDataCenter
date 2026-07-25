#!/bin/sh
# Make Docker's bridges behave like cables.
#
# POSIX equivalent of Initialize-LabBridges in lab.ps1, for driving the lab from a shell
# instead of PowerShell. Run it after `docker compose up`; Docker recreates the bridges on
# every `down`, and neither setting survives that.
#
# Must run with access to the Docker host's sysfs. On Docker Desktop:
#
#   AIDC_BRIDGES=$(for n in $(docker network ls --filter name=aidc- --format '{{.Name}}'); do
#       id=$(docker network inspect "$n" --format '{{.Id}}'); echo "br-${id%${id#????????????}}";
#   done | tr '\n' ' ')
#   docker run --rm --privileged --network host -v /sys:/hostsys \
#       -e AIDC_BRIDGES="$AIDC_BRIDGES" alpine:3.20 sh -s < scripts/prepare-bridges.sh
#
# ---------------------------------------------------------------------------
# group_fwd_mask bit 14 (0x4000)
#   LLDP is addressed to 01:80:c2:00:00:0e, inside the 802.1D reserved range that a Linux
#   bridge is required to consume rather than forward. Without this the neighbour tables
#   stay empty and cabling validation cannot work at all.
#
# hairpin_mode 0
#   Docker Desktop enables hairpin on veth ports, which reflects a frame back to the
#   sender. A switch that bridges between its ports then receives its own flooded frames
#   and floods them again -- a broadcast storm that saturates the fabric within seconds
#   and starves BGP until every session drops. Harmless for ordinary containers, fatal for
#   anything doing L2 forwarding, and nothing warns you.
# ---------------------------------------------------------------------------

set -e

SYS=${SYS:-/hostsys}
MASK=${MASK:-0x4000}
lldp=0
hairpin=0

for dev in ${AIDC_BRIDGES:-}; do
    m="$SYS/class/net/$dev/bridge/group_fwd_mask"
    if [ -e "$m" ] && echo "$MASK" > "$m" 2>/dev/null; then
        lldp=$((lldp + 1))
    fi
    for p in "$SYS/class/net/$dev/brif/"*; do
        [ -e "$p/hairpin_mode" ] || continue
        echo 0 > "$p/hairpin_mode" 2>/dev/null && hairpin=$((hairpin + 1))
    done
done

if [ "$lldp" -eq 0 ] && [ "$hairpin" -eq 0 ]; then
    echo "no lab bridges found -- is AIDC_BRIDGES set and $SYS mounted?" >&2
    exit 1
fi

echo "LLDP forwarding enabled on $lldp bridge(s); hairpin disabled on $hairpin port(s)"
