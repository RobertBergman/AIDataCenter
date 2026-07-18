#!/usr/bin/env python3
"""Import bootstrap/netbox/seed/site.yaml into NetBox (idempotent)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nb_lib import (  # noqa: E402
    all_cables,
    ensure,
    expand_gpu_interfaces,
    expand_switch_interfaces,
    load_seed,
    netbox_client,
)


def cf_defs(nb):
    """Custom fields used by bootstrap export."""
    fields = [
        {
            "name": "k8s_role",
            "label": "Kubernetes role",
            "type": "text",
            "object_types": ["dcim.device"],
            "required": False,
        },
        {
            "name": "gpu_count",
            "label": "GPU count",
            "type": "integer",
            "object_types": ["dcim.device"],
            "required": False,
        },
        {
            "name": "rail_index",
            "label": "Rail index",
            "type": "integer",
            "object_types": ["dcim.device"],
            "required": False,
        },
        {
            "name": "redfish_url",
            "label": "Redfish URL",
            "type": "text",
            "object_types": ["dcim.device"],
            "required": False,
        },
    ]
    for f in fields:
        # NetBox 4.x uses object_types; older used content_types
        existing = nb.extras.custom_fields.get(name=f["name"])
        if existing:
            continue
        try:
            nb.extras.custom_fields.create(f)
        except Exception as e:
            # fallback content_types for older
            fb = dict(f)
            fb.pop("object_types", None)
            fb["content_types"] = ["dcim.device"]
            try:
                nb.extras.custom_fields.create(fb)
            except Exception:
                print(f"  warn custom field {f['name']}: {e}")


def main() -> int:
    seed = load_seed()
    nb = netbox_client()
    print("==> custom fields")
    cf_defs(nb)

    print("==> site / tenant")
    site = ensure(
        nb.dcim.sites,
        {"slug": seed["site"]["slug"]},
        {
            "name": seed["site"]["name"],
            "slug": seed["site"]["slug"],
            "status": seed["site"].get("status", "active"),
            "description": seed["site"].get("description", ""),
            "time_zone": seed["site"].get("time_zone") or None,
        },
    )
    tenant = ensure(
        nb.tenancy.tenants,
        {"slug": seed["tenant"]["slug"]},
        {"name": seed["tenant"]["name"], "slug": seed["tenant"]["slug"]},
    )

    print("==> manufacturers / roles / types / platforms")
    mfr = {}
    for m in seed["manufacturer"]:
        mfr[m["name"]] = ensure(
            nb.dcim.manufacturers,
            {"slug": m["slug"]},
            {"name": m["name"], "slug": m["slug"]},
        )

    roles = {}
    for r in seed["device_roles"]:
        roles[r["slug"]] = ensure(
            nb.dcim.device_roles,
            {"slug": r["slug"]},
            {
                "name": r["name"],
                "slug": r["slug"],
                "color": r["color"],
                "vm_role": r.get("vm_role", False),
            },
        )

    dtypes = {}
    for t in seed["device_types"]:
        mid = mfr[t["manufacturer"]].id
        dtypes[t["slug"]] = ensure(
            nb.dcim.device_types,
            {"slug": t["slug"]},
            {
                "manufacturer": mid,
                "model": t["model"],
                "slug": t["slug"],
                "u_height": t.get("u_height", 1),
                "is_full_depth": t.get("is_full_depth", True),
            },
        )

    platforms = {}
    for p in seed["platforms"]:
        payload = {"name": p["name"], "slug": p["slug"]}
        if p.get("manufacturer"):
            payload["manufacturer"] = mfr[p["manufacturer"]].id
        platforms[p["slug"]] = ensure(nb.dcim.platforms, {"slug": p["slug"]}, payload)

    print("==> racks")
    racks = {}
    for r in seed["racks"]:
        racks[r["name"]] = ensure(
            nb.dcim.racks,
            {"site_id": site.id, "name": r["name"]},
            {
                "name": r["name"],
                "slug": r.get("slug") or r["name"].lower(),
                "site": site.id,
                "status": r.get("status", "reserved"),
                "u_height": r.get("u_height", 48),
                "tenant": tenant.id,
            },
        )

    print("==> VLANs")
    vlans = {}
    for v in seed["vlans"]:
        vlans[v["slug"]] = ensure(
            nb.ipam.vlans,
            {"site_id": site.id, "vid": v["vid"]},
            {
                "site": site.id,
                "vid": v["vid"],
                "name": v["name"],
                "slug": v["slug"],
                "description": v.get("description", ""),
                "status": "active",
                "tenant": tenant.id,
            },
        )

    print("==> IPAM prefixes")
    # RIR
    rir = ensure(
        nb.ipam.rirs,
        {"slug": "rfc1918"},
        {"name": "RFC 1918", "slug": "rfc1918", "is_private": True},
    )
    for a in seed["ipam"].get("aggregates", []):
        ensure(
            nb.ipam.aggregates,
            {"prefix": a["prefix"]},
            {"prefix": a["prefix"], "rir": rir.id, "description": a.get("description", "")},
        )

    for p in seed["ipam"]["prefixes"]:
        payload = {
            "prefix": p["prefix"],
            "status": p.get("status", "active"),
            "description": p.get("description", ""),
            "site": site.id,
            "tenant": tenant.id,
            "is_pool": True,
        }
        if p.get("vlan"):
            payload["vlan"] = vlans[p["vlan"]].id
        ensure(nb.ipam.prefixes, {"prefix": p["prefix"]}, payload)

    print("==> cluster")
    ctype = ensure(
        nb.virtualization.cluster_types,
        {"slug": seed["cluster"]["type"]},
        {"name": seed["cluster"]["type"].title(), "slug": seed["cluster"]["type"]},
    )
    ensure(
        nb.virtualization.clusters,
        {"name": seed["cluster"]["name"]},
        {
            "name": seed["cluster"]["name"],
            "type": ctype.id,
            "status": "planned",
            "tenant": tenant.id,
        },
    )

    print("==> devices + interfaces + IPs")
    for d in seed["devices"]:
        role_slug = d["role"]
        dt_slug = d["device_type"]
        payload = {
            "name": d["name"],
            "device_type": dtypes[dt_slug].id,
            "role": roles[role_slug].id,
            "site": site.id,
            "tenant": tenant.id,
            "status": d.get("status", "planned"),
            "rack": racks[d["rack"]].id if d.get("rack") else None,
            "position": d.get("position"),
            "face": d.get("face", "front") if d.get("position") else None,
            "custom_fields": d.get("custom_fields") or {},
        }
        if d.get("platform"):
            payload["platform"] = platforms[d["platform"]].id
        # strip Nones
        payload = {k: v for k, v in payload.items() if v is not None}
        dev = ensure(nb.dcim.devices, {"name": d["name"], "site_id": site.id}, payload)

        ifaces = expand_gpu_interfaces(d)
        ifaces = expand_switch_interfaces({**d, "interfaces": ifaces})
        for iface in ifaces:
            ipayload = {
                "device": dev.id,
                "name": iface["name"],
                "type": iface.get("type", "other"),
                "enabled": True,
                "mgmt_only": iface.get("mgmt_only", False),
                "description": iface.get("description", ""),
                "label": iface.get("label", ""),
            }
            if iface.get("mac"):
                ipayload["mac_address"] = iface["mac"].upper()
            ensure(
                nb.dcim.interfaces,
                {"device_id": dev.id, "name": iface["name"]},
                ipayload,
            )

        def assign_ip(cidr: str | None, ifname: str, dns: str | None = None):
            if not cidr:
                return
            iface = nb.dcim.interfaces.get(device_id=dev.id, name=ifname)
            if not iface:
                return
            ip = ensure(
                nb.ipam.ip_addresses,
                {"address": cidr},
                {
                    "address": cidr,
                    "status": "active",
                    "dns_name": dns or f"{d['name']}.ai.local",
                    "tenant": tenant.id,
                    "assigned_object_type": "dcim.interface",
                    "assigned_object_id": iface.id,
                },
            )
            return ip

        primary = assign_ip(d.get("primary_ip4"), "mgmt0", f"{d['name']}.{seed['cluster']['domain']}")
        assign_ip(d.get("bmc_ip"), "bmc", f"{d['name']}-bmc.{seed['cluster']['domain']}")
        if primary and (not getattr(dev, "primary_ip4", None)):
            try:
                dev.primary_ip4 = primary.id
                dev.save()
            except Exception:
                pass

        # redfish custom field
        if d.get("bmc_ip"):
            bmc = d["bmc_ip"].split("/")[0]
            cfs = dict(d.get("custom_fields") or {})
            cfs["redfish_url"] = f"redfish-virtualmedia://{bmc}/redfish/v1/Systems/1"
            try:
                dev.custom_fields = cfs
                dev.save()
            except Exception:
                pass

    # standalone IPs (gateways, VIP)
    for ip in seed["ipam"].get("ip_addresses", []):
        if ip.get("device"):
            continue
        ensure(
            nb.ipam.ip_addresses,
            {"address": ip["address"]},
            {
                "address": ip["address"],
                "status": "active",
                "dns_name": ip.get("dns_name", ""),
                "description": ip.get("description", ""),
                "role": ip.get("role") or None,
                "tenant": tenant.id,
            },
        )

    print("==> cables")
    # cable type / termination via API
    cables = all_cables(seed)
    created = 0
    for c in cables:
        existing = nb.dcim.cables.get(label=c["label"])
        if existing:
            continue
        a_if = nb.dcim.interfaces.get(device=c["a"]["device"], name=c["a"]["iface"])
        b_if = nb.dcim.interfaces.get(device=c["b"]["device"], name=c["b"]["iface"])
        if not a_if or not b_if:
            print(f"  skip {c['label']}: missing iface {c['a']} or {c['b']}")
            continue
        payload = {
            "label": c["label"],
            "status": c.get("status", "planned"),
            "description": c.get("description", ""),
            "a_terminations": [{"object_type": "dcim.interface", "object_id": a_if.id}],
            "b_terminations": [{"object_type": "dcim.interface", "object_id": b_if.id}],
        }
        if c.get("color"):
            payload["color"] = c["color"]
        try:
            nb.dcim.cables.create(payload)
            created += 1
        except Exception as e:
            print(f"  cable {c['label']}: {e}")
    print(f"  cables created this run: {created} (total planned {len(cables)})")

    print("OK — NetBox seed import complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
