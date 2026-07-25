"""Model backed by NetBox.

This is the path that matters operationally: golden configs are rendered from the system
of record, not from a file on someone's laptop. Everything here is read back out of the
NetBox API -- devices, their interfaces, the cables between them, and the addressing --
so if NetBox and reality disagree, the rendered config follows NetBox and the drift check
catches the difference.

QoS intent is deliberately still read from sot/qos.yml: NetBox models inventory and
addressing well and traffic-class policy badly. Splitting them is the honest arrangement,
and the README says so.
"""

from __future__ import annotations

import ipaddress
import os

import pynetbox

import sotlib as sot

NETBOX_URL = os.environ.get("NETBOX_URL", "http://netbox:8080")
NETBOX_TOKEN = os.environ.get("NETBOX_TOKEN", "0123456789abcdef0123456789abcdef01234567")


class NetBoxModel:
    def __init__(self) -> None:
        self.nb = pynetbox.api(NETBOX_URL, token=NETBOX_TOKEN)
        self.nb.http_session.headers.update({"Authorization": f"Token {NETBOX_TOKEN}"})
        self._version = self.nb.status().get("netbox-version", "?")

        ctx = self.nb.extras.config_contexts.get(name="aidc-ipam")
        if ctx is None:
            raise RuntimeError("config context 'aidc-ipam' missing -- run netbox_seed.py first")
        self._ipam = dict(ctx.data)
        self._rails = {r["rail"]: r for r in self._ipam["rails"]}
        self._rail_by_leaf = {r["leaf"]: r for r in self._ipam["rails"]}

        self._devices: dict[str, sot.Device] = {}
        self._links_by_device: dict[str, list] = {}
        self._load()

    # ------------------------------------------------------------------ loading

    def _load(self) -> None:
        for nbdev in self.nb.dcim.devices.filter(site="lab-pod1"):
            ctx = nbdev.local_context_data or {}
            self._devices[nbdev.name] = sot.Device(
                name=nbdev.name,
                role=ctx.get("role") or str(nbdev.role),
                devid=ctx.get("devid"),
                mgmt_ip=ctx.get("mgmt_ip"),
                asn=ctx.get("asn"),
                loopback=ctx.get("loopback"),
                rail=ctx.get("rail"),
                sonic_type=ctx.get("sonic_type"),
                sonic_preset=ctx.get("sonic_preset"),
                gpus=ctx.get("gpus"),
                raw=ctx,
            )

        # Interface addresses, resolved once: an interface's /31 is what the underlay
        # config is built from.
        addr_by_iface: dict[int, str] = {}
        for addr in self.nb.ipam.ip_addresses.filter(limit=0):
            if addr.assigned_object_id:
                addr_by_iface[addr.assigned_object_id] = str(addr.address)

        for cable in self.nb.dcim.cables.filter(limit=0):
            # pynetbox resolves cable terminations straight to Interface objects, but the
            # nested representation omits custom fields, so re-fetch each one in full.
            a_if = self.nb.dcim.interfaces.get(cable.a_terminations[0].id)
            b_if = self.nb.dcim.interfaces.get(cable.b_terminations[0].id)

            ends = []
            for iface in (a_if, b_if):
                cf = iface.custom_fields or {}
                ends.append(
                    sot.Endpoint(
                        device=str(iface.device),
                        port=iface.name,
                        ifindex=cf.get("ifindex"),
                        ip=addr_by_iface.get(iface.id),
                    )
                )
            subnet = (a_if.custom_fields or {}).get("link_subnet") or ""

            # A cable to a compute node is a rail; between switches it is underlay.
            devices = {e.device for e in ends}
            roles = {self._devices[d].role for d in devices if d in self._devices}
            if "gpu_node" in roles:
                ltype = "rail"
                leaf = next(d for d in devices if self._devices[d].role == "leaf")
                rail_id = self._devices[leaf].rail
            else:
                ltype = "fabric"
                rail_id = None

            link = sot.Link(
                id=cable.label or f"cable{cable.id}",
                type=ltype,
                a=ends[0],
                b=ends[1],
                rail=rail_id,
                net_subnet=subnet,
            )
            for end, other in ((ends[0], ends[1]), (ends[1], ends[0])):
                self._links_by_device.setdefault(end.device, []).append((link, end, other))

        for name in self._links_by_device:
            self._links_by_device[name].sort(key=lambda t: t[1].ifindex or 0)

    # ------------------------------------------------------------------ interface

    def describe(self) -> str:
        return f"NetBox {self._version} at {NETBOX_URL}"

    def devices(self) -> list[sot.Device]:
        return sorted(self._devices.values(), key=lambda d: d.name)

    def device(self, name: str) -> sot.Device:
        return self._devices[name]

    def links_for(self, name: str):
        return self._links_by_device.get(name, [])

    def rail(self, rail_id: int) -> dict:
        return self._rails[rail_id]

    def rail_for_leaf(self, leaf: str) -> dict:
        return self._rail_by_leaf[leaf]

    def rail_host_ip(self, dev: sot.Device, rail_id: int) -> str:
        net = ipaddress.ip_network(self._rails[rail_id]["prefix"])
        gpu_names = sorted(d.name for d in self._devices.values() if d.role == "gpu_node")
        index = gpu_names.index(dev.name) + 1
        host = net.network_address + self._ipam["rail_host_offset"] + index
        return f"{host}/{net.prefixlen}"

    def expected_neighbors(self, name: str) -> dict:
        return {
            local.port: {
                "link_id": link.id,
                "neighbor": remote.device,
                "neighbor_port": remote.port,
                "type": link.type,
                "rail": link.rail,
            }
            for link, local, remote in self.links_for(name)
        }
