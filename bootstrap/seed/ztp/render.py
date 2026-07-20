#!/usr/bin/env python3
"""Render Arista ZTP startup-configs for all 12 switches from NetBox seed data.

Single source of truth: bootstrap/netbox/seed/site.yaml (devices, cabling,
IPAM). Output: one file per switch SERIAL (ztp.py fetches configs/<serial>).

    python3 bootstrap/seed/ztp/render.py -o bootstrap/seed/generated/ztp

Serial mapping: bootstrap/seed/ztp/serialmap.yaml (copy serialmap.example.yaml
and fill in real serials at staging — build-guide §5). Until then,
placeholder serials (SERIAL-OOB-SW1 …) are used.

Design: docs/network.md (ZTP §3, OOB §4, underlay §5, RoCEv2 profile §6)
and docs/overlay.md (EVPN/VXLAN overlay: VTEPs, vrf storage/edge, border).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "netbox" / "scripts"))
from nb_lib import all_cables, load_seed  # noqa: E402

EOS_IMAGE = None  # e.g. ("EOS-4.33.1F.swi", "<sha512>") → emits !IMAGE: marker

SEED_IP = "10.10.0.10"
DOMAIN = "ai.local"

SPINE_ASN = 65000
LEAF_ASN_BASE = 65100  # leaf-rail{i} → 65100+i+1

# 10.30.0.0/16 underlay plan (seed ipam) --------------------------------
# loopbacks:  spine{n} 10.30.0.{n}  ·  leaf-rail{i} 10.30.0.{11+i}
# p2p /31:    leaf-rail{i} u→spine1 (u even): 10.30.{2i+1}.{2*(u//2)}/31
#             leaf-rail{i} u→spine2 (u odd):  10.30.{2i+2}.{2*(u//2)}/31
# rail SVI:   leaf-rail{i} 10.30.{64+i}.1/24, worker0N .1N (host-side, day-2)

# EVPN/VXLAN overlay plan (docs/overlay.md) -----------------------------
# VTEP Lo1:   spine{n} 10.30.32.{n}  ·  leaf-rail{i} 10.30.32.{11+i}
# VRF storage: L3VNI 50200 · VLAN 200 access L2VNI 10200 · VARP gw 10.40.64.1
#              (leaf-rail{i} SVI real IP 10.40.64.{2+i}/24)
# VRF edge:    L3VNI 50050 · VLAN 50  access L2VNI 10050 · VARP gw 10.50.64.1
#              (leaf-rail{i} SVI real IP 10.50.64.{2+i}/24; MetalLB peers .2/.9)
# storage p2p: leaf-rail0 Eth25-28 = 10.40.0.{0,2,4,6}/31 (leaf even),
#              leaf-rail7 Eth25-28 = 10.40.0.{8,10,12,14}/31
# border p2p:  spine{n} Eth33 = 10.50.255.{2(n-1)}/31 → firewall AS 65500
METALLB_ASN = 65200  # k8s speakers, vrf edge, listen 10.50.64.0/24
BORDER_ASN = 65500
ANYCAST_MAC = "00:1c:73:00:00:01"


def loop_spine(n: int) -> str:
    return f"10.30.0.{n}/32"


def loop_leaf(i: int) -> str:
    return f"10.30.0.{11 + i}/32"


def vtep_spine(n: int) -> str:
    return f"10.30.32.{n}/32"


def vtep_leaf(i: int) -> str:
    return f"10.30.32.{11 + i}/32"


def p2p_leaf(i: int, u: int) -> str:
    """Leaf-side /31 address for uplink u of leaf-rail{i}."""
    return f"10.30.{2 * i + 1 + (u % 2)}.{2 * (u // 2)}/31"


def p2p_spine(i: int, u: int) -> str:
    """Spine-side /31 address for uplink u of leaf-rail{i}."""
    return f"10.30.{2 * i + 1 + (u % 2)}.{2 * (u // 2) + 1}/31"


def common(hostname: str) -> str:
    return f"""hostname {hostname}
!
ip domain-name {DOMAIN}
ip name-server {SEED_IP}
ntp server {SEED_IP}
!
aaa authentication policy local allow-nopassword-remote-login
username admin privilege 15 role network-admin secret disabled
!
management api http-commands
   no shutdown
!
logging host 10.10.0.31
!
snmp-server community public ro
!
transceiver qsfp default-mode 4x100G disabled
!"""


def qos_profile() -> str:
    """RoCEv2 lossless AI profile — docs/network.md §6.

    DSCP 26 (RoCE) → TC3 lossless PFC + ECN · DSCP 48 (CNP) → TC6 strict ·
    DSCP 18 (storage) → TC1 · everything else → TC0 best-effort.
    """
    return """!
! === RoCEv2 lossless AI profile (docs/network.md §6) ===
qos map dscp 26 to traffic-class 3
qos map dscp 48 to traffic-class 6
qos map dscp 18 to traffic-class 1
!
priority-flow-control watchdog polling-interval 0.4 action errdisable
!
! NOTE: ECN thresholds + MMU/headroom knobs are platform- and release-specific
! (57 MB buffer on DX5-32, 114 MB on DX5-64S). Starting values below assume
! ~5 µs PFC reaction budget at 400G (~300 KB/port headroom) — tune with LANZ
! telemetry during burn-in (docs/network.md §6.4, §8).
!"""


def qos_interfaces(ports: list[str], pfc: bool) -> str:
    out = []
    for p in ports:
        out.append(f"""interface {p}
   qos trust dscp
   tx-queue 3
      random-detect ecn minimum-threshold 512 maximum-threshold 1536 units kbytes
   tx-queue 6
      bandwidth priority
{('   priority-flow-control priority 3 no-drop' if pfc else '')}
""")
    return "\n".join(out)


# ---------------------------------------------------------------- OOB pair
def render_oob(seed: dict, name: str, peer: str, sw_id: int) -> str:
    """oob-sw1 (id 1) / oob-sw2 (id 2) — MLAG pair, VARP gw, DHCP relay."""
    mlag_ip = f"10.255.0.{sw_id}/30"
    mlag_peer = f"10.255.0.{3 - sw_id}"
    stp_prio = 4096 if sw_id == 1 else 8192

    # derive access-port map from cabling (single source of truth)
    ports: dict[int, tuple[int, str]] = {}  # eth port -> (vlan, desc)
    for c in all_cables(seed):
        if c["b"]["device"] != name or not c["b"]["iface"].startswith("Ethernet"):
            continue
        eth = int(c["b"]["iface"].replace("Ethernet", ""))
        src = c["a"]["iface"]
        vlan = 10 if src == "mgmt0" else 20
        ports[eth] = (vlan, f"{c['a']['device']} {src}")

    access = []
    for eth in sorted(ports):
        vlan, desc = ports[eth]
        access.append(
            f"interface Ethernet{eth}\n"
            f"   description {desc}\n"
            f"   switchport access vlan {vlan}\n"
        )

    mgmt_ip = (next(d for d in seed["devices"] if d["name"] == name)["mgmt_ip"]).split("/")[0]
    return f"""{common(name)}
!
vlan 10
   name mgmt
vlan 20
   name oob
vlan 4094
   name mlag-peer
   trunk group mlagpeer
!
spanning-tree mode mstp
spanning-tree mst 0 priority {stp_prio}
no spanning-tree vlan-id 4094
!
interface Port-Channel1
   description MLAG peer-link → {peer}
   switchport mode trunk
   switchport trunk group mlagpeer
!
interface Ethernet49
   channel-group 1 mode active
interface Ethernet50
   channel-group 1 mode active
!
mlag configuration
   domain-id oob
   local-interface Vlan4094
   peer-address {mlag_peer}
   peer-link Port-Channel1
   reload-delay mlag 300
   reload-delay non-mlag 330
!
interface Vlan4094
   description MLAG peer
   ip address {mlag_ip}
!
ip routing
!
interface Vlan10
   description mgmt (servers mgmt0 / PXE)
   ip address 10.10.0.{10 + sw_id}/24
   ip virtual-router address 10.10.0.1
!
interface Vlan20
   description oob (BMC + switch Ma1 / ZTP)
   ip address {mgmt_ip}/24
   ip helper-address {SEED_IP}
   ip virtual-router address 10.20.0.1
!
! access ports — VLAN 20 = BMC + switch Ma1 (ZTP) · VLAN 10 = server mgmt0
{chr(10).join(access)}
! uplinks 51-52: reserved for site network / border (not used day-1)
!
ip access-list mgmt-plane
   10 permit ip 10.10.0.0/24 any
   20 permit ip 10.20.0.0/24 any
   30 permit icmp any any
   40 deny ip any any log
!
control-plane
   ip access-group mgmt-plane in
!
end
"""


# ------------------------------------------------------------------ spines
def render_spine(seed: dict, name: str, n: int) -> str:
    ports = []
    neighbors = []
    for i in range(8):  # rails
        for u in range(8):  # uplinks per leaf
            if (u % 2) + 1 != n:  # this spine only
                continue
            eth = i * 4 + (u // 2) + 1
            ports.append((f"Ethernet{eth}", p2p_spine(i, u), f"leaf-rail{i} u{u + 1}"))
            neighbors.append((p2p_leaf(i, u).split("/")[0], LEAF_ASN_BASE + i + 1))

    iface = "\n".join(
        f"interface {p}\n   description {d}\n   no switchport\n   mtu 9216\n"
        f"   ip address {ip}"
        for p, ip, d in ports
    )
    neigh = "\n".join(
        f"   neighbor {ip} remote-as {asn}\n   neighbor {ip} bfd\n"
        f"   neighbor {ip} description leaf"
        for ip, asn in neighbors
    )
    # EVPN overlay sessions: spine Lo0 ↔ every leaf Lo0 (eBGP multihop)
    evpn_neigh = "\n".join(
        f"   neighbor {loop_leaf(i).split('/')[0]} peer group EVPN-OVERLAY\n"
        f"   neighbor {loop_leaf(i).split('/')[0]} remote-as {LEAF_ASN_BASE + i + 1}"
        for i in range(8)
    )
    border_ip = f"10.50.255.{2 * (n - 1)}/31"
    border_peer = f"10.50.255.{2 * (n - 1) + 1}"
    return f"""{common(name)}
!
service routing protocols model multi-agent
!
spanning-tree mode none
{qos_profile()}
vrf instance edge
!
ip routing vrf edge
!
interface Loopback0
   ip address {loop_spine(n)}
!
interface Loopback1
   description VTEP
   ip address {vtep_spine(n)}
!
{iface}
!
interface Ethernet33
   description border/campus firewall (vrf edge)
   no switchport
   mtu 9216
   vrf edge
   ip address {border_ip}
!
interface Vxlan1
   vxlan source-interface Loopback1
   vxlan udp-port 4789
   vxlan vrf edge vni 50050
!
{qos_interfaces([p for p, _, _ in ports], pfc=True)}
!
router bgp {SPINE_ASN}
   router-id {loop_spine(n).split('/')[0]}
   maximum-paths 32
   neighbor EVPN-OVERLAY peer group
   neighbor EVPN-OVERLAY update-source Loopback0
   neighbor EVPN-OVERLAY ebgp-multihop 3
   neighbor EVPN-OVERLAY send-community extended
   neighbor EVPN-OVERLAY next-hop-unchanged
{evpn_neigh}
{neigh}
   !
   address-family evpn
      neighbor EVPN-OVERLAY activate
   !
   address-family ipv4
      network {loop_spine(n)}
      network {vtep_spine(n)}
   !
   vrf edge
      rd {loop_spine(n).split('/')[0]}:50
      route-target import evpn 50050:50050
      route-target export evpn 50050:50050
      neighbor {border_peer} remote-as {BORDER_ASN}
      neighbor {border_peer} description border firewall
      redistribute connected
!
end
"""


# --------------------------------------------------------------- rail leaf
def render_leaf(seed: dict, name: str, i: int) -> str:
    asn = LEAF_ASN_BASE + i + 1
    rail_net = f"10.30.{64 + i}"
    lo0 = loop_leaf(i).split("/")[0]
    uplinks = []
    for u in range(8):
        eth = 17 + u
        spine = (u % 2) + 1
        uplinks.append((f"Ethernet{eth}", p2p_leaf(i, u), f"spine{spine} u{u + 1}"))

    # Host ports: trunk, native = rail VLAN (untagged RoCE unchanged);
    # tagged 200/50 = worker storage/edge subinterfaces (docs/overlay.md §4)
    host_ports = "\n".join(
        f"interface Ethernet{w}\n   description worker0{w} rail{i} NIC\n"
        f"   switchport mode trunk\n"
        f"   switchport trunk native vlan {64 + i}\n"
        f"   switchport trunk allowed vlan {64 + i},50,200\n   mtu 9216"
        for w in range(1, 9)
    )
    up_iface = "\n".join(
        f"interface {p}\n   description {d}\n   no switchport\n   mtu 9216\n"
        f"   ip address {ip}"
        for p, ip, d in uplinks
    )
    neigh = "\n".join(
        f"   neighbor {p2p_spine(i, u).split('/')[0]} remote-as {SPINE_ASN}\n"
        f"   neighbor {p2p_spine(i, u).split('/')[0]} bfd"
        for u in range(8)
    )

    # Storage attachment (rails 0/7 only): routed p2p in vrf storage
    storage_ports = ""
    if i in (0, 7):
        base = 0 if i == 0 else 8
        storage_ports = "\n".join(
            f"interface Ethernet{25 + s}\n"
            f"   description stor{'0' if i == 0 else '1'}{s + 1} 400G (vrf storage)\n"
            f"   no switchport\n   mtu 9216\n   vrf storage\n"
            f"   ip address 10.40.0.{base + 2 * s}/31"
            for s in range(4)
        ) + "\n!"

    # MetalLB speakers (vrf edge) peer only via rails 0/7
    metallb = ""
    if i in (0, 7):
        metallb = (
            f"      bgp listen range 10.50.64.0/24 peer-group METALLB "
            f"remote-as {METALLB_ASN}\n"
            "      neighbor METALLB peer group\n"
        )

    return f"""{common(name)}
!
service routing protocols model multi-agent
!
spanning-tree mode none
{qos_profile()}
vlan {64 + i}
   name rail-{i}
vlan 50
   name edge-access
vlan 200
   name storage-access
!
vrf instance edge
vrf instance storage
!
ip routing
ip routing vrf edge
ip routing vrf storage
!
ip virtual-router mac-address {ANYCAST_MAC}
!
interface Loopback0
   ip address {loop_leaf(i)}
!
interface Loopback1
   description VTEP
   ip address {vtep_leaf(i)}
!
interface Vlan{64 + i}
   description rail-{i} host subnet (worker0N = .1N)
   ip address {rail_net}.1/24
!
interface Vlan50
   description edge access (API/LB VIP path) — VARP gw .1
   vrf edge
   ip address 10.50.64.{2 + i}/24
   ip virtual-router address 10.50.64.1
!
interface Vlan200
   description storage access (worker mounts) — VARP gw .1
   vrf storage
   ip address 10.40.64.{2 + i}/24
   ip virtual-router address 10.40.64.1
!
{host_ports}
!
{storage_ports}
{up_iface}
!
interface Vxlan1
   vxlan source-interface Loopback1
   vxlan udp-port 4789
   vxlan vlan 50 vni 10050
   vxlan vlan 200 vni 10200
   vxlan vrf edge vni 50050
   vxlan vrf storage vni 50200
!
{qos_interfaces([f'Ethernet{w}' for w in range(1, 9)] + [p for p, _, _ in uplinks], pfc=True)}
!
router bgp {asn}
   router-id {lo0}
   maximum-paths 32
   neighbor EVPN-OVERLAY peer group
   neighbor EVPN-OVERLAY update-source Loopback0
   neighbor EVPN-OVERLAY ebgp-multihop 3
   neighbor EVPN-OVERLAY send-community extended
   neighbor {loop_spine(1).split('/')[0]} peer group EVPN-OVERLAY
   neighbor {loop_spine(1).split('/')[0]} remote-as {SPINE_ASN}
   neighbor {loop_spine(2).split('/')[0]} peer group EVPN-OVERLAY
   neighbor {loop_spine(2).split('/')[0]} remote-as {SPINE_ASN}
{neigh}
   !
   vlan 50
      rd {lo0}:10050
      route-target both 10050:10050
      redistribute learned
   !
   vlan 200
      rd {lo0}:10200
      route-target both 10200:10200
      redistribute learned
   !
   address-family evpn
      neighbor EVPN-OVERLAY activate
   !
   address-family ipv4
      network {loop_leaf(i)}
      network {vtep_leaf(i)}
      network {rail_net}.0/24
   !
   vrf edge
      rd {lo0}:50
      route-target import evpn 50050:50050
      route-target export evpn 50050:50050
{metallb}      redistribute connected
   !
   vrf storage
      rd {lo0}:200
      route-target import evpn 50200:50200
      route-target export evpn 50200:50200
      redistribute connected
!
end
"""


# -------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--output", type=Path, required=True)
    ap.add_argument(
        "--serialmap",
        type=Path,
        default=Path(__file__).resolve().parent / "serialmap.yaml",
    )
    args = ap.parse_args()

    seed = load_seed()
    serials: dict[str, str] = {}
    if args.serialmap.exists():
        serials = yaml.safe_load(args.serialmap.read_text(encoding="utf-8")) or {}
        serials = {v: k for k, v in serials.items()}  # hostname -> serial

    def serial_for(hostname: str) -> str:
        return serials.get(hostname) or "SERIAL-" + hostname.upper().replace("-", "-")

    rendered: dict[str, str] = {}
    for name in ("oob-sw1", "oob-sw2"):
        rendered[name] = render_oob(seed, name, "oob-sw2" if name == "oob-sw1" else "oob-sw1",
                                    1 if name == "oob-sw1" else 2)
    for n in (1, 2):
        rendered[f"spine{n}"] = render_spine(seed, f"spine{n}", n)
    for i in range(8):
        rendered[f"leaf-rail{i}"] = render_leaf(seed, f"leaf-rail{i}", i)

    cfg_dir = args.output / "configs"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    for hostname, cfg in sorted(rendered.items()):
        marker = f"!IMAGE: {EOS_IMAGE[0]} {EOS_IMAGE[1]}\n" if EOS_IMAGE else ""
        (cfg_dir / serial_for(hostname)).write_text(marker + cfg, encoding="utf-8")

    (args.output / "README.txt").write_text(
        "ZTP config inventory — one file per switch SERIAL.\n"
        "Rendered by bootstrap/seed/ztp/render.py from seed/site.yaml.\n"
        "Fill bootstrap/seed/ztp/serialmap.yaml with real serials at staging.\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(rendered)} configs → {cfg_dir}")
    for hostname in sorted(rendered):
        print(f"  {hostname:12s} → {serial_for(hostname)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
