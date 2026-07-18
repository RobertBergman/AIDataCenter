#!/usr/bin/env python3
"""Export IPAM snapshot (prefixes + assignments) from NetBox or seed."""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nb_lib import load_seed, netbox_client  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "inventory" / "ipam.yaml",
    )
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()
    seed = load_seed()

    if args.offline:
        data = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "seed/site.yaml",
            "prefixes": seed["ipam"]["prefixes"],
            "gateways": [
                ip for ip in seed["ipam"].get("ip_addresses", []) if "gw-" in ip.get("dns_name", "")
            ],
            "vips": [
                ip
                for ip in seed["ipam"].get("ip_addresses", [])
                if ip.get("role") == "vip" or "api." in ip.get("dns_name", "")
            ],
            "device_ips": [
                {
                    "device": d["name"],
                    "mgmt": d.get("primary_ip4"),
                    "bmc": d.get("bmc_ip"),
                    "role": d["role"],
                }
                for d in seed["devices"]
                if d.get("primary_ip4") or d.get("bmc_ip")
            ],
        }
    else:
        nb = netbox_client()
        prefixes = [
            {
                "prefix": p.prefix,
                "status": str(p.status) if p.status else "",
                "description": p.description or "",
                "vlan": getattr(getattr(p, "vlan", None), "name", None),
            }
            for p in nb.ipam.prefixes.all()
        ]
        ips = []
        for ip in nb.ipam.ip_addresses.all():
            ips.append(
                {
                    "address": ip.address,
                    "dns_name": ip.dns_name or "",
                    "description": ip.description or "",
                    "role": str(ip.role) if ip.role else "",
                }
            )
        data = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "netbox",
            "prefixes": prefixes,
            "ip_addresses": ips,
        }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "# GENERATED from NetBox — do not hand-edit\n"
        + yaml.safe_dump(data, sort_keys=False),
        encoding="utf-8",
    )
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
