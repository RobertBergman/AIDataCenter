# Overlay — EVPN/VXLAN, VRFs, and External Access

**Status:** Draft  
**Scope:** BGP EVPN control plane, VXLAN data plane, day-1 VRFs (`storage`, `edge`), API ingress path, border handoff  
**Implements:** [SPEC.md](../SPEC.md) §5.1 (overlay row), §6.3 (storage isolation), §8 (request flow entry) · builds on [docs/network.md](network.md) §5 underlay · consumed by [docs/serving.md](serving.md) §5

> **SoT rule:** all overlay addressing (VTEP loopbacks, VRF subnets, VNIs) lives in the seed IPAM (`bootstrap/netbox/seed/site.yaml`) and is rendered into switch configs by `bootstrap/seed/ztp/render.py` — same pipeline as the underlay; nothing is hand-configured.

---

## 1. Why an overlay, and why now

The day-1 fabric is a pure L3 eBGP underlay (network.md §5) — correct for RoCE rails, which stay **exactly as they are**. The overlay exists for the two things the underlay deliberately did not solve:

| Need | Underlay answer | Overlay answer |
| ---- | --------------- | -------------- |
| Storage isolation (SPEC §6.3 "dedicated storage VRF") | shared default VRF, DSCP only | **VRF `storage`** — storage nodes and worker mounts in their own routing table |
| External API access for ~1,000 users (SPEC §8) | none (no border) | **VRF `edge`** — LoadBalancer VIPs + campus border, no route to underlay/RoCE |
| Future research tenant VRFs, DCI | — | add a VRF + VNI, zero underlay change |

**What the overlay is *not* for:** the RoCE expert-parallel path. GPU↔GPU NCCL/EP traffic stays native in the underlay rail subnets — no VXLAN encap, no PFC interaction changes, nothing from network.md §6 moves.

---

## 2. Control and data plane design

| Element | Choice |
| ------- | ------ |
| Control plane | **BGP EVPN** over eBGP: leaf Lo0 ↔ spine Lo0, `ebgp-multihop 3`, `send-community extended`; spines `next-hop-unchanged` (pure transit for VTEP next-hops) |
| Data plane | VXLAN, UDP 4789, VTEP = **Loopback1** on every rail leaf + both spines |
| IRB model | **Symmetric IRB** — one L3VNI per VRF, routed type-5 everywhere; L2VNIs only for the two access VLANs |
| Underlay support | Lo1 advertised in ipv4 AF (already rendered); fabric MTU 9216 absorbs the 50 B VXLAN header at host MTU 9000 |
| EOS mode | `service routing protocols model multi-agent` on all fabric switches (required for EVPN; part of rendered config, applied at ZTP) |
| Anycast gateway | VARP: shared `.1` + per-leaf real IP (same pattern as the OOB pair) — real IPs also terminate MetalLB BGP (§5) |

The existing p2p eBGP sessions keep doing the underlay (ipv4 + BFD). EVPN runs on separate loopback sessions: 2 per leaf, 8 per spine — 16 sessions total.

### 2.1 VNI / RD / RT plan

| Object | VNI | RD | RT | Where |
| ------ | --: | -- | -- | ----- |
| VRF `storage` (L3) | **50200** | `<Lo0>:200` | `50200:50200` | all 8 leaves |
| VRF `edge` (L3) | **50050** | `<Lo0>:50` | `50050:50050` | all 8 leaves + both spines |
| VLAN 200 `storage-access` (L2) | **10200** | `<Lo0>:10200` | `10200:10200` | all 8 leaves |
| VLAN 50 `edge-access` (L2) | **10050** | `<Lo0>:10050` | `10050:10050` | all 8 leaves |

Convention: L2VNI = 10000 + VLAN ID, L3VNI = 50000 + VLAN ID of the primary access VLAN. Future tenant VRFs allocate the next VLAN + both VNIs from the same rule.

### 2.2 Addressing (seed IPAM)

| Block | Use |
| ----- | --- |
| `10.30.32.0/24` | VTEP loopbacks (Lo1): spines `.1–.2`, leaf-rail0–7 `.11–.18` |
| `10.40.0.0/24` | Storage p2p /31s, **vrf storage**: leaf-rail0 Eth25–28 = `.0–.7`, leaf-rail7 Eth25–28 = `.8–.15` |
| `10.40.64.0/24` | VLAN 200 storage access: VARP gw `.1`, leaf-rail*i* `.2+i`, worker0*N* `.1N` |
| `10.50.0.0/24` | LoadBalancer VIP pool (MetalLB): inference gateway VIP **`.10` = `inference.ai.local`** |
| `10.50.64.0/24` | VLAN 50 edge access: VARP gw `.1`, leaf-rail*i* `.2+i`, worker0*N* `.1N` |
| `10.50.255.0/29` | Border p2p /31s, **vrf edge**: spine1 Eth33 `.0/31`, spine2 Eth33 `.2/31` |

---

## 3. VRF `storage`

Moves the network.md §7 storage attachment into its own routing table — same leaves, same ports, same QoS (DSCP 18 → TC1, lossy).

```
 storage nodes (2× 400G each)                GPU workers
   │ routed /31, vrf storage                   │ VLAN 200 tagged subif
   ▼                                           ▼ on rail0 + rail7 NICs
 leaf-rail0 Eth25–28 ── VRF storage ── Vlan200 SVI (VARP 10.40.64.1)
 leaf-rail7 Eth25–28 ──────┘   │
                               └── L3VNI 50200 between leaf0 ↔ leaf7
```

| Item | Design |
| ---- | ------ |
| Storage node side | unchanged /31 routed ports on leaf-rail0/7 Eth25–28, now `vrf storage` |
| Worker side | **VLAN 200 tagged subinterface** on the rail0 and rail7 NICs (2 paths, ECMP/failover); IP `10.40.64.1N`, gw VARP `.1` — configured by cloud-init from NetBox (bootstrap track) |
| QoS | storage traffic still marked DSCP 18 on the subif → TC1; RoCE class untouched (untagged rail traffic keeps DSCP 26) |
| Route scope | `10.40.0.0/16` exists **only** in vrf storage; workers reach it via the VLAN 200 subif, nothing in the default VRF routes to storage |
| Blast radius | a storage-side routing mistake can no longer leak into the RoCE underlay |

Trunking note: rail leaf host ports are now `trunk native vlan <rail>` with tagged 50/200 allowed. Untagged RoCE frames land in the rail VLAN exactly as before; rails 1–6 simply carry no tagged traffic day-1.

---

## 4. VRF `edge` — API ingress and border

The path SPEC §8 needs: external users → API gateway VIP, with the fabric underlay invisible to them.

```
 campus / users                        AS 65500 (firewall)
      │ default route + 10.50.0.0/24 learned
      ▼
 spine1/2 Eth33 (routed /31, vrf edge, eBGP)        ← border VTEPs
      │ EVPN type-5
      ▼
 leaf-rail0/7 · vrf edge · Vlan50 (VARP 10.50.64.1)
      │ VLAN 50 tagged subif on worker rail0/7 NICs
      ▼
 MetalLB speakers (AS 65200) ── announce 10.50.0.0/24 VIPs
      ▼
 Envoy gateway Service VIP 10.50.0.10 → InferencePool → vLLM pods
```

| Item | Design |
| ---- | ------ |
| Border | spine Eth33 routed /31 in vrf edge; eBGP to campus firewall AS 65500 (default in, VIP /24 out) |
| Spines as VTEPs | yes — border VRF terminates on spines (Lo1 `.1/.2`); leaves reach it via L3VNI 50050 |
| VIP announcement | MetalLB **BGP mode** (AS 65200) from workers over the VLAN 50 subif; leaves `bgp listen range 10.50.64.0/24` in vrf edge (rails 0/7) |
| Isolation | vrf edge contains **only** `10.50.0.0/16` + firewall default; no import of underlay, storage, mgmt, or OOB routes |
| In-cluster hop | gateway pods (hostNetwork=false) receive VIP traffic via kube-proxy from the MetalLB-announced node; East-west to vLLM pods rides the CNI on rail subnets as usual |
| DNS | `inference.ai.local → 10.50.0.10` (seed dnsmasq + campus conditional forward) |

Security stance: the fabric exposes exactly one /24 of VIPs to the outside; authentication, keys, and quotas happen at the Envoy gateway (serving.md §6) — the fabric's job ends at delivering packets to the VIP in an isolated table.

---

## 5. Rendered config summary (what `render.py` now emits)

| Switch | Overlay additions |
| ------ | ----------------- |
| all leaves | multi-agent model · Lo1 VTEP · VLANs 50/200 + VARP SVIs in vrf edge/storage · Vxlan1 (2× L2VNI + 2× L3VNI) · EVPN peer group → spine Lo0s · MAC-VRF + VRF stanzas in BGP |
| leaf-rail0/7 only | storage /31 ports Eth25–28 in vrf storage · MetalLB `bgp listen range` in vrf edge |
| spines | multi-agent model · Lo1 VTEP · vrf edge + Vxlan1 (L3VNI 50050) · EVPN peer group → all leaf Lo0s with `next-hop-unchanged` · border Eth33 eBGP AS 65500 |
| OOB pair | **no change** — overlay never touches 7010TX-48 |

As with the RoCE profile, exact EVPN/VXLAN syntax is validated against the target EOS release in the lab before production (network.md §8 gate applies).

---

## 6. Verification gates

| Gate | Command | Pass |
| ---- | ------- | ---- |
| EVPN sessions | `show bgp evpn summary` | leaves: 2 Established; spines: 8 |
| VTEP discovery | `show vxlan vtep` | every leaf sees 7 leaf + 2 spine VTEPs |
| Type-5 routes | `show bgp evpn route-type ip-prefix 10.50.0.0/24` | present on spines with leaf VTEP next-hop |
| Storage VRF | `ping vrf storage 10.40.0.1 source 10.40.64.2` (leaf0→stor01) | ok; same ping from default VRF **fails** |
| Anycast gw | worker: `ping 10.40.64.1` and `10.50.64.1` from subifs | ok via either rail0/7 path |
| Isolation | from campus: traceroute to `10.30.64.11` (rail IP) | **blocked** (no route in vrf edge) |
| VIP path | `curl https://inference.ai.local/v1/models` from campus | 200 via border → spine → leaf → MetalLB node |
| RoCE regression | re-run network.md §8.3 rail gates after overlay deploy | unchanged (encap never touches rail traffic) |

---

## 7. Phase-next

| Item | Trigger |
| ---- | ------- |
| Research tenant VRFs | per-team isolation ask; allocate VLAN/VNI per §2.1 convention |
| DCI | second site; extend EVPN via border (type-5 only) |
| Storage VRF on STOR-2 | second storage rack (SPEC §2A.6) |
| Anycast VTEP / MLAG leaves | only if host dual-homing model changes — not planned |

---

## 8. References

| Doc / path | Use |
| ---------- | --- |
| [docs/network.md](network.md) §5–6 | Underlay + RoCE profile the overlay rides on |
| [docs/serving.md](serving.md) | What lives behind the edge VIP |
| `bootstrap/seed/ztp/render.py` | Rendered overlay config (SoT pipeline) |
| `bootstrap/netbox/seed/site.yaml` | VNI/VRF addressing (IPAM SoT) |
| `bootstrap/platform/apps/api/` | MetalLB pool + gateway consuming vrf edge |
| Arista EOS *EVPN/VXLAN* chapters (target release) | Syntax validation gate |

---

## Revision History

| Version | Date | Notes |
| ------- | ---- | ----- |
| 0.1 | 2026-07-19 | Initial: EVPN/VXLAN overlay, vrf storage + vrf edge, border + VIP ingress, rendered via ZTP pipeline |
