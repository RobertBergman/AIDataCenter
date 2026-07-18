# 64× NVIDIA B200 AI Inference Cluster Specification

**Status:** Draft  
**Purpose:** Production research AI platform for interactive inference of multi-trillion parameter MoE models  
**Scale:** ~1,000 registered users, ~50 concurrent  
**Data retention:** All inference retained **1 year** (research archive)  

---

## 1. Design Goals

| Priority | Goal |
| -------- | ---- |
| 1 | Interactive inference latency |
| 2 | Large model support (multi-trillion MoE) |
| 3 | Research workload flexibility |
| 4 | High availability |
| 5 | Expandability |

This is **not** a maximum-throughput hyperscale training cluster. It is a manageable enterprise research inference platform.

---

## 2. Physical Summary

| Item | Specification |
| ---- | ------------: |
| GPUs | **64× NVIDIA B200** |
| GPU servers | 8 |
| GPUs per server | 8 |
| **Racks (baseline)** | **4** (2× GPU + 1× bootstrap + 1× storage) |
| GPU rack density | 32 GPUs/rack (4 servers) |
| Fabric | 400GbE RoCEv2 rail-optimized (Arista 7060DX5) |
| NICs | **8× 400GbE per server** (1:1 with GPUs) |
| Orchestration | Kubernetes + NVIDIA GPU Operator |
| Primary workload | MoE LLM inference |

---

## 2A. Rack Layout and Facility Zones

### 2A.1 How many racks?

| Rack | Role | Required? |
| ---- | ---- | --------- |
| **GPU-1** | 4× B200 servers (32 GPUs) + rail leaves share + OOB | Yes |
| **GPU-2** | 4× B200 servers (32 GPUs) + rail leaves share + OOB | Yes |
| **BOOT** | DC bootstrap / management / control plane | **Yes (minimum 1)** |
| **STOR** | Hot model FS + 1-year inference object lake | **Yes (1 is enough at this scale)** |
| STOR-2 | Archive growth / second failure domain | Optional (phase-2) |
| GPU-3 | +32 GPUs expansion | Optional (phase-2) |

**Baseline footprint: 4 racks.**  
You do **not** need a second storage rack for day-1 750 TB–1.5 PB usable flash if nodes/appliances are dense. Add **STOR-2** when archive exceeds ~1.5–2 PB usable, you want rack-level failure isolation for the lake, or you separate “hot models” from “cold year archive” physically by policy.

### 2A.2 Why a dedicated BOOT rack?

Keep bootstrap **off** the GPU power/cooling failure domain and free GPU RU for compute + rail optics.

| Function | Lives in BOOT |
| -------- | ------------- |
| K8s control plane (3 nodes) | Yes |
| PXE / image / iPXE / Metal3 or MAAS | Yes |
| DNS, DHCP, NTP, IPA/LDAP jump | Yes |
| **NetBox (DCIM / IPAM / cabling SoT)** | Yes |
| GitOps, registry, Vault/secrets | Yes |
| Monitoring / logging (Prometheus, Loki, …) | Yes |
| Inference archive bus brokers (Kafka/Redpanda) if compact | Often here |
| CloudVision / NMS (optional) | Yes |
| Console servers, serial, crash carts path | Yes |
| Spines and/or border (optional co-locate) | Prefer here or row end |
| Storage data plane nodes | **No** → STOR |
| GPU workers | **No** → GPU-1/2 |

BOOT is **lightweight RU and kW** compared to GPU; one 42–48U rack is enough with headroom.

### 2A.3 Why one STOR rack (usually)?

| Tier | Day-1 size | Fits in one rack? |
| ---- | ---------- | ----------------- |
| Hot models + landing | 150–300 TB usable NVMe | Yes (3–6 nodes or 1–2 appliances) |
| Inference archive | ≥750 TB usable (path 1.5–2 PB) | **Yes** with dense NVMe/object nodes or one scale-out appliance + shelves |
| Future 2 PB+ or dual-site style isolation | — | Plan **STOR-2** |

Storage is **network-attached on 7060DX5**, not DAS to GPUs. Physical separation from GPU racks is good practice (blast radius, service windows); a *second* storage rack is capacity/isolation driven, not a hard topology requirement at 64-GPU scale.

### 2A.4 Baseline elevation (logical)

```
 Row / cage
 ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
 │   GPU-1     │ │   GPU-2     │ │    BOOT     │ │    STOR     │
 │ 4× B200     │ │ 4× B200     │ │ K8s CP ×3   │ │ Hot FS      │
 │ Rail leaves │ │ Rail leaves │ │ Bootstrap   │ │ Archive lake│
 │ OOB 7010    │ │ OOB 7010    │ │ Spines*     │ │ 400G → leaf │
 │ ~46 kW      │ │ ~46 kW      │ │ Mgmt/svc    │ │ ~5–15 kW    │
 │             │ │             │ │ ~3–8 kW     │ │             │
 └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
        │ 400G rail fabric + storage VRF (7060DX5) │
        └─────────────────────┬───────────────────┘
                              │
                     *Spines may sit in BOOT or
                      mid-row; rail leaves in GPU racks
```

\* Prefer **spines in BOOT** (or dedicated network bay) so GPU racks stay power-dense for servers + busbars. Rail **leaves** stay close to GPU NICs (short DAC/AOC) → place in **GPU-1 / GPU-2**.

### 2A.5 Per-rack contents (RU budget sketch)

Assumes ~42–48U racks; numbers are planning, not final elevation drawings.

#### GPU-1 / GPU-2 (each)

| Contents | Qty | RU (approx) |
| -------- | --: | ----------: |
| B200 8-GPU servers | 4 | 16–24 (4–6U each) |
| Rail leaf 7060DX5-32 (share of 8) | 3–5 | 3–5 |
| OOB 7010TX-48 | 1 | 1 |
| Patch / fiber manager | 1–2 | 2–4 |
| rPDU A/B | 2 | 0–2 |
| **Headroom** | | reserve for optics density |

Cable: 4 servers × 8×400G = **32× 400G** host links per GPU rack.

#### BOOT

| Contents | Qty | RU (approx) |
| -------- | --: | ----------: |
| K8s control plane | 3 | 3–6 |
| Bootstrap / utility | 2–4 | 2–8 |
| Spines 7060DX5-64S | 2 | 4 |
| Optional service leaf ports / border | 0–1 | 1–2 |
| Redpanda/Kafka (if not on STOR) | 3 | 3–6 |
| Catalog DB / monitoring | 2–4 | 2–8 |
| OOB uplink aggregation / jump | 1 | 1–2 |
| Console / KVM | 1 | 1 |
| **Headroom** | | large (growth, CVP, labs) |

#### STOR

| Contents | Qty | RU (approx) |
| -------- | --: | ----------: |
| Hot NVMe FS nodes or appliance | 3–6 or 1–2 | 6–20 |
| Archive object nodes / shelves | EC set | 8–20 |
| Storage 400G leaf attachment (or dual-home to fabric) | via GPU row leaves or local ToR ports | — |
| Storage BMC → OOB (extend from BOOT/GPU OOB) | — | — |
| **Headroom** | | for +shelves before STOR-2 |

### 2A.6 Decision summary

| Question | Answer |
| -------- | ------ |
| Need BOOT rack? | **Yes — at least one** |
| Need extra racks for storage day-1? | **One STOR rack is enough** for hot + ≥750 TB archive |
| When add STOR-2? | >~1.5–2 PB usable, rack failure domain split, or policy isolation hot vs cold |
| Total baseline racks | **4** |
| Power domains | GPU-1/2 high-kW; BOOT + STOR normal enterprise power |

---

## 3. Compute Nodes

### 3.1 GPU Server Quantity

**8 servers**

Example platforms:

- NVIDIA MGX B200 server
- Dell XE9680-class
- HPE Cray XD series
- Supermicro HGX/B200 platform
- Lenovo ThinkSystem AI server

### 3.2 Per-Server Specification

| Component | Specification |
| --------- | ------------- |
| GPU | 8× NVIDIA B200 |
| GPU memory | ~1.4 TB HBM3e |
| GPU compute | ~1.4 PFLOPS FP8 (approx.) |
| CPU | 2× AMD EPYC Turin / Genoa |
| CPU cores | 128–192 |
| System RAM | 2 TB DDR5 ECC |
| Boot | 2× 1.92 TB NVMe RAID1 |
| Local NVMe | 8× 3.84 TB |
| Data network | **8× 400GbE** (1 NIC per GPU; rail-optimized) |
| NIC class | ConnectX-7 / BlueField-3 SuperNIC (or platform equivalent) |
| GPU↔NIC | PCIe locality / GPUDirect RDMA; NIC paired to each B200 |
| Management | 1× 1/10/25GbE |
| Power | 8–10 kW |

### 3.3 Cluster Aggregate Capacity

| Resource | Amount |
| -------- | -----: |
| GPUs | 64 |
| HBM3e memory | ~11.5 TB |
| CPU cores | ~1,200 |
| System RAM | 16 TB |
| Local NVMe | ~250 TB |
| GPU FP8 compute | ~11–12 PFLOPS |
| Host 400G ports | **64** (8 servers × 8 NICs) |
| Cluster host edge | **25.6 Tbps** |

---

## 4. GPU Parallelism Model

For a ~3T MoE model, do **not** run one giant tensor-parallel job across all GPUs by default.

### 4.1 Logical Layout

```
                    Model Router
                          |
           +--------------+--------------+
           |              |              |
    Expert Group 1  Expert Group 2  Expert Group 3  Expert Group 4
       GPU 0–15        GPU 16–31       GPU 32–47       GPU 48–63
```

### 4.2 Parallelism Dimensions

| Dimension | Role |
| --------- | ---- |
| TP | Tensor parallel (within node / NVLink domain) |
| EP | Expert parallel (across nodes over fabric) |
| PP | Pipeline parallel (optional depth split) |

### 4.3 Example Configurations

```
TP=8, EP=8, PP=1
TP=4, EP=16, PP=1
```

Exact values depend on model architecture, expert count, and latency targets.

---

## 5. Network Architecture

For MoE inference, the fabric is part of the computer.

**Standard platform:** Arista **7060DX5** series, EOS, optional CloudVision.

### 5.0 Host NIC Model — 1× 400GbE per GPU (required baseline)

Prior drafts assumed **2× 400G per server**. That is a common *shared-NIC* enterprise pattern and is **insufficient** as the baseline for this B200 MoE cluster.

| Model | NICs / server | When used |
| ----- | ------------: | --------- |
| Shared PCIe NIC | 1–2× 400G | Light east-west; many general GPU clouds |
| **Rail-optimized (this design)** | **8× 400G** | **1 NIC per GPU**; GPUDirect RDMA; MoE EP / NCCL |

**Baseline:** each B200 has a **dedicated 400GbE** adapter (ConnectX-7, BlueField-3 SuperNIC, or HGX/MGX platform equivalent), PCIe-local to that GPU.

```
  GPU0 ── NIC0 ── 400G ── Rail-0 leaf
  GPU1 ── NIC1 ── 400G ── Rail-1 leaf
  ...
  GPU7 ── NIC7 ── 400G ── Rail-7 leaf
```

Why 1:1:

| Reason | Effect |
| ------ | ------ |
| GPUDirect RDMA | GPU↔NIC without hairpin through another GPU’s root complex |
| Avoid PCIe bottleneck | 8 GPUs sharing 1–2 NICs saturates host I/O under EP |
| Rail scheduling | Same GPU index on every node lands on the same leaf (NCCL multi-rail) |
| Predictable EP | Expert-parallel all-to-all maps cleanly onto rails |

| Scope | Bandwidth |
| ----- | --------- |
| Per GPU | 400 Gbps |
| Per server | **3.2 Tbps** (8×400G) |
| Cluster host edge | **25.6 Tbps** (64×400G) |

### 5.1 Fabric Requirements

| Feature | Requirement |
| ------- | ----------- |
| Platform | Arista 7060DX5 |
| NOS | Arista EOS |
| Link speed | 400GbE (QSFP-DD) |
| Host NICs | **8× 400G per GPU server** (1:1) |
| Topology | **Rail-optimized** leaf tier + spine |
| Transport | RoCEv2 |
| Congestion | ECN, PFC, DCQCN / advanced congestion mgmt |
| Load balancing | ECMP + Dynamic Load Balancing (DLB); rail-aware where applicable |
| Overlay / control | BGP EVPN (VXLAN as needed) |
| Automation | eAPI / CloudVision |
| Tuning | AI / lossless Ethernet profile |

### 5.2 Topology Rules

**RoCEv2 lossless Ethernet does not require equal leaf and spine counts** — but **rail count usually matches GPUs per node** (here **8 rails → 8 rail leaves**).

What keeps MoE/EP well-behaved:

| Requirement | Why it matters |
| ----------- | -------------- |
| 1 NIC per GPU | Removes host NIC as the EP bottleneck |
| Rail-aligned wiring | GPU-_i_ on all nodes → same rail leaf |
| Low / zero oversub leaf→spine | Cross-rail / non-rail traffic stays non-blocking |
| PFC + ECN + DCQCN | Lossless without pause storms |
| ECMP / DLB on spine tier | Spread cross-rail flows |
| Jumbo MTU end-to-end | Lower PPS |
| Buffer + queue telemetry | Microburst visibility |

Spine count still follows bandwidth math (not “must equal leaf count” for lossless protocol reasons):

```
Σ leaf uplink BW  ≥  Σ leaf downlink (host) BW   # for 1:1 non-blocking
```

### 5.3 Topology — Rail-Optimized (default)

#### Default: 8 rail leaves + 2 spines

```
                    Spine1              Spine2
                  7060DX5-64S         7060DX5-64S
                      \                  /
                       \   ECMP/DLB    /
                        \            /
     Rail0  Rail1  Rail2  Rail3  Rail4  Rail5  Rail6  Rail7
     Leaf   Leaf   Leaf   Leaf   Leaf   Leaf   Leaf   Leaf
     (8 × DCS-7060DX5-32)

     Each rail leaf attaches GPU-i from worker01 … worker08
```

| Role | Model | Qty | Notes |
| ---- | ----- | --: | ----- |
| Rail leaf | **DCS-7060DX5-32** | **8** | One leaf per GPU index (rail 0–7) |
| Spine | **DCS-7060DX5-64S** (or 64E) | **2** | Cross-rail + storage/services |

**Host fan-in per rail leaf:** 8 servers × 1 NIC = **8× 400G** downlinks (3.2 Tbps).

**1:1 leaf→spine example:** ≥ **8× 400G** uplink per rail leaf (e.g. 4×400G to each spine).  
8 leaves × 8 uplinks = **64** leaf–spine 400G links → fits cleanly on **2× 64-port** spines with ports left for storage/border.

#### Optional: single-SKU square Clos

Use **8× DX5-32 spine** (or keep 2× 64S) if procurement wants all leafy SKUs. Still **8 rail leaves**; spine count is HA/BW, not “must be 8” for lossless.

#### Placement

| Location | Gear |
| -------- | ---- |
| Rack 1 | worker01–04 + share of rail leaves / OOB |
| Rack 2 | worker05–08 + remaining rail leaves / OOB |
| Leaves may be split across racks; **rail identity is logical**, not “one rack owns four rails” only |

Cable so **GPU0 from every server → Rail0 leaf**, etc., regardless of rack.

### 5.4 Leaf Switches — Arista 7060DX5-32 (rail leaves)

**Quantity:** **8**  
**SKU class:** DCS-7060DX5-32

| Feature | Value |
| ------- | ----- |
| Ports | 32× 400G QSFP-DD |
| Breakout | up to 128× 100G |
| L2/L3 throughput | 12.8 Tbps |
| Forwarding | ~5.3 Bpps |
| Packet buffer | 57 MB shared |
| Latency | from ~850 ns |
| Typical power | ~289 W |
| Airflow | F-R or R-F (match rack) |
| HA hardware | 1+1 PSU, N+1 fans |
| Routing | BGP EVPN, 128-way ECMP |
| AI features | DLB, advanced congestion, LANZ |
| QoS | PFC / ECN for RoCEv2 |

### 5.5 Spine Switches — 7060DX5-64 (qty 2)

| Option | Model | Ports | Throughput | Buffer | RU | Notes |
| ------ | ----- | ----- | ---------- | ------ | -- | ----- |
| **A1 (preferred)** | **DCS-7060DX5-64S** | 64× 400G QSFP-DD | 25.6 Tbps | 114 MB | 2 | Native 400G |
| A2 | **DCS-7060DX5-64E** | 32× 800G → 64× 400G | 25.6 Tbps | 114 MB | 1 | 800G path |

| Feature | Value |
| ------- | ----- |
| ECMP | up to 128-way |
| Latency | from ~850 ns |
| Typical power | ~489 W (64S) / ~548 W (64E) |
| Airflow | Front-to-rear |
| HA hardware | 1+1 PSU, N+1 fans |

**Default procurement:** **8× DX5-32 rail leaf + 2× DX5-64S spine**.

### 5.6 Server Connectivity (per GPU server)

```
        HGX/MGX B200 Server (8 GPUs)
        ├── GPU0 ── NIC0 ── 400G ── Rail-0 leaf
        ├── GPU1 ── NIC1 ── 400G ── Rail-1 leaf
        ├── GPU2 ── NIC2 ── 400G ── Rail-2 leaf
        ├── GPU3 ── NIC3 ── 400G ── Rail-3 leaf
        ├── GPU4 ── NIC4 ── 400G ── Rail-4 leaf
        ├── GPU5 ── NIC5 ── 400G ── Rail-5 leaf
        ├── GPU6 ── NIC6 ── 400G ── Rail-6 leaf
        └── GPU7 ── NIC7 ── 400G ── Rail-7 leaf
```

Within the node, **TP prefers NVLink**; NICs carry **inter-node EP/PP**, storage, and control that is mapped onto data NICs. Do not design as if 8 GPUs share two uplinks.

| Scope | Bandwidth |
| ----- | --------- |
| Per GPU / NIC | 400 Gbps |
| Per server | **3.2 Tbps** |
| Cluster host edge | **25.6 Tbps** (64× 400G) |

### 5.7 Port Plan (Planner Baseline)

**Per rail leaf (7060DX5-32):**

| Use | Ports | Speed |
| --- | ----: | ----- |
| GPU rail downlinks (8 workers × GPU-_i_) | **8** | 400G |
| Spine uplinks (1:1 → ~8 total) | **8** | 400G |
| Storage / services (subset of leaves) | 0–4 | 400G |
| Spare / growth | remainder | 400G |

Leaf front-panel: 8 down + 8 up = 16 ports used for pure compute fabric; 32-port SKU has headroom.

**Per spine (7060DX5-64S):**

| Use | Ports (example) | Speed |
| --- | --------------: | ----- |
| Rail leaf uplinks (8 leaves × 4) | **32** | 400G |
| (if 8 uplinks/leaf: 8×8) | **64** | 400G |
| Storage cluster | 2–8 | 400G |
| Border / DCI / services | 2–4 | 400G |
| Spare | remainder | 400G |

With **8 uplinks per leaf**, two 64-port spines are fully subscribed on leaf-facing ports if split 32+32 — size storage on extra spines/ports or reduce leaf uplinks only if accepting oversub.

### 5.8 Optics and Cabling

| Link | Preferred media |
| ---- | --------------- |
| Server ↔ leaf (same rack) | 400G-DR4 / DAC or AOC as length allows |
| Leaf ↔ spine (in-row / adjacent) | 400G-DR4 or FR4 per plant standards |
| Connector | QSFP-DD on 7060DX5-32 / 64S |
| Spares | 20% optics/cables minimum |

Exact optics SKUs finalized in `docs/bom.md` and `docs/network.md`.

### 5.9 RoCEv2 / AI Ethernet Profile (Arista EOS)

Required fabric behaviors for MoE all-to-all / EP traffic:

| Control | Setting direction |
| ------- | ----------------- |
| Priority flow control | Lossless queue for RoCE PFC priority |
| ECN | Enabled on RoCE queue; mark before drop |
| DCQCN | Host CNP reaction; switch ECN marking thresholds tuned |
| DLB | Prefer Dynamic Load Balancing over static hash for large flows |
| MTU | Jumbo (e.g. 9000) end-to-end |
| ECMP | Max-path ≥ leaf uplink count; resilient hashing |
| Telemetry | LANZ / queue depth; drop & ECN counters scraped |

### 5.10 Out-of-Band / Management Network

Separate from the 400G RoCE fabric. **Never** carry GPU data-plane traffic.

**Standard platform:** Arista **7010TX-48** (7010X series), EOS.

#### Platform

| Item | Spec |
| ---- | ---- |
| Model | **DCS-7010TX-48** (AC) or **DCS-7010TX-48-DC** |
| Form factor | 1RU |
| Access ports | 48× 10/100/1000BASE-T (RJ45) |
| Uplinks | 4× SFP28 (1/10/25GbE) |
| Throughput | 296 Gbps / ~220 Mpps |
| Buffer | 4 MB shared |
| Power | 1+1 redundant PSU |
| Fans | 1+1 hot-swap; reversible airflow |
| NOS | Arista EOS (same family as 7060DX5) |

Related SKUs: `7010TX-48C` / `7010TX-48C-DC` if copper/console variant needed per quote.

#### Quantity and placement

| Role | Qty | Placement |
| ---- | --: | --------- |
| OOB leaf | **2** | 1 per GPU rack (baseline) |
| Optional 3rd | 1 | Management rack (K8s + storage BMCs) if port pressure |

Two OOB switches are dual-homed uplink or MLAG pair so a single OOB switch failure does not black-hole BMC access.

```
                    Mgmt core / border
                   (or 7060 service VRF)
                     /              \
              OOB-SW1              OOB-SW2
            7010TX-48              7010TX-48
             Rack 1                 Rack 2
                |                      |
     BMC, BIOS-NIC, console servers, PDUs
     7060DX5 mgmt ports, CW / jump hosts
```

#### What attaches to 7010TX-48

| Endpoint | Speed | Notes |
| -------- | ----- | ----- |
| GPU server BMC (iDRAC/iLO/BMC) | 1G | Always-on lights-out |
| GPU server optional mgmt NIC | 1G | OS rescue / PXE if used |
| K8s control-plane mgmt | 1G | Dedicate ports; not RoCE NICs |
| 7060DX5 Management1 | 1G | Out-of-band EOS mgmt |
| Storage / PDU / serial consoles | 1G | As present |
| CloudVision / jump / IPMI tools | 1G | Ops plane |

#### Port budget (per rack, 4 GPU servers)

| Use | Ports (approx.) |
| --- | --------------: |
| 4× GPU BMC | 4 |
| 4× OS mgmt NIC (optional) | 0–4 |
| 2× leaf 7060DX5 mgmt | 2 |
| 1× spine share or local | 0–1 |
| PDU / rPDU | 2–4 |
| Console server | 1 |
| Spares | remainder of 48 |

48 ports per rack is comfortable at this scale.

#### Uplinks

| Item | Spec |
| ---- | ---- |
| Ports | 1–2× 10G (or 25G) SFP28 per 7010TX-48 |
| Target | Redundant path to mgmt/core or services block |
| HA | MLAG between the two 7010TX-48 **or** independent L3 with dual default |

OOB is **loss-tolerant best-effort** (no RoCE PFC). Do not enable lossless QoS on 7010TX-48.

#### Security

| Control | Requirement |
| ------- | ----------- |
| Isolation | Dedicated VRF / VLAN; no route to RoCE data VRF except controlled jump |
| Access | MFA jump host; no public BMC |
| ACLs | Allow only mgmt subnets → BMC/IPMI/SSH/HTTPS |
| Logging | EOS AAA + syslog/telemetry to ops stack |

---

## 6. Storage

Inference is **not** a training I/O path. Storage must be fast enough to **load multi-TB MoE checkpoints**, hold versions, and support research artifacts — without competing with RoCE expert traffic incorrectly, and without needing an all-flash training forge.

### 6.1 Role of Storage in This Cluster

| Path | When it runs | Bandwidth need | Latency sensitivity |
| ---- | ------------ | -------------- | ------------------- |
| **Model cold start / rollout** | Deploy, restart, scale, canary | High burst (tens of GB/s cluster) | Startup time only |
| **Steady inference** | After weights in HBM/DRAM | Near-zero for weights | Tokens from GPU HBM |
| **Inference archive (1 year)** | Every request (async) | Sustained write + research scan | Write path must not block TTFT |
| **KV / prefix cache spill** (optional) | Long context / multi-tenant | Medium, local-first | Moderate |
| **Datasets / eval / embeddings** | Research jobs (Ray) | Medium sequential | Low–medium |
| **Ops metrics / traces** | Always | Low | Low |

Design principles:

1. **Weights** live on hot shared NVMe; steady-state path is GPU HBM.  
2. **All inference** (prompts, completions, metadata) is retained **≥ 1 year** for research.  
3. Archive write is **async / sidecar** — never on the critical token path.

### 6.2 Logical Architecture

```
                    ┌──────────────────────────────────────┐
                    │  Cold / research object lake (S3)      │
                    │  1-year inference archive + datasets │
                    │  0.5–2+ PB class (see §6.4)          │
                    └──────────────▲───────────────────────┘
                                   │ compact / lifecycle
                    ┌──────────────┴───────────────────────┐
                    │  Hot tier (NVMe)                       │
                    │  • Model repo 100–250 TB               │
                    │  • Inference landing (7–30 days)       │
                    └──────────────┬───────────────────────┘
                                   │ 400GbE
              ┌────────────────────┼────────────────────┐
              │                    │                    │
        GPU workers          Archive path         Research query
        serve + emit         (async bus)          (Spark/Ray/SQL)
              │                    │
              ▼                    ▼
        vLLM/TRT-LLM          Kafka/Redpanda/NATS
        → HBM                 or direct S3 PUT
```

### 6.3 Integration with the Network

Storage attaches to the **same Arista 7060DX5 data fabric** as GPU servers (not the 7010TX-48 OOB).

```
  Storage nodes / appliance NICs
           │ 2–4 × 400GbE (or 2×400G HA)
           ▼
     Leaf ports (dedicated storage VLAN/VRF)
           │
     ECMP via spines
           │
     GPU worker 2×400G RoCE NICs
```

| Item | Spec |
| ---- | ---- |
| Fabric | 7060DX5 leaf-spine |
| Host mount path | GPU NICs (data plane), not BMC/OOB |
| Isolation | Dedicated **storage VRF** or VLAN; QoS separate from pure RoCE EP class if needed |
| Transport | NFS/RDMA, Weka/BeeGFS/Lustre client, or S3 over TCP/HTTP — product-dependent |
| Oversubscription | Storage uplinks sized so model load does not starve EP if sharing queues; prefer **separate DSCP/PFC priority** for storage vs RoCE bulk if mixed |

**BMC / storage controllers** → 7010TX-48 OOB only.

### 6.4 Capacity and Performance Targets

#### Hot tier (models + short landing)

| Metric | Target |
| ------ | ------ |
| Usable NVMe | **100–250 TB** models + **20–50 TB** inference landing |
| Single large MoE checkpoint | **5–40 TB** compressed/sharded per version |
| Concurrent model versions | 3–5 online |
| Aggregate model read | **≥ 40 GB/s** (stretch 80+) |
| Single-node model read | **≥ 10–20 GB/s** |

#### Inference archive tier (1-year retention) — **required**

**Policy:** retain **every** inference exchange for **365 days** (research cluster default). Extendable later; deletes only via explicit policy after retention.

**Recorded per request (minimum):**

| Field | Required |
| ----- | -------- |
| `request_id`, `trace_id`, timestamp (UTC) | Yes |
| Tenant / user id (pseudonymized if needed) | Yes |
| Model id + version + serving revision | Yes |
| Full prompt / messages (as served) | Yes |
| Full completion tokens (as returned) | Yes |
| Sampling params (temp, top_p, max_tokens, seed) | Yes |
| Token counts in/out, TTFT, TPOT, status, error | Yes |
| Router / expert stats (if available) | Research-preferred |
| Logprobs / top-k (optional, large) | Opt-in per project |
| Tool calls / RAG citations | When used |
| Content hash + schema version | Yes |

**Do not store on the critical path:** large binary attachments stay as object pointers; text payload is first-class.

#### Capacity planning model

Planning assumptions from cluster goals (~50 concurrent, ~32k context class, research use):

| Scenario | What is stored | Est. avg sustained | **1-year retained** (after compression) |
| -------- | -------------- | ------------------ | ----------------------------------------: |
| **Lean** | Text in/out + metadata; multi-turn **delta** or single final turns; zstd/parquet | ~0.5–2 TB/day raw → compress ~3–5× | **~50–150 TB** |
| **Standard research (default)** | Full prompts+completions each call; light metadata; parquet+zstd; some history duplication | ~2–8 TB/day raw → compress ~3–5× | **~200–600 TB** |
| **Full fidelity** | + logprobs / n-best / rich traces; frequent long 32k contexts | ~10–40 TB/day raw | **~1–3 PB** |

**Baseline procure for this program:** size the **object/archive lake for ≥ 750 TB usable** (covers standard research + headroom), with a growth path to **1.5–2 PB** without re-architecture. Revisit after 30–90 days of measured bytes/request.

Quick sanity math (standard):

```
~2 req/s average × 150 KB JSON-equivalent/request
  ≈ 25 GB/day uncompressed text-ish payload
  × research overhead / multi-turn / indexes ≈ 3–10×
  → hundreds of TB/year compressed columnar is realistic
```

Peak token generation (~1k tok/s) is **not** the archive size driver; **full prompt context logged per turn** is.

#### Archive performance targets

| Metric | Target |
| ------ | ------ |
| Ingest durability | Multi-AZ or erasure-coded object; no single disk loss of year |
| Write path | Async; p99 archive lag **≤ 60s** under normal load |
| Impact on TTFT | **None** (buffer + drop-oldest on extreme backlog with alert — research may forbid drop; then backpressure only non-interactive jobs) |
| Query | Partition by `day/model/tenant`; scan last 7d interactive; full-year batch OK |
| Immutability | WORM-optional; default append-only prefixes + lifecycle |

### 6.5 Node-Local Storage (already on GPU servers)

Each GPU server has **8× 3.84 TB NVMe** (~30 TB raw). Use as:

| Mount | Purpose |
| ----- | ------- |
| `/var/lib/kubelet` / containerd | Images, ephemeral |
| `/scratch` or hostPath | Shard download cache, compile cache |
| Optional KV offload dir | Framework spill (if enabled) |

**Not** primary model catalog. Rebuild-from-shared is the DR story for local cache.

### 6.6 Kubernetes Integration

| Mechanism | Use |
| --------- | --- |
| **CSI driver** (NFS, Weka, CephFS, Dell/Pure, etc.) | RWX for model weights + shared datasets |
| **PVC** `models-rwx` | Mounted read-mostly on all GPU pods |
| **initContainer** / Job | Stage weights → local NVMe if faster second start |
| **KServe StorageUri** | `pvc://` or `s3://` → runtime load |
| **Inference logger** | Sidecar or gateway plugin → bus/object (see §6.7) |
| **Image is not the model** | Do not bake multi-TB weights into images |

Example **serving** path:

```
KServe InferenceService
  storageUri: pvc://models-rwx/moe-3t/v2026-07-12/
       │
       ▼
GPU pod mounts PVC (CSI) → load to HBM
       │
       ├─► tokens to client
       └─► async InferenceRecord → archive pipeline
```

### 6.7 Inference Capture and 1-Year Archive Pipeline

Research requirement: **100% of inference traffic retained 1 year.**

```
 Client
   │
   ▼
 API Gateway  ── optional redaction / ToS flags
   │
   ▼
 Model Server (vLLM / TRT-LLM / KServe)
   │
   ├── response (sync)
   │
   └── InferenceRecord (async)
            │
            ▼
     Buffer (local NVMe ring or NATS/Redpanda/Kafka)
            │
            ▼
     Compactor workers (K8s Jobs/Deployments)
            │  validate schema, hash, compress
            ▼
     Object lake prefix (S3 API)
       s3://inference-archive/year=YYYY/month=MM/day=DD/model=.../
            │
            ├── hot landing NVMe (7–30 days, optional)
            └── lifecycle → colder erasure-coded packs
            │
            ▼
     Research engines: Ray, Spark, DuckDB, warehouse
```

| Stage | Tech direction | Notes |
| ----- | -------------- | ----- |
| Emit | OpenTelemetry gen-AI attrs **or** custom JSON schema | Stable `schema_version` |
| Transport | Kafka/Redpanda/NATS **or** direct multipart S3 | Prefer bus if multi-consumer |
| Format | **Parquet** (zstd) primary; JSONL only for debug | Columnar = year-scale scans |
| Partition | `day` / `model_version` / `tenant` | Prune queries |
| Index | Lightweight catalog DB (request_id → object key) | Point lookup without full scan |
| Retention | **365 days** default lifecycle rule | Legal hold flag available |
| Access | Read via research VPC/IAM; GPU path write-only key | Segregate credentials |

**Gateway vs sidecar:** prefer **API gateway or dedicated logger service** once, so multipod TP/EP shards do not multiply records. If logging at engine, **dedupe on `request_id`**.

**PII / policy:** research cluster still needs classification hooks (blocklist, user opt-out, secret scrub) before durable write; rejected payloads stored as tombstone + reason code when policy denies full text.

### 6.8 Data Layout

**Models (hot FS):**

```
/models/
  moe-3t/
    v2026-07-01/
    v2026-07-12/
      config.json
      shards...
      CHECKSUMS
  embeddings/
  adapters/
/datasets/
/eval/
/artifacts/
```

**Inference archive (object):**

```
s3://inference-archive/
  year=2026/month=07/day=18/
    model=moe-3t/ver=v2026-07-12/
      part-000.parquet
      part-001.parquet
  _catalog/
    request_id embeddings or SQLite/Postgres export
  _schema/
    v1.json
```

Promote models with immutable dirs + atomic `current`. Archive is append-only by day.

### 6.9 Platform Options

Split **hot model FS** from **year-long inference lake** (can be one product with two pools, or two products).

| Tier | Preferred options | Role |
| ---- | ----------------- | ---- |
| **Hot models** | Weka / BeeGFS / Lustre / FlashBlade-class NFS | Checkpoint load RWX |
| **Inference archive** | S3-compatible: Ceph RGW, MinIO, Vast, Pure, cloud-adjacent | 1-year lake, parquet |
| **Bus (optional)** | Redpanda / Kafka | Fan-out to archive + online eval |
| **Catalog** | Postgres / OpenSearch | request_id lookup, audit |

**Default recommendation:**

| Need | Choice |
| ---- | ------ |
| Model load | Parallel FS or appliance NFS on NVMe (100–250 TB) |
| 1-year inference | **S3 API object lake ≥ 750 TB usable**, erasure coding, lifecycle 365d |
| Research query | External table / Ray datasets over parquet prefixes |

### 6.10 Reference Hardware Footprint

| Component | Qty / size (indicative) |
| --------- | ----------------------: |
| Hot NVMe model (+ landing) | 3–6 nodes/appliance, **150–300 TB** usable |
| Archive object nodes or appliance | EC set, **≥ 750 TB** usable (path to 2 PB) |
| 400GbE to 7060DX5 leaves | 2–4 ports per storage node/pair |
| Archive ingest brokers (if used) | 3 VMs/nodes on mgmt or storage rack |
| OOB | All BMCs → 7010TX-48 |

Exact BOM: `docs/storage.md` / `docs/bom.md`.

### 6.11 Failure and Lifecycle

| Event | Behavior |
| ----- | -------- |
| Hot FS node loss | Models still load (repl/EC); slower start |
| Archive node loss | No loss of committed objects (EC/repl) |
| Bus backlog | Alert; expand consumers; **do not** block token stream unless policy=strict |
| Fabric leaf loss | ECMP dual-home storage + GPU |
| Bad model promote | Immutable versions; roll back InferenceService |
| GPU wipe | Re-pull models; local cache disposable |
| Day-366 | Lifecycle delete **or** legal-hold keep |
| Steady inference vs hot FS outage | Live QPS OK if weights loaded; **new** starts fail |
| Archive write outage | Live QPS OK; gap alarms; replay from buffer if any |

### 6.12 What Storage Does *Not* Do Here

- Not a substitute for HBM
- Not the MoE expert all-to-all path (GPU RoCE/NVLink)
- Not on 7010TX-48
- Not training-scale continuous multi-TB/s checkpoint writes
- Inference archive is **not** mounted as latency-critical RWX on GPU pods

### 6.13 Summary Integration Map

| Plane | Switch / system | Storage role |
| ----- | --------------- | ------------ |
| Data fabric | 7060DX5 | Models + archive ingest + research scans |
| OOB | 7010TX-48 | BMCs only |
| Hot FS | CSI RWX | Checkpoints |
| Object lake | S3 API | **1-year inference + artifacts** |
| Bus | Kafka/Redpanda (opt) | Reliable async capture |
| Local NVMe | GPU server | Cache / emit buffer |
| GPU HBM | B200 | Steady-state weights |

---

## 7. Kubernetes Architecture

### 7.1 Management Nodes

**Quantity:** 3 (HA control plane)

| Component | Spec |
| --------- | ---- |
| CPU | 32 cores |
| RAM | 256 GB |
| Storage | NVMe |

### 7.2 GPU Workers

```
worker01 … worker08
  each: 8× B200
```

### 7.3 Software Stack

```
Kubernetes
  └── NVIDIA GPU Operator
        └── CUDA
              └── TensorRT-LLM / vLLM
                    └── KServe
                          └── Ray (research / batch)
```

| Layer | Role |
| ----- | ---- |
| Kubernetes | Scheduling, HA, multi-tenancy |
| GPU Operator | Driver, device plugin, DCGM, MIG (if used) |
| vLLM / TensorRT-LLM | High-performance serving |
| KServe | Model serving CRDs, canary, autoscaling hooks |
| Ray | Research jobs, eval, offline batch |

---

## 8. Inference Request Flow

```
User
  → API Gateway
    → Authentication / Authorization
      → Inference Scheduler
        → Model Server
          → GPU Cluster
            → Response Tokens
```

### 8.1 Serving Requirements

| Attribute | Target direction |
| --------- | ---------------- |
| Latency | Interactive (TTFT + TPOT tuned) |
| Context | Up to 32k (initial planning assumption) |
| Concurrency | ~50 simultaneous users |
| Throughput | ~1,000 tokens/sec aggregate |

### 8.2 Capacity Sketch

```
50 concurrent users × 20 tokens/sec/user ≈ 1,000 tokens/sec
```

A 64× B200 cluster is in the correct range for this profile on a large MoE, subject to model/kernel tuning.

---

## 9. Power

### 9.1 Per GPU Rack (32 GPUs / 4 servers)

| Component | Watts |
| --------- | ----: |
| 4 GPU servers | ~40 kW |
| Rail leaves share + optics | ~2–3 kW |
| OOB / TOR share | ~0.5 kW |
| **GPU rack total** | **~43–46 kW** |

### 9.2 BOOT Rack

| Component | Watts |
| --------- | ----: |
| K8s + bootstrap + utilities | ~2–4 kW |
| Spines (2× DX5-64S) | ~1–1.5 kW |
| Bus / monitoring | ~1–2 kW |
| **BOOT total** | **~4–8 kW** |

### 9.3 STOR Rack

| Component | Watts |
| --------- | ----: |
| Hot FS + archive NVMe (day-1) | ~5–12 kW |
| Growth to ~1.5–2 PB | up to ~15 kW class |
| **STOR total (day-1)** | **~5–15 kW** |

### 9.4 Facility

| Item | Spec |
| ---- | ---- |
| Cluster IT load (baseline 4 racks) | **~100–115 kW** |
| Available facility power | **130–150 kW** recommended (headroom + STOR growth) |
| GPU rows | High-density 415 VAC, A/B; ~50 kW/rack class |
| BOOT + STOR | Standard density OK; A/B feeds |
| Feeds | A/B redundant all racks |

---

## 10. Cooling

| Tier | Approach |
| ---- | -------- |
| Minimum | Hot-aisle containment + high-airflow CRAC |
| Preferred | Rear-door heat exchangers |
| Future | Direct liquid cooling (DLC) |

Plan rack and facility layout so DLC retrofit is possible.

---

## 11. Monitoring and Observability

### 11.1 GPU

- NVIDIA DCGM
- GPU utilization
- HBM usage
- ECC errors
- NVLink health
- Power / thermal

### 11.2 Network

- Interface errors
- ECN marks
- Packet drops
- RoCE congestion counters
- Fabric latency / loss

### 11.3 Application

- Tokens/sec
- Time-to-first-token (TTFT)
- Time-per-output-token (TPOT)
- Queue depth
- GPU occupancy / KV-cache utilization
- Error rate / timeouts

---

## 12. High Availability

| Domain | Approach |
| ------ | -------- |
| Control plane | 3-node Kubernetes HA |
| Fabric | 8×400G/node rail leaves (7060DX5-32 ×8), dual spine (7060DX5-64) ECMP + DLB |
| Power | A/B feeds |
| Model serving | Multi-replica where parallelism allows; rolling updates via KServe |
| Storage | Redundant NVMe pool / erasure or replication per product |

Failure domains should align with racks and leaf pairs so a single leaf or rack loss does not take the full model offline if EP groups are placed carefully.

---

## 13. Expandability

| Path | Notes |
| ---- | ----- |
| +1 GPU rack (32 GPUs) | Add rail leaf capacity as needed, extend EVPN, join workers |
| +server within GPU rack | Power/cooling/RU headroom first |
| Storage growth in STOR | Add NVMe nodes/shelves until RU/power full |
| **+STOR-2** | When usable archive \>~1.5–2 PB or rack-level failure split |
| Multi-model | Partition expert groups / namespaces by team |

Initial design: **4 racks** with clear expansion to 5–6 (GPU-3, STOR-2) without redesigning fabric roles.

---

## 14. Approximate Cost

| Category | Estimate |
| -------- | -------: |
| 64× B200 GPUs | $4–6M |
| GPU servers | $1–1.5M |
| Network fabric | $1–1.5M |
| Storage | $500k |
| Rack / power / cooling | $500k |
| **Total** | **$7–10M** |

Costs are order-of-magnitude planning numbers only; obtain vendor quotes for procurement.

---

## 15. Final Design Recommendation

For a research organization running interactive multi-trillion MoE inference:

| Layer | Choice |
| ----- | ------ |
| Compute | 64× B200 / 8× 8-GPU nodes / **2 GPU racks** |
| Facility | **4 racks:** GPU-1, GPU-2, **BOOT**, **STOR** |
| Network | **8×400G/node** rail fabric: 8× DX5-32 + 2× DX5-64S; **7010TX-48** OOB |
| Storage | 100TB+ NVMe model repository |
| Platform | Kubernetes + GPU Operator + vLLM/TensorRT-LLM + KServe + Ray |
| Ops | DCGM + EOS/LANZ fabric telemetry + token-level SLOs |

This is the scale at which the system behaves like a real AI supercomputer while remaining operable by an enterprise infrastructure team.

---

## 16. Document Roadmap

Follow-on specs (to be written next):

1. `docs/bom.md` — bill of materials and SKUs  
2. `docs/network.md` — underlay, RoCE, QoS, IP plan  
3. ~~`docs/bootstrap.md`~~ — **done** (BOOT seed, Metal3/CAPI, Flux platform) + `bootstrap/`  
4. ~~`docs/netbox.md` / `docs/cabling.md`~~ — **done** (NetBox DCIM/IPAM SoT + cabling export)  
5. `docs/k8s.md` — day-2 cluster ops, tenancy, upgrades  
6. `docs/storage.md` — model repo layout and performance targets  
7. `docs/facility.md` — rack elevations, power, cooling  
8. `docs/slo.md` — latency/throughput SLOs and capacity model  

---

## Revision History

| Version | Date | Notes |
| ------- | ---- | ----- |
| 0.1 | 2026-07-18 | Initial specification |
| 0.2 | 2026-07-18 | Network standardized on Arista 7060DX5 (DX5-32 leaf, DX5-64S spine) |
| 0.3 | 2026-07-18 | Clarified lossless ≠ equal leaf/spine; added square Clos Option B |
| 0.4 | 2026-07-18 | OOB standardized on Arista 7010TX-48 (2×, 1 per rack) |
| 0.5 | 2026-07-18 | Storage integration: fabric, CSI/KServe, tiers, targets |
| 0.6 | 2026-07-18 | 1-year inference archive lake (≥750 TB usable, async capture) |
| 0.7 | 2026-07-18 | Host NIC 8×400G (1:1 GPU); rail-optimized 8 leaf + 2 spine |
| 0.8 | 2026-07-18 | Facility: 4 racks (2× GPU + BOOT + STOR); STOR-2 optional |
| 0.9 | 2026-07-18 | Bootstrap stack: seed + Metal3/CAPI + Flux platform (`bootstrap/`, `docs/bootstrap.md`) |
| 1.0 | 2026-07-18 | NetBox SoT: inventory, IPAM, cabling guide (`bootstrap/netbox/`, `docs/netbox.md`, `docs/cabling.md`) |
