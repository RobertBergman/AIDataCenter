#!/bin/sh
# busybox udhcpc lease handler.
#
# Applies the lease and records what the server told us. Option 67 (boot file) is the
# ZTP hook: it names the descriptor this device must fetch to learn its identity.

STATE_DIR=${STATE_DIR:-/ztp-state}
mkdir -p "$STATE_DIR"

case "$1" in
    deconfig)
        ip addr flush dev "$interface" 2>/dev/null
        ip link set dev "$interface" up
        ;;

    leasefail | nak)
        echo "udhcpc: $1 on $interface" >> "$STATE_DIR/dhcp.log"
        ;;

    renew | bound)
        ip addr flush dev "$interface"
        ip addr add "$ip/${mask:-24}" dev "$interface"
        ip link set dev "$interface" up

        if [ -n "$router" ]; then
            # Keep the OOB default route pointed at the management gateway.
            ip route del default 2>/dev/null
            for r in $router; do
                ip route add default via "$r" dev "$interface" 2>/dev/null
                break
            done
        fi

        if [ -n "$dns" ]; then
            : > /etc/resolv.conf.ztp
            for d in $dns; do echo "nameserver $d" >> /etc/resolv.conf.ztp; done
            # Docker's embedded resolver stays primary; the seed's DNS is appended.
            cat /etc/resolv.conf.ztp >> /etc/resolv.conf 2>/dev/null || true
        fi

        {
            echo "DHCP_IP=$ip"
            echo "DHCP_MASK=${mask:-24}"
            echo "DHCP_ROUTER=$router"
            echo "DHCP_SERVER=$serverid"
            echo "DHCP_DNS=$dns"
            echo "DHCP_DOMAIN=$domain"
            echo "DHCP_HOSTNAME=$hostname"
            # busybox exposes option 67 / the BOOTP file field as $boot_file
            echo "DHCP_BOOTFILE=$boot_file"
            echo "DHCP_LEASE=$lease"
        } > "$STATE_DIR/dhcp.env"
        ;;
esac
exit 0
