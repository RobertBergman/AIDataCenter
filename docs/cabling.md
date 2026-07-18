# Cabling Guide — 64× B200 AI Cluster

> **Source of truth:** NetBox (`seed/site.yaml (offline)`)  
> **Generated:** 2026-07-18 19:10 UTC  
> Regenerate: `python3 bootstrap/netbox/scripts/export_cabling.py`

Do not maintain this file by hand. Update NetBox (or `bootstrap/netbox/seed/site.yaml` pre-go-live), then re-export.

---

## 1. Design rules (SPEC §5)

| Rule | Practice |
| ---- | -------- |
| Rail identity | `workerXX.rail{i}` → `leaf-rail{i}` for **all** workers |
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
| Host ↔ rail leaf (8 workers × 8 rails) | **64** |
| Rail leaf ↔ spine | **64** |
| BMC ↔ OOB | **14** |
| **Total** | **142** |

---

## 3. Host ↔ rail leaf (GPU fabric)

Port map: **worker index 1..8 → leaf `Ethernet1..8`**.

| Label | A device | A port | B device | B port | Type | Status |
| ----- | -------- | ------ | -------- | ------ | ---- | ------ |
| `R0-W01` | worker01 | `rail0` | leaf-rail0 | `Ethernet1` | dac-qsfpdd-400g | planned |
| `R0-W02` | worker02 | `rail0` | leaf-rail0 | `Ethernet2` | dac-qsfpdd-400g | planned |
| `R0-W03` | worker03 | `rail0` | leaf-rail0 | `Ethernet3` | dac-qsfpdd-400g | planned |
| `R0-W04` | worker04 | `rail0` | leaf-rail0 | `Ethernet4` | dac-qsfpdd-400g | planned |
| `R0-W05` | worker05 | `rail0` | leaf-rail0 | `Ethernet5` | dac-qsfpdd-400g | planned |
| `R0-W06` | worker06 | `rail0` | leaf-rail0 | `Ethernet6` | dac-qsfpdd-400g | planned |
| `R0-W07` | worker07 | `rail0` | leaf-rail0 | `Ethernet7` | dac-qsfpdd-400g | planned |
| `R0-W08` | worker08 | `rail0` | leaf-rail0 | `Ethernet8` | dac-qsfpdd-400g | planned |
| `R1-W01` | worker01 | `rail1` | leaf-rail1 | `Ethernet1` | dac-qsfpdd-400g | planned |
| `R1-W02` | worker02 | `rail1` | leaf-rail1 | `Ethernet2` | dac-qsfpdd-400g | planned |
| `R1-W03` | worker03 | `rail1` | leaf-rail1 | `Ethernet3` | dac-qsfpdd-400g | planned |
| `R1-W04` | worker04 | `rail1` | leaf-rail1 | `Ethernet4` | dac-qsfpdd-400g | planned |
| `R1-W05` | worker05 | `rail1` | leaf-rail1 | `Ethernet5` | dac-qsfpdd-400g | planned |
| `R1-W06` | worker06 | `rail1` | leaf-rail1 | `Ethernet6` | dac-qsfpdd-400g | planned |
| `R1-W07` | worker07 | `rail1` | leaf-rail1 | `Ethernet7` | dac-qsfpdd-400g | planned |
| `R1-W08` | worker08 | `rail1` | leaf-rail1 | `Ethernet8` | dac-qsfpdd-400g | planned |
| `R2-W01` | worker01 | `rail2` | leaf-rail2 | `Ethernet1` | dac-qsfpdd-400g | planned |
| `R2-W02` | worker02 | `rail2` | leaf-rail2 | `Ethernet2` | dac-qsfpdd-400g | planned |
| `R2-W03` | worker03 | `rail2` | leaf-rail2 | `Ethernet3` | dac-qsfpdd-400g | planned |
| `R2-W04` | worker04 | `rail2` | leaf-rail2 | `Ethernet4` | dac-qsfpdd-400g | planned |
| `R2-W05` | worker05 | `rail2` | leaf-rail2 | `Ethernet5` | dac-qsfpdd-400g | planned |
| `R2-W06` | worker06 | `rail2` | leaf-rail2 | `Ethernet6` | dac-qsfpdd-400g | planned |
| `R2-W07` | worker07 | `rail2` | leaf-rail2 | `Ethernet7` | dac-qsfpdd-400g | planned |
| `R2-W08` | worker08 | `rail2` | leaf-rail2 | `Ethernet8` | dac-qsfpdd-400g | planned |
| `R3-W01` | worker01 | `rail3` | leaf-rail3 | `Ethernet1` | dac-qsfpdd-400g | planned |
| `R3-W02` | worker02 | `rail3` | leaf-rail3 | `Ethernet2` | dac-qsfpdd-400g | planned |
| `R3-W03` | worker03 | `rail3` | leaf-rail3 | `Ethernet3` | dac-qsfpdd-400g | planned |
| `R3-W04` | worker04 | `rail3` | leaf-rail3 | `Ethernet4` | dac-qsfpdd-400g | planned |
| `R3-W05` | worker05 | `rail3` | leaf-rail3 | `Ethernet5` | dac-qsfpdd-400g | planned |
| `R3-W06` | worker06 | `rail3` | leaf-rail3 | `Ethernet6` | dac-qsfpdd-400g | planned |
| `R3-W07` | worker07 | `rail3` | leaf-rail3 | `Ethernet7` | dac-qsfpdd-400g | planned |
| `R3-W08` | worker08 | `rail3` | leaf-rail3 | `Ethernet8` | dac-qsfpdd-400g | planned |
| `R4-W01` | worker01 | `rail4` | leaf-rail4 | `Ethernet1` | dac-qsfpdd-400g | planned |
| `R4-W02` | worker02 | `rail4` | leaf-rail4 | `Ethernet2` | dac-qsfpdd-400g | planned |
| `R4-W03` | worker03 | `rail4` | leaf-rail4 | `Ethernet3` | dac-qsfpdd-400g | planned |
| `R4-W04` | worker04 | `rail4` | leaf-rail4 | `Ethernet4` | dac-qsfpdd-400g | planned |
| `R4-W05` | worker05 | `rail4` | leaf-rail4 | `Ethernet5` | dac-qsfpdd-400g | planned |
| `R4-W06` | worker06 | `rail4` | leaf-rail4 | `Ethernet6` | dac-qsfpdd-400g | planned |
| `R4-W07` | worker07 | `rail4` | leaf-rail4 | `Ethernet7` | dac-qsfpdd-400g | planned |
| `R4-W08` | worker08 | `rail4` | leaf-rail4 | `Ethernet8` | dac-qsfpdd-400g | planned |
| `R5-W01` | worker01 | `rail5` | leaf-rail5 | `Ethernet1` | dac-qsfpdd-400g | planned |
| `R5-W02` | worker02 | `rail5` | leaf-rail5 | `Ethernet2` | dac-qsfpdd-400g | planned |
| `R5-W03` | worker03 | `rail5` | leaf-rail5 | `Ethernet3` | dac-qsfpdd-400g | planned |
| `R5-W04` | worker04 | `rail5` | leaf-rail5 | `Ethernet4` | dac-qsfpdd-400g | planned |
| `R5-W05` | worker05 | `rail5` | leaf-rail5 | `Ethernet5` | dac-qsfpdd-400g | planned |
| `R5-W06` | worker06 | `rail5` | leaf-rail5 | `Ethernet6` | dac-qsfpdd-400g | planned |
| `R5-W07` | worker07 | `rail5` | leaf-rail5 | `Ethernet7` | dac-qsfpdd-400g | planned |
| `R5-W08` | worker08 | `rail5` | leaf-rail5 | `Ethernet8` | dac-qsfpdd-400g | planned |
| `R6-W01` | worker01 | `rail6` | leaf-rail6 | `Ethernet1` | dac-qsfpdd-400g | planned |
| `R6-W02` | worker02 | `rail6` | leaf-rail6 | `Ethernet2` | dac-qsfpdd-400g | planned |
| `R6-W03` | worker03 | `rail6` | leaf-rail6 | `Ethernet3` | dac-qsfpdd-400g | planned |
| `R6-W04` | worker04 | `rail6` | leaf-rail6 | `Ethernet4` | dac-qsfpdd-400g | planned |
| `R6-W05` | worker05 | `rail6` | leaf-rail6 | `Ethernet5` | dac-qsfpdd-400g | planned |
| `R6-W06` | worker06 | `rail6` | leaf-rail6 | `Ethernet6` | dac-qsfpdd-400g | planned |
| `R6-W07` | worker07 | `rail6` | leaf-rail6 | `Ethernet7` | dac-qsfpdd-400g | planned |
| `R6-W08` | worker08 | `rail6` | leaf-rail6 | `Ethernet8` | dac-qsfpdd-400g | planned |
| `R7-W01` | worker01 | `rail7` | leaf-rail7 | `Ethernet1` | dac-qsfpdd-400g | planned |
| `R7-W02` | worker02 | `rail7` | leaf-rail7 | `Ethernet2` | dac-qsfpdd-400g | planned |
| `R7-W03` | worker03 | `rail7` | leaf-rail7 | `Ethernet3` | dac-qsfpdd-400g | planned |
| `R7-W04` | worker04 | `rail7` | leaf-rail7 | `Ethernet4` | dac-qsfpdd-400g | planned |
| `R7-W05` | worker05 | `rail7` | leaf-rail7 | `Ethernet5` | dac-qsfpdd-400g | planned |
| `R7-W06` | worker06 | `rail7` | leaf-rail7 | `Ethernet6` | dac-qsfpdd-400g | planned |
| `R7-W07` | worker07 | `rail7` | leaf-rail7 | `Ethernet7` | dac-qsfpdd-400g | planned |
| `R7-W08` | worker08 | `rail7` | leaf-rail7 | `Ethernet8` | dac-qsfpdd-400g | planned |

### Install checklist (rail {i})

For each rail leaf `leaf-rail{i}`:

1. Confirm leaf is powered and `Management1` on OOB.  
2. Patch `Ethernet1`…`Ethernet8` to `worker01`…`worker08` port `rail{i}` using labels `R{i}-W01` … `R{i}-W08`.  
3. Dress DACs for service loops; no sharp bend radius < manufacturer min.  
4. Validate link LEDs both ends; record serials in NetBox.

---

## 4. Leaf ↔ spine

Default: leaf ports **Ethernet17–24** uplinks; spine ports blocked by rail (4 ports/rail/spine).

| Label | A device | A port | B device | B port | Type | Status |
| ----- | -------- | ------ | -------- | ------ | ---- | ------ |
| `L0S1-U1` | leaf-rail0 | `Ethernet17` | spine1 | `Ethernet1` | aoc-qsfpdd-400g | planned |
| `L0S1-U3` | leaf-rail0 | `Ethernet19` | spine1 | `Ethernet2` | aoc-qsfpdd-400g | planned |
| `L0S1-U5` | leaf-rail0 | `Ethernet21` | spine1 | `Ethernet3` | aoc-qsfpdd-400g | planned |
| `L0S1-U7` | leaf-rail0 | `Ethernet23` | spine1 | `Ethernet4` | aoc-qsfpdd-400g | planned |
| `L0S2-U2` | leaf-rail0 | `Ethernet18` | spine2 | `Ethernet1` | aoc-qsfpdd-400g | planned |
| `L0S2-U4` | leaf-rail0 | `Ethernet20` | spine2 | `Ethernet2` | aoc-qsfpdd-400g | planned |
| `L0S2-U6` | leaf-rail0 | `Ethernet22` | spine2 | `Ethernet3` | aoc-qsfpdd-400g | planned |
| `L0S2-U8` | leaf-rail0 | `Ethernet24` | spine2 | `Ethernet4` | aoc-qsfpdd-400g | planned |
| `L1S1-U1` | leaf-rail1 | `Ethernet17` | spine1 | `Ethernet5` | aoc-qsfpdd-400g | planned |
| `L1S1-U3` | leaf-rail1 | `Ethernet19` | spine1 | `Ethernet6` | aoc-qsfpdd-400g | planned |
| `L1S1-U5` | leaf-rail1 | `Ethernet21` | spine1 | `Ethernet7` | aoc-qsfpdd-400g | planned |
| `L1S1-U7` | leaf-rail1 | `Ethernet23` | spine1 | `Ethernet8` | aoc-qsfpdd-400g | planned |
| `L1S2-U2` | leaf-rail1 | `Ethernet18` | spine2 | `Ethernet5` | aoc-qsfpdd-400g | planned |
| `L1S2-U4` | leaf-rail1 | `Ethernet20` | spine2 | `Ethernet6` | aoc-qsfpdd-400g | planned |
| `L1S2-U6` | leaf-rail1 | `Ethernet22` | spine2 | `Ethernet7` | aoc-qsfpdd-400g | planned |
| `L1S2-U8` | leaf-rail1 | `Ethernet24` | spine2 | `Ethernet8` | aoc-qsfpdd-400g | planned |
| `L2S1-U1` | leaf-rail2 | `Ethernet17` | spine1 | `Ethernet9` | aoc-qsfpdd-400g | planned |
| `L2S1-U3` | leaf-rail2 | `Ethernet19` | spine1 | `Ethernet10` | aoc-qsfpdd-400g | planned |
| `L2S1-U5` | leaf-rail2 | `Ethernet21` | spine1 | `Ethernet11` | aoc-qsfpdd-400g | planned |
| `L2S1-U7` | leaf-rail2 | `Ethernet23` | spine1 | `Ethernet12` | aoc-qsfpdd-400g | planned |
| `L2S2-U2` | leaf-rail2 | `Ethernet18` | spine2 | `Ethernet9` | aoc-qsfpdd-400g | planned |
| `L2S2-U4` | leaf-rail2 | `Ethernet20` | spine2 | `Ethernet10` | aoc-qsfpdd-400g | planned |
| `L2S2-U6` | leaf-rail2 | `Ethernet22` | spine2 | `Ethernet11` | aoc-qsfpdd-400g | planned |
| `L2S2-U8` | leaf-rail2 | `Ethernet24` | spine2 | `Ethernet12` | aoc-qsfpdd-400g | planned |
| `L3S1-U1` | leaf-rail3 | `Ethernet17` | spine1 | `Ethernet13` | aoc-qsfpdd-400g | planned |
| `L3S1-U3` | leaf-rail3 | `Ethernet19` | spine1 | `Ethernet14` | aoc-qsfpdd-400g | planned |
| `L3S1-U5` | leaf-rail3 | `Ethernet21` | spine1 | `Ethernet15` | aoc-qsfpdd-400g | planned |
| `L3S1-U7` | leaf-rail3 | `Ethernet23` | spine1 | `Ethernet16` | aoc-qsfpdd-400g | planned |
| `L3S2-U2` | leaf-rail3 | `Ethernet18` | spine2 | `Ethernet13` | aoc-qsfpdd-400g | planned |
| `L3S2-U4` | leaf-rail3 | `Ethernet20` | spine2 | `Ethernet14` | aoc-qsfpdd-400g | planned |
| `L3S2-U6` | leaf-rail3 | `Ethernet22` | spine2 | `Ethernet15` | aoc-qsfpdd-400g | planned |
| `L3S2-U8` | leaf-rail3 | `Ethernet24` | spine2 | `Ethernet16` | aoc-qsfpdd-400g | planned |
| `L4S1-U1` | leaf-rail4 | `Ethernet17` | spine1 | `Ethernet17` | aoc-qsfpdd-400g | planned |
| `L4S1-U3` | leaf-rail4 | `Ethernet19` | spine1 | `Ethernet18` | aoc-qsfpdd-400g | planned |
| `L4S1-U5` | leaf-rail4 | `Ethernet21` | spine1 | `Ethernet19` | aoc-qsfpdd-400g | planned |
| `L4S1-U7` | leaf-rail4 | `Ethernet23` | spine1 | `Ethernet20` | aoc-qsfpdd-400g | planned |
| `L4S2-U2` | leaf-rail4 | `Ethernet18` | spine2 | `Ethernet17` | aoc-qsfpdd-400g | planned |
| `L4S2-U4` | leaf-rail4 | `Ethernet20` | spine2 | `Ethernet18` | aoc-qsfpdd-400g | planned |
| `L4S2-U6` | leaf-rail4 | `Ethernet22` | spine2 | `Ethernet19` | aoc-qsfpdd-400g | planned |
| `L4S2-U8` | leaf-rail4 | `Ethernet24` | spine2 | `Ethernet20` | aoc-qsfpdd-400g | planned |
| `L5S1-U1` | leaf-rail5 | `Ethernet17` | spine1 | `Ethernet21` | aoc-qsfpdd-400g | planned |
| `L5S1-U3` | leaf-rail5 | `Ethernet19` | spine1 | `Ethernet22` | aoc-qsfpdd-400g | planned |
| `L5S1-U5` | leaf-rail5 | `Ethernet21` | spine1 | `Ethernet23` | aoc-qsfpdd-400g | planned |
| `L5S1-U7` | leaf-rail5 | `Ethernet23` | spine1 | `Ethernet24` | aoc-qsfpdd-400g | planned |
| `L5S2-U2` | leaf-rail5 | `Ethernet18` | spine2 | `Ethernet21` | aoc-qsfpdd-400g | planned |
| `L5S2-U4` | leaf-rail5 | `Ethernet20` | spine2 | `Ethernet22` | aoc-qsfpdd-400g | planned |
| `L5S2-U6` | leaf-rail5 | `Ethernet22` | spine2 | `Ethernet23` | aoc-qsfpdd-400g | planned |
| `L5S2-U8` | leaf-rail5 | `Ethernet24` | spine2 | `Ethernet24` | aoc-qsfpdd-400g | planned |
| `L6S1-U1` | leaf-rail6 | `Ethernet17` | spine1 | `Ethernet25` | aoc-qsfpdd-400g | planned |
| `L6S1-U3` | leaf-rail6 | `Ethernet19` | spine1 | `Ethernet26` | aoc-qsfpdd-400g | planned |
| `L6S1-U5` | leaf-rail6 | `Ethernet21` | spine1 | `Ethernet27` | aoc-qsfpdd-400g | planned |
| `L6S1-U7` | leaf-rail6 | `Ethernet23` | spine1 | `Ethernet28` | aoc-qsfpdd-400g | planned |
| `L6S2-U2` | leaf-rail6 | `Ethernet18` | spine2 | `Ethernet25` | aoc-qsfpdd-400g | planned |
| `L6S2-U4` | leaf-rail6 | `Ethernet20` | spine2 | `Ethernet26` | aoc-qsfpdd-400g | planned |
| `L6S2-U6` | leaf-rail6 | `Ethernet22` | spine2 | `Ethernet27` | aoc-qsfpdd-400g | planned |
| `L6S2-U8` | leaf-rail6 | `Ethernet24` | spine2 | `Ethernet28` | aoc-qsfpdd-400g | planned |
| `L7S1-U1` | leaf-rail7 | `Ethernet17` | spine1 | `Ethernet29` | aoc-qsfpdd-400g | planned |
| `L7S1-U3` | leaf-rail7 | `Ethernet19` | spine1 | `Ethernet30` | aoc-qsfpdd-400g | planned |
| `L7S1-U5` | leaf-rail7 | `Ethernet21` | spine1 | `Ethernet31` | aoc-qsfpdd-400g | planned |
| `L7S1-U7` | leaf-rail7 | `Ethernet23` | spine1 | `Ethernet32` | aoc-qsfpdd-400g | planned |
| `L7S2-U2` | leaf-rail7 | `Ethernet18` | spine2 | `Ethernet29` | aoc-qsfpdd-400g | planned |
| `L7S2-U4` | leaf-rail7 | `Ethernet20` | spine2 | `Ethernet30` | aoc-qsfpdd-400g | planned |
| `L7S2-U6` | leaf-rail7 | `Ethernet22` | spine2 | `Ethernet31` | aoc-qsfpdd-400g | planned |
| `L7S2-U8` | leaf-rail7 | `Ethernet24` | spine2 | `Ethernet32` | aoc-qsfpdd-400g | planned |

---

## 5. OOB (BMC → 7010TX-48)

| Rack | OOB switch |
| ---- | ---------- |
| GPU-1, BOOT | oob-sw1 |
| GPU-2, STOR | oob-sw2 |

| Label | A device | A port | B device | B port | Type | Status |
| ----- | -------- | ------ | -------- | ------ | ---- | ------ |
| `OOB-cp01` | cp01 | `bmc` | oob-sw1 | `Ethernet1` | cat6 | planned |
| `OOB-cp02` | cp02 | `bmc` | oob-sw1 | `Ethernet2` | cat6 | planned |
| `OOB-cp03` | cp03 | `bmc` | oob-sw1 | `Ethernet3` | cat6 | planned |
| `OOB-util01` | util01 | `bmc` | oob-sw1 | `Ethernet4` | cat6 | planned |
| `OOB-util02` | util02 | `bmc` | oob-sw1 | `Ethernet5` | cat6 | planned |
| `OOB-util03` | util03 | `bmc` | oob-sw1 | `Ethernet6` | cat6 | planned |
| `OOB-worker01` | worker01 | `bmc` | oob-sw1 | `Ethernet7` | cat6 | planned |
| `OOB-worker02` | worker02 | `bmc` | oob-sw1 | `Ethernet8` | cat6 | planned |
| `OOB-worker03` | worker03 | `bmc` | oob-sw1 | `Ethernet9` | cat6 | planned |
| `OOB-worker04` | worker04 | `bmc` | oob-sw1 | `Ethernet10` | cat6 | planned |
| `OOB-worker05` | worker05 | `bmc` | oob-sw2 | `Ethernet1` | cat6 | planned |
| `OOB-worker06` | worker06 | `bmc` | oob-sw2 | `Ethernet2` | cat6 | planned |
| `OOB-worker07` | worker07 | `bmc` | oob-sw2 | `Ethernet3` | cat6 | planned |
| `OOB-worker08` | worker08 | `bmc` | oob-sw2 | `Ethernet4` | cat6 | planned |

---

## 6. Labeling convention

| Pattern | Meaning |
| ------- | ------- |
| `R{rail}-W{nn}` | Host fabric |
| `L{rail}S{spine}-U{n}` | Leaf–spine uplink |
| `OOB-{device}` | BMC |

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
