"""Render the seed node's service configuration from the source of truth.

DHCP reservations, DNS records and the boot artifacts are all derived data. A device
that shows up with a MAC nobody wrote down gets a lease from the dynamic pool instead
of its identity -- which is exactly the signal you want on a management network.
"""

from __future__ import annotations

import ipaddress
from pathlib import Path

import sotlib as sot

LAB = Path(__file__).resolve().parent.parent
GEN = LAB / "seed" / "generated"

OOB = sot.IPAM["oob_management"]
SEED_IP = OOB["seed"]
DOMAIN = "pod1.lab"


def dnsmasq_conf() -> str:
    lines = [
        "# GENERATED -- rendered by tools/gen_seed.py from sot/*.yml",
        "",
        "# ---- DNS ----------------------------------------------------------------",
        f"domain={DOMAIN}",
        "expand-hosts",
        "bogus-priv",
        "domain-needed",
        "no-resolv",
        "no-hosts",
        f"addn-hosts=/etc/dnsmasq/hosts",
        "",
        "# ---- DHCP ---------------------------------------------------------------",
        "interface=eth0",
        "bind-interfaces",
        "dhcp-authoritative",
        "log-dhcp",
        "",
        "# Anything without a reservation lands here. A device in this range is a device",
        "# that is not in the source of truth -- treat it as an alarm, not a success.",
        f"dhcp-range={OOB['dynamic_range']['start']},{OOB['dynamic_range']['end']},1h",
        "",
        f"dhcp-option=option:router,{OOB['gateway']}",
        f"dhcp-option=option:dns-server,{SEED_IP}",
        f"dhcp-option=option:ntp-server,{SEED_IP}",
        f"dhcp-option=option:domain-name,{DOMAIN}",
        "",
        "# A real OOB network carries two kinds of client, and they need different answers.",
        "# Firmware PXE clients announce themselves with vendor class 'PXEClient' and want a",
        "# boot file to chainload. Devices that already have an OS -- a switch running its NOS,",
        "# a node that is already installed -- want option 67 to name their ZTP descriptor.",
        "# Setting dhcp-boot unconditionally would overwrite option 67 for everyone, because",
        "# both land in the same BOOTP 'file' field.",
        "dhcp-vendorclass=set:pxe,PXEClient",
        "",
        "# ---- TFTP (iPXE chain for bare-metal installs) ---------------------------",
        "enable-tftp",
        "tftp-root=/tftpboot",
        f"dhcp-boot=tag:pxe,ipxe/boot.ipxe,seed,{SEED_IP}",
        "",
        "# The zero-touch hook: names the descriptor a booting device fetches to discover",
        "# who it is and what config it should be running.",
        f'dhcp-option=tag:!pxe,67,"http://{SEED_IP}:8080/ztp/ztp.json"',
        "",
        "# ---- Reservations from the source of truth -------------------------------",
    ]

    for dev in sorted(sot.DEVICES.values(), key=lambda d: d.mgmt_ip):
        lines.append(
            f"dhcp-host={dev.mgmt_mac},{dev.mgmt_addr},{dev.name},12h  # {dev.role}"
        )

    lines.append("")
    return "\n".join(lines)


def hosts_file() -> str:
    lines = [
        "# GENERATED -- forward/reverse DNS for the OOB management network",
        f"{SEED_IP}\tseed seed.{DOMAIN}",
    ]
    for dev in sorted(sot.DEVICES.values(), key=lambda d: d.name):
        lines.append(f"{dev.mgmt_addr}\t{dev.name} {dev.name}.{DOMAIN}")
    # Loopbacks are the addresses the fabric actually routes to.
    for dev in sorted(sot.DEVICES.values(), key=lambda d: d.name):
        if dev.loopback_addr:
            lines.append(f"{dev.loopback_addr}\t{dev.name}-lo {dev.name}-lo.{DOMAIN}")
    lines.append("")
    return "\n".join(lines)


def boot_ipxe() -> str:
    """The chainload script a real bare-metal node would pull over TFTP.

    Containers cannot PXE boot, so this is not what provisions the lab's nodes -- but it
    is served, and the node agents fetch it over TFTP to prove that leg of the seed
    works. On real hardware this is where the OS install begins.
    """
    return f"""#!ipxe
# GENERATED -- rendered by tools/gen_seed.py
#
# Chainloaded by a bare-metal node after DHCP. On this lab's container nodes the OS is
# already present, so the agents fetch this file only to verify the TFTP path is live.

echo AI datacenter seed :: {DOMAIN}
echo MAC ${{net0/mac}}  IP ${{net0/ip}}

set base http://{SEED_IP}:8080
kernel ${{base}}/images/vmlinuz initrd=initrd.img \\
    ip=dhcp \\
    url=${{base}}/images/node.squashfs \\
    ztp=${{base}}/ztp/ztp.json
initrd ${{base}}/images/initrd.img
boot
"""


def main() -> None:
    GEN.mkdir(parents=True, exist_ok=True)
    (GEN / "dnsmasq.conf").write_text(dnsmasq_conf(), encoding="utf-8", newline="\n")
    (GEN / "hosts").write_text(hosts_file(), encoding="utf-8", newline="\n")

    tftp = LAB / "seed" / "tftpboot" / "ipxe"
    tftp.mkdir(parents=True, exist_ok=True)
    (tftp / "boot.ipxe").write_text(boot_ipxe(), encoding="utf-8", newline="\n")

    n = len(sot.DEVICES)
    print(f"wrote {GEN / 'dnsmasq.conf'} ({n} DHCP reservations)")
    print(f"wrote {GEN / 'hosts'}")
    print(f"wrote {tftp / 'boot.ipxe'}")


if __name__ == "__main__":
    main()
