#!/bin/sh
# Let LLDP cross the lab's Docker bridges.
#
# LLDP is addressed to 01:80:c2:00:00:0e, which sits in the 802.1D reserved range that a
# Linux bridge is required to consume rather than forward. On real hardware the cable is a
# cable and LLDP simply arrives; here every "cable" is a bridge, so without this the
# neighbour tables stay empty and cabling validation cannot work.
#
# group_fwd_mask bit 14 (0x4000) permits forwarding of ...:0e specifically.
#
# Run after `docker compose up`; Docker recreates the bridges on every `down`, and the
# setting does not survive that.

set -e

MASK=${MASK:-0x4000}
count=0

for path in /sys/class/net/br-*/bridge/group_fwd_mask; do
    [ -e "$path" ] || continue
    dev=$(echo "$path" | cut -d/ -f5)
    # Only touch bridges backing this lab's networks.
    if [ -n "$AIDC_BRIDGES" ]; then
        case " $AIDC_BRIDGES " in
            *" $dev "*) ;;
            *) continue ;;
        esac
    fi
    echo "$MASK" > "$path" 2>/dev/null || continue
    count=$((count + 1))
done

echo "group_fwd_mask=$MASK set on $count bridge(s)"
