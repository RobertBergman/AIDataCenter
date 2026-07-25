#!/usr/bin/env python3
"""Independently re-verify a planner YAML export.

The planner validates its own model in JavaScript before writing the file. This
script deliberately does *not* trust that: it re-derives every check from the
YAML alone, so a bug in the generator shows up as a disagreement rather than as
two copies of the same mistake. That is the whole point of treating the export
as a source of truth instead of a report.

    python planner/tools/validate_design.py dc.yml
    python planner/tools/validate_design.py dc.yml --quiet   # exit code only

Exit codes: 0 clean · 1 findings · 2 could not read the file.
"""

from __future__ import annotations

import argparse
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    print("pyyaml is required: pip install pyyaml", file=sys.stderr)
    raise SystemExit(2)


class Findings:
    def __init__(self) -> None:
        self.items: list[tuple[str, str, str]] = []

    def error(self, code: str, msg: str) -> None:
        self.items.append(("ERROR", code, msg))

    def warn(self, code: str, msg: str) -> None:
        self.items.append((" WARN", code, msg))

    @property
    def errors(self) -> int:
        return sum(1 for s, _, _ in self.items if s == "ERROR")

    @property
    def warnings(self) -> int:
        return sum(1 for s, _, _ in self.items if s == " WARN")


# Endpoints that are facility infrastructure rather than racked devices.
INFRA_KINDS = ("SVC-", "UPS-", "RPP-", "BUSWAY-", "CDU-", "CRAH-", "RDHX-", "PDU-")


def check_schema(doc: dict, f: Findings) -> None:
    required = [
        "schema_version", "site", "room", "cooling", "power",
        "fabric", "racks", "devices", "cables", "totals",
    ]
    for key in required:
        if key not in doc:
            f.error("schema.missing", f"top-level key `{key}` is absent")
    if doc.get("schema_version") != 1:
        f.warn("schema.version", f"unexpected schema_version {doc.get('schema_version')}")


def check_racks(doc: dict, f: Findings) -> None:
    cooling_cap = doc["cooling"].get("per_rack_cap_kw")
    seen_names: Counter[str] = Counter()
    seen_positions: dict[tuple, str] = {}

    for rack in doc.get("racks", []):
        name = rack["name"]
        seen_names[name] += 1
        height = rack["frame"]["u_height"]

        # Elevation must fit and must not double-book a U.
        occupied: dict[int, str] = {}
        used_u = 0
        kw = 0.0
        for dev in rack.get("elevation", []):
            used_u += dev["ru"]
            kw += dev.get("kw", 0) or 0
            if dev["u"] < 1 or dev["u"] + dev["ru"] - 1 > height:
                f.error(
                    "rack.bounds",
                    f"{name}: {dev['name']} spans U{dev['u']}–U{dev['u'] + dev['ru'] - 1} "
                    f"outside a {height}U frame",
                )
            for u in range(dev["u"], dev["u"] + dev["ru"]):
                if u in occupied:
                    f.error("rack.overlap", f"{name}: {dev['name']} collides with {occupied[u]} at U{u}")
                occupied[u] = dev["name"]

        if used_u > height:
            f.error("rack.ru", f"{name}: {used_u}U of equipment in a {height}U frame")
        if abs(used_u - rack["totals"]["u_used"]) > 0:
            f.error(
                "rack.totals",
                f"{name}: totals.u_used={rack['totals']['u_used']} but the elevation sums to {used_u}U",
            )
        if abs(kw - rack["totals"]["kw"]) > 0.05:
            f.error(
                "rack.totals",
                f"{name}: totals.kw={rack['totals']['kw']} but the elevation sums to {kw:.2f} kW",
            )
        if cooling_cap and rack["totals"]["kw"] > cooling_cap:
            f.error(
                "cooling.rack_cap",
                f"{name}: {rack['totals']['kw']} kW exceeds the {cooling_cap} kW/rack cooling ceiling",
            )

        pos = rack.get("position")
        if pos:
            key = (pos["row"], pos["slot"])
            if key in seen_positions:
                f.error("room.collision", f"{name} and {seen_positions[key]} occupy row {key[0]} slot {key[1]}")
            seen_positions[key] = name

    for name, n in seen_names.items():
        if n > 1:
            f.error("rack.duplicate", f"rack name {name} appears {n} times")


def check_cables(doc: dict, f: Findings) -> None:
    devices = {d["name"] for d in doc.get("devices", [])}
    pdus = {p["name"] for p in doc["power"].get("rack_pdus", [])}
    infra = set(pdus)
    for e in doc["power"].get("entrances", []):
        infra.add(e["name"])
    for u in doc["power"]["ups"].get("units", []):
        infra.add(u["name"])
    for d in doc["power"]["distribution"].get("units", []):
        infra.add(d["name"])
    for u in doc["cooling"].get("units", []):
        infra.add(u["name"])
    infra.add("facility-loop")
    known = devices | infra
    rack_names = {r["name"] for r in doc.get("racks", [])}

    labels: Counter[str] = Counter()
    ports: Counter[tuple[str, str]] = Counter()
    media = doc.get("media", {})
    unknown_endpoints: set[str] = set()

    for cable in doc.get("cables", []):
        labels[cable["label"]] += 1
        for end in ("a", "b"):
            ep = cable.get(end) or {}
            dev = ep.get("device")
            if dev is None:
                f.error("cable.endpoint", f"{cable['label']}: side {end} has no device")
                continue
            if dev not in known and not dev.startswith(INFRA_KINDS):
                unknown_endpoints.add(dev)
            ports[(dev, ep.get("port"))] += 1
            rack = ep.get("rack")
            if rack and rack not in rack_names and rack not in {
                "entrance", "electrical", "distribution", "facility",
            } and not rack.startswith("row-") and rack not in infra:
                f.warn("cable.rack", f"{cable['label']}: side {end} names rack `{rack}`, which is not in the rack list")

        spec = media.get(cable.get("media"))
        if cable.get("media") == "UNREACHABLE":
            f.error("cable.reach", f"{cable['label']}: no medium reaches {cable['length_m']} m")
        elif spec is None:
            f.warn("cable.media", f"{cable['label']}: medium `{cable.get('media')}` is not in the media table")
        elif spec.get("max_m") is not None and cable["length_m"] > spec["max_m"]:
            f.error(
                "cable.reach",
                f"{cable['label']}: {cable['length_m']} m on {spec['name']} (max {spec['max_m']} m)",
            )
        if cable["length_m"] <= 0:
            f.warn("cable.length", f"{cable['label']}: zero length")

    for label, n in labels.items():
        if n > 1:
            f.error("cable.duplicate_label", f"label {label} is used {n} times")
    for (dev, port), n in ports.items():
        if n > 1:
            f.error("cable.port_conflict", f"{dev} port {port} is cabled {n} times")
    for dev in sorted(unknown_endpoints):
        f.error("cable.endpoint", f"cable endpoint `{dev}` is not a device or a piece of plant in this document")


def check_power(doc: dict, f: Findings) -> None:
    power = doc["power"]
    totals = doc["totals"]
    it_kw = totals["it_load_kw"]
    facility_kw = totals["facility_load_kw"]
    feeds = power.get("feeds", [])

    # Every entrance must be able to carry the hall alone when A/B is claimed.
    for ent in power.get("entrances", []):
        if len(feeds) >= 2 and ent["capacity_kw"] < facility_kw:
            f.error(
                "power.entrance",
                f"{ent['name']}: {ent['capacity_kw']} kW cannot carry the {facility_kw} kW hall "
                f"when the other service is lost",
            )
    if len(feeds) < 2:
        f.warn("power.redundancy", "only one feed — no A/B diversity")

    firm = power["ups"].get("firm_capacity_per_feed_kw", 0)
    if firm < it_kw:
        f.error("power.ups", f"UPS firm capacity {firm} kW/feed is below the {it_kw} kW IT load")

    for unit in power["distribution"].get("units", []):
        if unit.get("capacity_kw") and unit.get("load_kw", 0) > unit["capacity_kw"]:
            f.error("power.distribution", f"{unit['name']}: {unit['load_kw']} kW on a {unit['capacity_kw']} kW unit")
        if unit.get("poles") and (unit.get("poles_used") or 0) > unit["poles"]:
            f.error("power.poles", f"{unit['name']}: {unit['poles_used']} poles needed, {unit['poles']} available")

    # Each side of a dual-corded rack must carry the whole rack alone.
    rack_kw = {r["name"]: r["totals"]["kw"] for r in doc.get("racks", [])}
    per_side: dict[tuple[str, str], float] = defaultdict(float)
    for pdu in power.get("rack_pdus", []):
        per_side[(pdu["rack"], pdu["feed"])] += pdu["usable_kw"]
    for (rack, feed), capacity in sorted(per_side.items()):
        need = rack_kw.get(rack, 0)
        if capacity + 1e-6 < need:
            f.error(
                "power.rack_pdu",
                f"{rack} feed {feed}: {capacity:.1f} kW of PDU for a rack that draws {need} kW",
            )
    for rack in rack_kw:
        for feed in feeds:
            if (rack, feed) not in per_side:
                f.error("power.rack_pdu", f"{rack} has no {feed}-feed PDU")

    total_rack_kw = sum(rack_kw.values())
    if abs(total_rack_kw - it_kw) > 0.5:
        f.error("power.totals", f"racks sum to {total_rack_kw:.1f} kW but totals.it_load_kw is {it_kw}")


def check_cooling(doc: dict, f: Findings) -> None:
    cooling = doc["cooling"]
    it_kw = doc["totals"]["it_load_kw"]
    if cooling.get("capacity_kw", 0) < it_kw:
        f.error("cooling.capacity", f"{cooling['capacity_kw']} kW of cooling for a {it_kw} kW IT load")

    if cooling["mode"] == "water":
        # Every rack needs a supply and a return.
        served = Counter()
        for cable in doc.get("cables", []):
            if cable.get("class") != "coolant":
                continue
            label = cable["label"]
            if label.startswith("CW-"):
                served[cable["a"]["rack"]] += 1
        for rack in doc.get("racks", []):
            n = served.get(rack["name"], 0)
            if n != 2:
                f.error(
                    "cooling.loop",
                    f"{rack['name']} has {n} coolant runs; a liquid-cooled rack needs exactly 2 (supply + return)",
                )
        dt = cooling.get("delta_t_k")
        if dt and dt <= 0:
            f.error("cooling.delta_t", f"ΔT of {dt} K is not physical")


def check_fabric(doc: dict, f: Findings) -> None:
    # Port budget per switch, counting only front-panel Ethernet ports.
    switches = {d["name"]: d for d in doc.get("devices", []) if d.get("kind") == "switch"}
    used: Counter[str] = Counter()
    for cable in doc.get("cables", []):
        for end in ("a", "b"):
            ep = cable.get(end) or {}
            dev = ep.get("device")
            port = ep.get("port") or ""
            if dev in switches and str(port).startswith("Ethernet"):
                used[dev] += 1
    for name, sw in switches.items():
        capacity = sw.get("ports")
        if capacity and used[name] > capacity + 4:  # +4 allows dedicated uplink cages
            f.error("fabric.ports", f"{name}: {used[name]} cables on a {capacity}-port {sw.get('model')}")

    # Rail identity: NIC k of every host must land on a rail-k leaf.
    if doc["fabric"]["architecture"] == "rail-optimized":
        leaf_rail: dict[str, int] = {}
        for dev in doc.get("devices", []):
            if dev.get("role") == "leaf" and dev.get("rail") is not None:
                leaf_rail[dev["name"]] = dev["rail"]
        for cable in doc.get("cables", []):
            if cable.get("class") != "fabric" or cable.get("rail") is None:
                continue
            leaf = cable["b"]["device"]
            if leaf in leaf_rail and leaf_rail[leaf] != cable["rail"]:
                f.error(
                    "fabric.rail",
                    f"{cable['label']}: rail {cable['rail']} cabled to {leaf}, which is rail {leaf_rail[leaf]}",
                )


def check_totals(doc: dict, f: Findings) -> None:
    totals = doc["totals"]
    cables = doc.get("cables", [])
    if totals.get("cables") != len(cables):
        f.error("totals.cables", f"totals.cables={totals.get('cables')} but {len(cables)} are listed")
    length = sum(c["length_m"] for c in cables)
    if not math.isclose(length, totals.get("cable_length_m", 0), rel_tol=1e-3, abs_tol=0.5):
        f.error("totals.length", f"cable lengths sum to {length:.1f} m, totals say {totals.get('cable_length_m')}")
    devices = doc.get("devices", [])
    racked = sum(len(r.get("elevation", [])) for r in doc.get("racks", []))
    if racked != len(devices):
        f.error("totals.devices", f"{racked} devices in elevations but {len(devices)} in the device list")


def main() -> int:
    ap = argparse.ArgumentParser(description="Re-verify a planner YAML export.")
    ap.add_argument("path", type=Path, help="planner YAML file")
    ap.add_argument("--quiet", action="store_true", help="suppress output, use the exit code")
    args = ap.parse_args()

    try:
        doc = yaml.safe_load(args.path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        print(f"cannot read {args.path}: {exc}", file=sys.stderr)
        return 2

    if not isinstance(doc, dict):
        print(f"{args.path} is not a mapping", file=sys.stderr)
        return 2

    f = Findings()
    check_schema(doc, f)
    if f.errors:  # nothing else is meaningful without the structure
        report(args, doc, f)
        return 1

    check_racks(doc, f)
    check_cables(doc, f)
    check_power(doc, f)
    check_cooling(doc, f)
    check_fabric(doc, f)
    check_totals(doc, f)

    report(args, doc, f)
    return 1 if f.errors else 0


def report(args, doc: dict, f: Findings) -> None:
    if args.quiet:
        return
    site = doc.get("site", {})
    totals = doc.get("totals", {})
    print(f"\n{args.path} — {site.get('name', '?')} / {site.get('room', '?')}")
    if totals:
        print(
            f"  {totals.get('racks')} racks · {totals.get('gpus')} GPUs · "
            f"{totals.get('cables')} cables · {totals.get('it_load_kw')} kW IT"
        )
    for severity, code, msg in f.items:
        print(f"  {severity}  [{code}] {msg}")

    # Cross-check our verdict against the generator's own.
    claimed = doc.get("validation", {})
    if claimed:
        if bool(claimed.get("ok")) != (f.errors == 0):
            print(
                f"  ERROR  [validation.disagreement] the document claims ok={claimed.get('ok')} "
                f"but this check found {f.errors} error(s)"
            )
    print(f"\n{f.errors} error(s), {f.warnings} warning(s)\n")


if __name__ == "__main__":
    raise SystemExit(main())
