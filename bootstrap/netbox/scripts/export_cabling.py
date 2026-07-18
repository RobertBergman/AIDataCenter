#!/usr/bin/env python3
"""Export cabling guide (markdown + CSV) from NetBox or offline seed expansion."""
from __future__ import annotations

import argparse
import csv
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nb_lib import all_cables, load_seed, netbox_client  # noqa: E402


def cables_from_netbox(nb) -> list[dict]:
    rows = []
    for c in nb.dcim.cables.all():
        a = _term(c, "a")
        b = _term(c, "b")
        rows.append(
            {
                "label": c.label or "",
                "status": str(getattr(c, "status", "") or ""),
                "type": "",
                "a_device": a[0],
                "a_iface": a[1],
                "b_device": b[0],
                "b_iface": b[1],
                "description": getattr(c, "description", "") or "",
            }
        )
    return rows


def _term(cable, side: str):
    terms = getattr(cable, f"{side}_terminations", None) or []
    if not terms:
        # older pynetbox
        term = getattr(cable, f"termination_{side}", None)
        if term is None:
            return ("", "")
        dev = getattr(term, "device", None)
        return (
            getattr(dev, "name", "") if dev else "",
            getattr(term, "name", ""),
        )
    t0 = terms[0]
    obj = getattr(t0, "object", None) or t0
    dev = getattr(obj, "device", None)
    return (
        getattr(dev, "name", "") if dev else "",
        getattr(obj, "name", str(obj)),
    )


def cables_offline(seed) -> list[dict]:
    rows = []
    for c in all_cables(seed):
        rows.append(
            {
                "label": c["label"],
                "status": c.get("status", "planned"),
                "type": c.get("type", ""),
                "a_device": c["a"]["device"],
                "a_iface": c["a"]["iface"],
                "b_device": c["b"]["device"],
                "b_iface": c["b"]["iface"],
                "description": c.get("description", ""),
            }
        )
    return rows


def classify(row: dict) -> str:
    a, b = row["a_iface"], row["b_iface"]
    if a.startswith("rail") or b.startswith("rail"):
        return "fabric-host-leaf"
    if "Ethernet" in a and "Ethernet" in b and (
        "leaf-rail" in row["a_device"] or "leaf-rail" in row["b_device"]
    ) and ("spine" in row["a_device"] or "spine" in row["b_device"]):
        return "fabric-leaf-spine"
    if a == "bmc" or b == "bmc":
        return "oob-bmc"
    return "other"


def render_md(rows: list[dict], source: str) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    by = {}
    for r in rows:
        by.setdefault(classify(r), []).append(r)

    def table(items):
        lines = [
            "| Label | A device | A port | B device | B port | Type | Status |",
            "| ----- | -------- | ------ | -------- | ------ | ---- | ------ |",
        ]
        for r in sorted(items, key=lambda x: x["label"]):
            lines.append(
                f"| `{r['label']}` | {r['a_device']} | `{r['a_iface']}` | "
                f"{r['b_device']} | `{r['b_iface']}` | {r.get('type','')} | {r.get('status','')} |"
            )
        return "\n".join(lines)

    fabric = by.get("fabric-host-leaf", [])
    ls = by.get("fabric-leaf-spine", [])
    oob = by.get("oob-bmc", [])

    return f"""# Cabling Guide — 64× B200 AI Cluster

> **Source of truth:** NetBox (`{source}`)  
> **Generated:** {now}  
> Regenerate: `python3 bootstrap/netbox/scripts/export_cabling.py`

Do not maintain this file by hand. Update NetBox (or `bootstrap/netbox/seed/site.yaml` pre-go-live), then re-export.

---

## 1. Design rules (SPEC §5)

| Rule | Practice |
| ---- | -------- |
| Rail identity | `workerXX.rail{{i}}` → `leaf-rail{{i}}` for **all** workers |
| Host media | 400G DAC QSFP-DD (short; leaf in same/near rack) |
| Leaf↔spine | 400G AOC/fiber; 8 uplinks/leaf (4 per spine) |
| OOB | BMC → 7010TX-48 only; **no** RoCE on OOB |
| Spines | Prefer **BOOT** rack |
| Leaves | Split GPU-1 (rail0–3) / GPU-2 (rail4–7) |

```
  workerN.rail0 ────── leaf-rail0 ══╦══ spine1
  workerN.rail1 ────── leaf-rail1 ═╗║
  ...                              ╠╬═ spine2
  workerN.rail7 ────── leaf-rail7 ═╝║
```

---

## 2. Summary counts

| Class | Cables |
| ----- | -----: |
| Host ↔ rail leaf (8 workers × 8 rails) | **{len(fabric)}** |
| Rail leaf ↔ spine | **{len(ls)}** |
| BMC ↔ OOB | **{len(oob)}** |
| **Total** | **{len(rows)}** |

---

## 3. Host ↔ rail leaf (GPU fabric)

Port map: **worker index 1..8 → leaf `Ethernet1..8`**.

{table(fabric) if fabric else "_No cables_"}

### Install checklist (rail {{i}})

For each rail leaf `leaf-rail{{i}}`:

1. Confirm leaf is powered and `Management1` on OOB.  
2. Patch `Ethernet1`…`Ethernet8` to `worker01`…`worker08` port `rail{{i}}` using labels `R{{i}}-W01` … `R{{i}}-W08`.  
3. Dress DACs for service loops; no sharp bend radius < manufacturer min.  
4. Validate link LEDs both ends; record serials in NetBox.

---

## 4. Leaf ↔ spine

Default: leaf ports **Ethernet17–24** uplinks; spine ports blocked by rail (4 ports/rail/spine).

{table(ls) if ls else "_No cables_"}

---

## 5. OOB (BMC → 7010TX-48)

| Rack | OOB switch |
| ---- | ---------- |
| GPU-1, BOOT | oob-sw1 |
| GPU-2, STOR | oob-sw2 |

{table(oob) if oob else "_No cables_"}

---

## 6. Labeling convention

| Pattern | Meaning |
| ------- | ------- |
| `R{{rail}}-W{{nn}}` | Host fabric |
| `L{{rail}}S{{spine}}-U{{n}}` | Leaf–spine uplink |
| `OOB-{{device}}` | BMC |

Print both ends; enter QR/barcode into NetBox cable `label` field on install (status → connected).

---

## 7. Acceptance

- [ ] NetBox cable status `connected` matches physical light  
- [ ] `export_inventory.py` shows all mgmt MACs after neighbor discovery (optional)  
- [ ] No host rail cable lands on wrong rail leaf (audit by label)  
- [ ] OOB-only path from jump to every BMC  

---

## Revision

| Version | Date | Notes |
| ------- | ---- | ----- |
| 0.1 | 2026-07-18 | Initial export format |
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--output", type=Path, default=Path("docs/cabling.md"))
    ap.add_argument("--csv", type=Path, default=None)
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()

    seed = load_seed()
    if args.offline:
        rows = cables_offline(seed)
        source = "seed/site.yaml (offline)"
    else:
        try:
            nb = netbox_client()
            rows = cables_from_netbox(nb)
            source = "NetBox API"
            if not rows:
                rows = cables_offline(seed)
                source = "NetBox empty — fell back to seed expansion"
        except SystemExit:
            rows = cables_offline(seed)
            source = "seed/site.yaml (no token — offline)"

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_md(rows, source), encoding="utf-8")
    print(f"Wrote {args.output} ({len(rows)} cables)")

    if args.csv:
        args.csv.parent.mkdir(parents=True, exist_ok=True)
        with args.csv.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(
                f,
                fieldnames=[
                    "label",
                    "class",
                    "a_device",
                    "a_iface",
                    "b_device",
                    "b_iface",
                    "type",
                    "status",
                    "description",
                ],
            )
            w.writeheader()
            for r in rows:
                w.writerow({**r, "class": classify(r)})
        print(f"Wrote {args.csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
