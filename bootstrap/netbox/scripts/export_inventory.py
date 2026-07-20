#!/usr/bin/env python3
"""Export NetBox devices → bootstrap/inventory/cluster.yaml (generated SoT snapshot)."""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nb_lib import load_seed, ma1_mac, netbox_client  # noqa: E402


def primary_ip(dev) -> str | None:
    pip = getattr(dev, "primary_ip4", None)
    if not pip:
        return None
    addr = pip.address if hasattr(pip, "address") else str(pip)
    return addr.split("/")[0]


def iface_mac(nb, device_id: int, name: str) -> str | None:
    iface = nb.dcim.interfaces.get(device_id=device_id, name=name)
    if not iface:
        return None
    mac = getattr(iface, "mac_address", None)
    return str(mac).lower() if mac else None


def iface_ip(nb, device_id: int, name: str) -> str | None:
    iface = nb.dcim.interfaces.get(device_id=device_id, name=name)
    if not iface:
        return None
    ips = list(nb.ipam.ip_addresses.filter(interface_id=iface.id))
    if not ips:
        # NetBox 4 may use assigned_object_id
        ips = list(
            nb.ipam.ip_addresses.filter(
                device_id=device_id,
            )
        )
        for ip in ips:
            ao = getattr(ip, "assigned_object", None)
            if ao and getattr(ao, "id", None) == iface.id:
                return ip.address.split("/")[0]
        return None
    return ips[0].address.split("/")[0]


def role_slug(dev) -> str:
    role = dev.role
    if hasattr(role, "slug"):
        return role.slug
    return str(role)


def rack_name(dev) -> str | None:
    rack = getattr(dev, "rack", None)
    if not rack:
        return None
    return rack.name if hasattr(rack, "name") else str(rack)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "inventory" / "cluster.yaml",
    )
    ap.add_argument(
        "--offline",
        action="store_true",
        help="Render inventory from seed/site.yaml without NetBox API",
    )
    args = ap.parse_args()

    seed = load_seed()
    exp = seed["export"]
    domain = seed["cluster"]["domain"]

    if args.offline:
        devices = seed["devices"]

        def nodes_for(role: str):
            out = []
            for d in devices:
                if d["role"] != role:
                    continue
                mac = None
                mac_bmc = None
                for i in d.get("interfaces") or []:
                    if i["name"] == exp["mgmt_interface"]:
                        mac = i.get("mac")
                    if i["name"] == exp["bmc_interface"]:
                        mac_bmc = i.get("mac")
                if role == "gpu-worker":
                    idx = int(d["name"].replace("worker", ""))
                    if not mac:
                        mac = f"00:00:00:00:{idx:02x}:01"
                    if not mac_bmc:
                        mac_bmc = f"00:00:00:00:{idx:02x}:02"
                out.append(
                    {
                        "name": d["name"],
                        "ip": d.get("primary_ip4", "").split("/")[0],
                        "bmc": (d.get("bmc_ip") or "").split("/")[0] or None,
                        "mac_mgmt": mac,
                        "mac_bmc": mac_bmc,
                        "rack": d.get("rack"),
                        "netbox": f"offline:{d['name']}",
                    }
                )
            return sorted(out, key=lambda x: x["name"])

        def switches_offline():
            out = []
            for d in devices:
                if d["role"] not in ("spine", "rail-leaf", "oob-switch"):
                    continue
                out.append(
                    {
                        "name": d["name"],
                        "role": d["role"],
                        "mgmt_ip": (d.get("mgmt_ip") or "").split("/")[0] or None,
                        "mac_ma1": ma1_mac(d),
                        "rack": d.get("rack"),
                    }
                )
            return sorted(out, key=lambda x: x["name"])

        seed_dev = next(d for d in devices if d["role"] == "bootstrap")
        data = _assemble(
            seed,
            exp,
            domain,
            seed_host={
                "hostname": seed_dev["name"],
                "ip": seed_dev["primary_ip4"].split("/")[0],
            },
            cp=nodes_for("control-plane"),
            util=nodes_for("utility"),
            gpu=nodes_for("gpu-worker"),
            sw=switches_offline(),
            source="seed/site.yaml (offline)",
        )
    else:
        nb = netbox_client()
        by_role: dict[str, list] = defaultdict(list)
        sw_online: list[dict] = []
        for dev in nb.dcim.devices.filter(site=seed["site"]["slug"]):
            r = role_slug(dev)
            mac = iface_mac(nb, dev.id, exp["mgmt_interface"])
            bmc = iface_ip(nb, dev.id, exp["bmc_interface"])
            entry = {
                "name": dev.name,
                "ip": primary_ip(dev),
                "bmc": bmc,
                "mac_mgmt": mac,
                "mac_bmc": iface_mac(nb, dev.id, exp["bmc_interface"]),
                "rack": rack_name(dev),
                "netbox_id": dev.id,
            }
            by_role[r].append(entry)
            if r in ("spine", "rail-leaf", "oob-switch"):
                sw_online.append(
                    {
                        "name": dev.name,
                        "role": r,
                        "mgmt_ip": iface_ip(nb, dev.id, "Management1"),
                        "mac_ma1": iface_mac(nb, dev.id, "Management1"),
                        "rack": rack_name(dev),
                    }
                )

        for r in by_role:
            by_role[r] = sorted(by_role[r], key=lambda x: x["name"])

        seed_list = by_role.get(exp["bootstrap_role"], [])
        seed_host = {
            "hostname": seed_list[0]["name"] if seed_list else "seed01",
            "ip": seed_list[0]["ip"] if seed_list else exp["dns"][0],
        }
        data = _assemble(
            seed,
            exp,
            domain,
            seed_host=seed_host,
            cp=by_role.get(exp["control_plane_role"], []),
            util=by_role.get(exp["utility_role"], []),
            gpu=by_role.get(exp["gpu_worker_role"], []),
            sw=sorted(sw_online, key=lambda x: x["name"]),
            source=f"netbox:{os_netbox_url()}",
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "# GENERATED FILE — do not hand-edit.\n"
        f"# Source of truth: NetBox ({data['meta']['source']})\n"
        f"# Generated: {data['meta']['generated_at']}\n"
        "# Regenerate: python3 bootstrap/netbox/scripts/export_inventory.py\n"
    )
    body = yaml.safe_dump(data["inventory"], sort_keys=False, default_flow_style=False)
    args.output.write_text(header + body, encoding="utf-8")
    print(f"Wrote {args.output}")
    return 0


def os_netbox_url() -> str:
    import os

    return os.environ.get("NETBOX_URL", "http://127.0.0.1:8081")


def _assemble(seed, exp, domain, seed_host, cp, util, gpu, sw, source: str):
    inv = {
        "cluster": {
            "name": seed["cluster"]["name"],
            "domain": domain,
            "site": seed["site"]["slug"],
        },
        "network": {
            "mgmt": {
                "cidr": exp["mgmt_prefix"],
                "gateway": exp["gateway_mgmt"],
                "vlan": 10,
                "dns": exp["dns"],
                "ntp": exp["ntp"],
            },
            "k8s_service_cidr": "10.96.0.0/12",
            "k8s_pod_cidr": "10.244.0.0/16",
            "oob": {"cidr": exp["oob_prefix"], "gateway": exp["gateway_oob"]},
            "fabric": {
                "platform": "Arista 7060DX5",
                "rails": 8,
                "host_nics_per_gpu_server": 8,
            },
        },
        "seed": {
            "hostname": seed_host["hostname"],
            "role": "bootstrap",
            "ip": seed_host["ip"],
            "peer_ip": None,
        },
        "control_plane": {
            "count": len(cp),
            "vip": seed["cluster"]["api_vip"],
            "nodes": [
                {
                    "name": n["name"],
                    "ip": n["ip"],
                    "bmc": n.get("bmc"),
                    "mac_mgmt": n.get("mac_mgmt"),
                    "mac_bmc": n.get("mac_bmc"),
                    "rack": n.get("rack"),
                }
                for n in cp
            ],
        },
        "utility": {
            "nodes": [
                {
                    "name": n["name"],
                    "ip": n["ip"],
                    "bmc": n.get("bmc"),
                    "mac_mgmt": n.get("mac_mgmt"),
                    "mac_bmc": n.get("mac_bmc"),
                    "rack": n.get("rack"),
                }
                for n in util
            ],
        },
        "gpu_workers": {
            "count": len(gpu),
            "gpus_per_node": 8,
            "nodes": [
                {
                    "name": n["name"],
                    "ip": n["ip"],
                    "bmc": n.get("bmc"),
                    "mac_mgmt": n.get("mac_mgmt"),
                    "mac_bmc": n.get("mac_bmc"),
                    "rack": n.get("rack"),
                }
                for n in gpu
            ],
        },
        "switches": {
            "nodes": [
                {
                    "name": n["name"],
                    "role": n["role"],
                    "mgmt_ip": n.get("mgmt_ip"),
                    "mac_ma1": n.get("mac_ma1"),
                    "rack": n.get("rack"),
                }
                for n in sw
            ],
        },
        "bmc": {
            "username_env": "BMC_USERNAME",
            "password_env": "BMC_PASSWORD",
            "protocol": "redfish",
        },
        "images": {
            "base_os": "ubuntu-24.04-server-cloudimg-amd64.img",
            "ironic_kernel": "ironic-python-agent.kernel",
            "ironic_ramdisk": "ironic-python-agent.initramfs",
            "k8s_version": exp.get("k8s_version", "v1.32.2"),
        },
        "source_of_truth": {
            "system": "netbox",
            "export": "bootstrap/netbox/scripts/export_inventory.py",
        },
    }
    return {
        "meta": {
            "source": source,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "inventory": inv,
    }


if __name__ == "__main__":
    raise SystemExit(main())
