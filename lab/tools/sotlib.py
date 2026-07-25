"""Shared model over the YAML source of truth.

Every downstream artifact -- the docker topology, the NetBox seed, the per-device
configs, the verification expectations -- is derived from this module. Nothing about
the lab is written twice, which is the whole point being proven: the fabric is a
rendering of the source of truth.
"""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

SOT_DIR = Path(os.environ.get("SOT_DIR", Path(__file__).resolve().parent.parent / "sot"))

# sonic-vs binds the Nth container interface (ethN, N>=1) to front-panel port
# Ethernet(4*(N-1)). Verified against lanemap.ini / port_config.ini in the 202511 image.
PORT_STRIDE = 4

# Locally-administered MAC prefixes. Deterministic MACs are what let DHCP reservations,
# interface naming and the LLDP cable check all agree without a discovery step.
MGMT_MAC_PREFIX = "02:aa:00:00:00"
LINK_MAC_PREFIX = "02:0f:00:00"


def sonic_port(ifindex: int) -> str:
    """Container interface index -> SONiC front-panel port name."""
    return f"Ethernet{PORT_STRIDE * (ifindex - 1)}"


def mgmt_mac(devid: int) -> str:
    return f"{MGMT_MAC_PREFIX}:{devid:02x}"


def link_mac(devid: int, ifindex: int) -> str:
    """MAC for a fabric/rail interface.

    The last octet encodes the intended interface index, which is how the node
    entrypoints rename Docker's arbitrarily-ordered interfaces into a deterministic
    ethN / railN layout before the NOS starts.
    """
    return f"{LINK_MAC_PREFIX}:{devid:02x}:{ifindex:02x}"


@dataclass
class Endpoint:
    device: str
    port: str
    ifindex: int
    ip: str | None = None

    @property
    def mac(self) -> str:
        return link_mac(DEVICES[self.device].devid, self.ifindex)


@dataclass
class Link:
    id: str
    type: str
    a: Endpoint
    b: Endpoint
    rail: int | None = None
    # docker network name + subnet backing this point-to-point link
    net_name: str = ""
    net_subnet: str = ""


@dataclass
class Device:
    name: str
    role: str
    devid: int
    mgmt_ip: str
    asn: int | None = None
    loopback: str | None = None
    rail: int | None = None
    sonic_type: str | None = None
    sonic_preset: str | None = None
    gpus: int | None = None
    raw: dict = field(default_factory=dict)

    @property
    def is_switch(self) -> bool:
        return self.role in ("spine", "leaf")

    @property
    def mgmt_mac(self) -> str:
        return mgmt_mac(self.devid)

    @property
    def mgmt_addr(self) -> str:
        """Management IP without the prefix length."""
        return self.mgmt_ip.split("/")[0]

    @property
    def loopback_addr(self) -> str | None:
        return self.loopback.split("/")[0] if self.loopback else None

    @property
    def node_index(self) -> int:
        """1-based index among GPU nodes, used for rail host addressing."""
        return sorted(d.name for d in DEVICES.values() if d.role == "gpu_node").index(self.name) + 1


def _load(name: str) -> dict:
    with open(SOT_DIR / name, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


FABRIC = _load("fabric.yml")
IPAM = _load("ipam.yml")
CABLING = _load("cabling.yml")
QOS = _load("qos.yml")

DEVICES: dict[str, Device] = {}
for _d in FABRIC["devices"]:
    DEVICES[_d["name"]] = Device(
        name=_d["name"],
        role=_d["role"],
        devid=_d["devid"],
        mgmt_ip=_d["mgmt_ip"],
        asn=_d.get("asn"),
        loopback=_d.get("loopback"),
        rail=_d.get("rail"),
        sonic_type=_d.get("sonic_type"),
        sonic_preset=_d.get("sonic_preset"),
        gpus=_d.get("gpus"),
        raw=_d,
    )

LINKS: list[Link] = []
for _i, _l in enumerate(CABLING["links"], start=1):
    LINKS.append(
        Link(
            id=_l["id"],
            type=_l["type"],
            rail=_l.get("rail"),
            a=Endpoint(**_l["a"]),
            b=Endpoint(**_l["b"]),
            net_name=f"link_{_l['id'].replace('-', '_')}",
            # Explicit per-link subnets: Docker's default address pool only carves out
            # ~32 networks, and this lab needs one bridge per cable.
            net_subnet=f"172.30.{_i}.0/24",
        )
    )

RAILS = {r["rail"]: r for r in IPAM["rails"]}
RAIL_BY_LEAF = {r["leaf"]: r for r in IPAM["rails"]}


def switches() -> list[Device]:
    return [d for d in DEVICES.values() if d.is_switch]


def gpu_nodes() -> list[Device]:
    return [d for d in DEVICES.values() if d.role == "gpu_node"]


def links_for(device: str) -> list[tuple[Link, Endpoint, Endpoint]]:
    """All links touching `device`, normalised as (link, local_end, remote_end)."""
    out = []
    for link in LINKS:
        if link.a.device == device:
            out.append((link, link.a, link.b))
        elif link.b.device == device:
            out.append((link, link.b, link.a))
    return sorted(out, key=lambda t: t[1].ifindex)


def rail_host_ip(node: Device, rail: int) -> str:
    """Address of a GPU node's NIC on a given rail, with prefix length."""
    net = ipaddress.ip_network(RAILS[rail]["prefix"])
    host = net.network_address + IPAM["rail_host_offset"] + node.node_index
    return f"{host}/{net.prefixlen}"


def expected_neighbors(device: str) -> dict[str, dict]:
    """Intended LLDP neighbours keyed by local port name -- the cable plan to diff against."""
    result = {}
    for link, local, remote in links_for(device):
        result[local.port] = {
            "link_id": link.id,
            "neighbor": remote.device,
            "neighbor_port": remote.port,
            "type": link.type,
            "rail": link.rail,
        }
    return result


def all_devices_by_mac() -> dict[str, Device]:
    """Management MAC -> device, used by the ZTP API to answer 'who am I'."""
    return {d.mgmt_mac.lower(): d for d in DEVICES.values()}
