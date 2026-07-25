"""Load the YAML source of truth into NetBox.

Humans author YAML; NetBox is the system of record the pipeline reads. This script is the
bridge, and it is idempotent -- running it twice leaves NetBox in the same state, which is
what makes it safe to run from CI on every change.

What lands where:
  Device.local_context_data   per-device intent (ASN, loopback, rail, role specifics)
  Interface custom fields     ifindex + the Docker network backing that cable
  Cable                       the rail map -- the object LLDP gets diffed against
  IPAddress                   management, loopback and point-to-point addressing
  ConfigContext 'aidc-ipam'   the rail/IPAM plan shared by every device
"""

from __future__ import annotations

import os
import sys
import time

import pynetbox
import requests

import sotlib as sot

NETBOX_URL = os.environ.get("NETBOX_URL", "http://netbox:8080")
NETBOX_TOKEN = os.environ.get("NETBOX_TOKEN", "0123456789abcdef0123456789abcdef01234567")

SITE_SLUG = "lab-pod1"
MANUFACTURER = "AIDC Lab"

ROLE_DEFS = {
    "spine": ("Spine Switch", "spine", "9e9e9e"),
    "leaf": ("Leaf Switch (rail ToR)", "leaf", "2196f3"),
    "gpu_node": ("GPU Compute Node", "gpu-node", "4caf50"),
}

DEVICE_TYPE_DEFS = {
    "switch": ("SONiC VS 32x40G", "sonic-vs-32x40g"),
    "gpu_node": ("GPU Node 4-rail", "gpu-node-4rail"),
}


def wait_for_netbox(timeout: int = 600) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = requests.get(f"{NETBOX_URL}/api/status/", timeout=5,
                             headers={"Authorization": f"Token {NETBOX_TOKEN}"})
            if r.ok:
                print(f"netbox ready: {r.json().get('netbox-version')}")
                return
        except requests.RequestException:
            pass
        print("waiting for netbox...")
        time.sleep(10)
    sys.exit("netbox did not become ready in time")


def ensure(endpoint, key: dict, defaults: dict | None = None,
           create_key: dict | None = None):
    """Get-or-create, then update if the defaults have drifted.

    `key` is the lookup filter; `create_key` replaces it in the POST body when the two
    differ -- NetBox filters interfaces by `device_id` but creates them with `device`.
    """
    obj = endpoint.get(**key)
    if obj is None:
        payload = {**(create_key if create_key is not None else key), **(defaults or {})}
        return endpoint.create(**payload)
    if defaults:
        changed = False
        for k, v in defaults.items():
            if getattr(obj, k, None) != v and not isinstance(v, (dict, list)):
                setattr(obj, k, v)
                changed = True
        if changed:
            obj.save()
    return obj


def ensure_custom_fields(nb) -> None:
    """Interfaces need to carry the cable's Docker network and the container ifindex.

    These are the two facts that let a booting device work out which physical interface is
    which before it has any config at all.
    """
    ct = ["dcim.interface"]
    for name, label, cf_type, desc in [
        ("ifindex", "Container ifindex", "integer",
         "Nth interface inside the container; sonic-vs maps N -> Ethernet(4*(N-1))"),
        ("link_subnet", "Cable network", "text",
         "Docker bridge subnet backing this cable"),
    ]:
        existing = nb.extras.custom_fields.get(name=name)
        if existing:
            continue
        nb.extras.custom_fields.create(
            object_types=ct, name=name, label=label, type=cf_type, description=desc,
            required=False,
        )
        print(f"  custom field: {name}")


def seed() -> None:
    nb = pynetbox.api(NETBOX_URL, token=NETBOX_TOKEN)
    nb.http_session.headers.update({"Authorization": f"Token {NETBOX_TOKEN}"})

    print("== custom fields")
    ensure_custom_fields(nb)

    print("== site, manufacturer, roles, device types")
    site = ensure(nb.dcim.sites, {"slug": SITE_SLUG},
                  {"name": sot.FABRIC["site"]["name"],
                   "description": sot.FABRIC["site"]["description"]})
    mfr = ensure(nb.dcim.manufacturers, {"slug": "aidc-lab"}, {"name": MANUFACTURER})

    roles = {}
    for key, (name, slug, colour) in ROLE_DEFS.items():
        roles[key] = ensure(nb.dcim.device_roles, {"slug": slug},
                            {"name": name, "color": colour})

    dtypes = {}
    for key, (model, slug) in DEVICE_TYPE_DEFS.items():
        dtypes[key] = ensure(nb.dcim.device_types, {"slug": slug},
                             {"model": model, "manufacturer": mfr.id, "u_height": 1})

    print("== config context (rail / IPAM plan)")
    ctx_data = {
        "rails": sot.IPAM["rails"],
        "oob_management": sot.IPAM["oob_management"],
        "rail_host_offset": sot.IPAM["rail_host_offset"],
        "fabric_defaults": sot.FABRIC["defaults"],
    }
    ctx = nb.extras.config_contexts.get(name="aidc-ipam")
    if ctx is None:
        nb.extras.config_contexts.create(name="aidc-ipam", weight=1000, data=ctx_data,
                                         is_active=True)
    else:
        ctx.data = ctx_data
        ctx.save()

    print("== devices")
    devices = {}
    for dev in sorted(sot.DEVICES.values(), key=lambda d: d.name):
        dtype = dtypes["gpu_node" if dev.role == "gpu_node" else "switch"]
        local_ctx = {
            "devid": dev.devid,
            "role": dev.role,
            "asn": dev.asn,
            "loopback": dev.loopback,
            "rail": dev.rail,
            "mgmt_ip": dev.mgmt_ip,
            "mgmt_mac": dev.mgmt_mac,
            "sonic_type": dev.sonic_type,
            "sonic_preset": dev.sonic_preset,
            "gpus": dev.gpus,
        }
        nbdev = ensure(nb.dcim.devices, {"name": dev.name},
                       {"site": site.id, "role": roles[dev.role].id,
                        "device_type": dtype.id, "status": "active"})
        nbdev.local_context_data = local_ctx
        nbdev.save()
        devices[dev.name] = nbdev
        print(f"  {dev.name}")

    print("== interfaces")
    ifaces: dict[tuple[str, str], object] = {}
    for link in sot.LINKS:
        for end in (link.a, link.b):
            nbdev = devices[end.device]
            key = (end.device, end.port)
            if key in ifaces:
                continue
            iface = ensure(
                nb.dcim.interfaces,
                {"device_id": nbdev.id, "name": end.port},
                {"type": "40gbase-x-qsfpp", "mtu": sot.FABRIC["defaults"]["fabric_mtu"],
                 "enabled": True},
                create_key={"device": nbdev.id, "name": end.port},
            )
            iface.custom_fields = {"ifindex": end.ifindex, "link_subnet": link.net_subnet}
            iface.description = f"{link.id} ({link.type})"
            iface.save()
            ifaces[key] = iface

    # Management port, so the DHCP reservation has somewhere to live.
    for dev in sot.DEVICES.values():
        nbdev = devices[dev.name]
        mgmt = ensure(nb.dcim.interfaces, {"device_id": nbdev.id, "name": "eth0"},
                      {"type": "1000base-t", "mgmt_only": True, "enabled": True},
                      create_key={"device": nbdev.id, "name": "eth0"})
        mgmt.mac_address = dev.mgmt_mac
        mgmt.description = "out-of-band management"
        mgmt.save()
        ifaces[(dev.name, "eth0")] = mgmt

    print("== cables (the rail map)")
    made = 0
    for link in sot.LINKS:
        a = ifaces[(link.a.device, link.a.port)]
        b = ifaces[(link.b.device, link.b.port)]
        a = nb.dcim.interfaces.get(a.id)
        if a.cable:
            continue
        nb.dcim.cables.create(
            a_terminations=[{"object_type": "dcim.interface", "object_id": a.id}],
            b_terminations=[{"object_type": "dcim.interface", "object_id": b.id}],
            status="connected",
            label=link.id,
        )
        made += 1
    print(f"  {made} cable(s) created ({len(sot.LINKS)} in the plan)")

    print("== prefixes and addresses")
    for rail in sot.IPAM["rails"]:
        ensure(nb.ipam.prefixes, {"prefix": rail["prefix"]},
               {"site": site.id, "status": "active",
                "description": f"rail {rail['rail']} via {rail['leaf']} (vlan {rail['vlan']})"})
    ensure(nb.ipam.prefixes, {"prefix": sot.IPAM["oob_management"]["prefix"]},
           {"site": site.id, "status": "active", "description": "OOB management"})

    for dev in sot.DEVICES.values():
        nbdev = devices[dev.name]
        mgmt_if = ifaces[(dev.name, "eth0")]
        addr = ensure(nb.ipam.ip_addresses, {"address": dev.mgmt_ip},
                      {"status": "active", "description": f"{dev.name} management"})
        addr.assigned_object_type = "dcim.interface"
        addr.assigned_object_id = mgmt_if.id
        addr.save()
        nbdev.primary_ip4 = addr.id
        nbdev.save()

        if dev.loopback:
            lo = ensure(nb.dcim.interfaces, {"device_id": nbdev.id, "name": "Loopback0"},
                        {"type": "virtual", "enabled": True},
                        create_key={"device": nbdev.id, "name": "Loopback0"})
            lo_addr = ensure(nb.ipam.ip_addresses, {"address": dev.loopback},
                             {"status": "active", "description": f"{dev.name} loopback"})
            lo_addr.assigned_object_type = "dcim.interface"
            lo_addr.assigned_object_id = lo.id
            lo_addr.save()

    for link in sot.LINKS:
        for end in (link.a, link.b):
            if not end.ip:
                continue
            iface = ifaces[(end.device, end.port)]
            addr = ensure(nb.ipam.ip_addresses, {"address": end.ip},
                          {"status": "active",
                           "description": f"{end.device} {end.port} ({link.id})"})
            addr.assigned_object_type = "dcim.interface"
            addr.assigned_object_id = iface.id
            addr.save()

    print(f"\nseeded: {len(devices)} devices, {len(sot.LINKS)} cables")
    print(f"netbox ui: {NETBOX_URL}  (admin/admin)")


if __name__ == "__main__":
    wait_for_netbox()
    seed()
