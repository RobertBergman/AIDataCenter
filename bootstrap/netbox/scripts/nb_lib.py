#!/usr/bin/env python3
"""Shared helpers for NetBox seed import/export."""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
SEED_PATH = ROOT / "seed" / "site.yaml"


def load_seed(path: Path | None = None) -> dict[str, Any]:
    p = path or SEED_PATH
    with p.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def netbox_client():
    try:
        import pynetbox
    except ImportError as e:
        print("Install deps: pip install -r bootstrap/netbox/requirements.txt", file=sys.stderr)
        raise SystemExit(1) from e

    url = os.environ.get("NETBOX_URL", "http://127.0.0.1:8081")
    token = os.environ.get("NETBOX_TOKEN")
    if not token:
        print("Set NETBOX_TOKEN", file=sys.stderr)
        raise SystemExit(2)
    nb = pynetbox.api(url, token=token)
    nb.http_session.verify = os.environ.get("NETBOX_SSL_VERIFY", "true").lower() in (
        "1",
        "true",
        "yes",
    )
    return nb


def ensure(endpoint, lookup: dict, payload: dict):
    """Get-or-create on a pynetbox endpoint using lookup filters."""
    existing = endpoint.get(**lookup)
    if existing:
        # shallow update when keys differ
        dirty = False
        for k, v in payload.items():
            if k in lookup:
                continue
            cur = existing.get(k) if hasattr(existing, "get") else getattr(existing, k, None)
            if hasattr(cur, "id"):
                cur = cur.id
            if isinstance(cur, dict) and "id" in cur:
                cur = cur["id"]
            if cur != v and v is not None:
                setattr(existing, k, v)
                dirty = True
        if dirty:
            existing.save()
        return existing
    return endpoint.create(payload)


def ip_only(cidr: str | None) -> str | None:
    if not cidr:
        return None
    return cidr.split("/")[0]


def expand_gpu_interfaces(device: dict) -> list[dict]:
    """Ensure mgmt0, bmc, rail0-7 exist for GPU workers."""
    ifaces = list(device.get("interfaces") or [])
    names = {i["name"] for i in ifaces}
    role = device.get("role") or ""
    if role == "gpu-worker":
        idx = int(device["name"].replace("worker", ""))
        base = f"00:00:00:00:{idx:02x}"
        if "mgmt0" not in names:
            ifaces.append(
                {
                    "name": "mgmt0",
                    "type": "1000base-t",
                    "mac": f"{base}:01",
                }
            )
        if "bmc" not in names:
            ifaces.append(
                {
                    "name": "bmc",
                    "type": "1000base-t",
                    "mac": f"{base}:02",
                    "mgmt_only": True,
                }
            )
        for r in range(8):
            n = f"rail{r}"
            if n not in names:
                ifaces.append(
                    {
                        "name": n,
                        "type": "400gbase-x-qsfpdd",
                        "mac": f"{base}:{10 + r:02x}",
                        "description": f"GPU{r} 400G rail-{r}",
                        "label": f"GPU{r}/NIC{r}",
                    }
                )
    return ifaces


def expand_switch_interfaces(device: dict) -> list[dict]:
    ifaces = list(device.get("interfaces") or [])
    names = {i["name"] for i in ifaces}
    role = device.get("role") or ""
    if role == "rail-leaf":
        for p in range(1, 33):
            n = f"Ethernet{p}"
            if n not in names:
                ifaces.append(
                    {
                        "name": n,
                        "type": "400gbase-x-qsfpdd",
                        "description": f"front-panel {p}",
                    }
                )
        if "Management1" not in names:
            ifaces.append({"name": "Management1", "type": "1000base-t", "mgmt_only": True})
    elif role == "spine":
        for p in range(1, 65):
            n = f"Ethernet{p}"
            if n not in names:
                ifaces.append(
                    {
                        "name": n,
                        "type": "400gbase-x-qsfpdd",
                        "description": f"front-panel {p}",
                    }
                )
        if "Management1" not in names:
            ifaces.append({"name": "Management1", "type": "1000base-t", "mgmt_only": True})
    elif role == "oob-switch":
        for p in range(1, 49):
            n = f"Ethernet{p}"
            if n not in names:
                ifaces.append({"name": n, "type": "1000base-t", "description": f"port {p}"})
        if "Management1" not in names:
            ifaces.append({"name": "Management1", "type": "1000base-t", "mgmt_only": True})
    return ifaces


def build_fabric_cables(seed: dict) -> list[dict]:
    """worker rail_i -> leaf-rail{i} Ethernet{worker_index}."""
    workers = sorted(
        [d for d in seed["devices"] if d["role"] == "gpu-worker"],
        key=lambda d: d["name"],
    )
    leaves = {
        int(d.get("custom_fields", {}).get("rail_index", d["name"].replace("leaf-rail", ""))): d[
            "name"
        ]
        for d in seed["devices"]
        if d["role"] == "rail-leaf"
    }
    pol = seed["cabling_policy"]["fabric"]
    cables = []
    for w_i, w in enumerate(workers, start=1):
        for rail in range(8):
            leaf = leaves[rail]
            label = pol["label_template"].format(rail=rail, worker=w_i)
            cables.append(
                {
                    "label": label,
                    "type": pol["media"],
                    "color": pol.get("color"),
                    "status": "planned",
                    "a": {"device": w["name"], "iface": f"rail{rail}"},
                    "b": {"device": leaf, "iface": f"Ethernet{w_i}"},
                    "description": f"GPU rail {rail}: {w['name']} → {leaf}",
                }
            )
    return cables


def build_leaf_spine_cables(seed: dict) -> list[dict]:
    """8 uplinks per leaf: 4→spine1, 4→spine2. Leaf ports Ethernet17-24."""
    pol = seed["cabling_policy"]["leaf_spine"]
    n_up = int(pol["uplinks_per_leaf"])
    leaves = sorted(
        [d for d in seed["devices"] if d["role"] == "rail-leaf"],
        key=lambda d: int(d.get("custom_fields", {}).get("rail_index", 0)),
    )
    spines = sorted([d["name"] for d in seed["devices"] if d["role"] == "spine"])
    cables = []
    for leaf in leaves:
        rail = int(leaf.get("custom_fields", {}).get("rail_index", 0))
        for u in range(n_up):
            spine_i = u % 2  # alternate spines
            spine = spines[spine_i]
            # leaf uplink ports start at 17
            leaf_port = 17 + u
            # spine port allocation: rail * 4 + (u//2) + 1  within each spine's rail block
            spine_port = rail * 4 + (u // 2) + 1
            label = pol["label_template"].format(rail=rail, spine=spine_i + 1, uplink=u + 1)
            cables.append(
                {
                    "label": label,
                    "type": pol["media"],
                    "color": pol.get("color"),
                    "status": "planned",
                    "a": {"device": leaf["name"], "iface": f"Ethernet{leaf_port}"},
                    "b": {"device": spine, "iface": f"Ethernet{spine_port}"},
                    "description": f"leaf-spine rail{rail} u{u + 1}",
                }
            )
    return cables


def build_oob_cables(seed: dict) -> list[dict]:
    """BMC of servers → rack OOB switch."""
    pol = seed["cabling_policy"]["oob"]
    rack_oob = {"GPU-1": "oob-sw1", "GPU-2": "oob-sw2", "BOOT": "oob-sw1", "STOR": "oob-sw2"}
    port_cursor = {s: 1 for s in rack_oob.values()}
    cables = []
    for d in seed["devices"]:
        if not d.get("bmc_ip"):
            continue
        oob = rack_oob.get(d["rack"])
        if not oob:
            continue
        port = port_cursor[oob]
        port_cursor[oob] = port + 1
        label = pol["label_template"].format(device=d["name"])
        cables.append(
            {
                "label": label,
                "type": pol["media"],
                "color": pol.get("color"),
                "status": "planned",
                "a": {"device": d["name"], "iface": "bmc"},
                "b": {"device": oob, "iface": f"Ethernet{port}"},
                "description": f"BMC {d['name']} → {oob}",
            }
        )
    return cables


def all_cables(seed: dict) -> list[dict]:
    return build_fabric_cables(seed) + build_leaf_spine_cables(seed) + build_oob_cables(seed)
