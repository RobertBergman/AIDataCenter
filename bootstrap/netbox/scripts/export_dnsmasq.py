#!/usr/bin/env python3
"""Export dnsmasq dhcp-host lines from NetBox (or generated inventory)."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nb_lib import load_seed  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--inventory",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "inventory" / "cluster.yaml",
    )
    ap.add_argument("-o", "--output", type=Path, default=None)
    ap.add_argument("--offline", action="store_true", help="Use seed if inventory missing")
    args = ap.parse_args()

    if args.inventory.exists() and not args.offline:
        inv = yaml.safe_load(args.inventory.read_text(encoding="utf-8"))
    else:
        # generate offline inventory in-memory
        from export_inventory import main as exp_main
        import tempfile

        tmp = Path(tempfile.mkdtemp()) / "cluster.yaml"
        sys.argv = ["export_inventory.py", "--offline", "-o", str(tmp)]
        exp_main()
        inv = yaml.safe_load(tmp.read_text(encoding="utf-8"))

    domain = inv["cluster"]["domain"]
    lines = ["# GENERATED from NetBox inventory — dhcp-host static leases", f"# domain {domain}"]
    for group in ("control_plane", "utility", "gpu_workers"):
        nodes = inv.get(group, {}).get("nodes") or []
        for n in nodes:
            mac = n.get("mac_mgmt")
            ip = n.get("ip")
            name = n.get("name")
            if mac and ip and name:
                lines.append(f"dhcp-host={mac},{ip},{name},infinite")

    seed = inv.get("seed", {})
    if seed.get("ip"):
        lines.append(f"# seed {seed.get('hostname')} {seed.get('ip')} (server — not dhcp client)")

    text = "\n".join(lines) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
        print(f"Wrote {args.output}")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
