// GENERATED from SPEC.md — do not edit. Regenerate: python3 docs/md2pdf.py
#import "docs/template.typ": *
#show: doc.with(title: "64× NVIDIA B200 AI Inference Cluster Specification", kicker: "AIDATACENTER — SPECIFICATION", rev: "1.3 · 2026-07-19")

#strong[Status:] Draft \
#strong[Purpose:] Production research AI platform for interactive
inference of multi-trillion parameter MoE models \
#strong[Scale:] \~1,000 registered users, \~50 concurrent \
#strong[Data retention:] All inference retained #strong[1 year]
(research archive)

#horizontalrule

= Design Goals
<design-goals>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Priority], [Goal],),
    table.hline(),
    [1], [Interactive inference latency],
    [2], [Large model support (multi-trillion MoE)],
    [3], [Research workload flexibility],
    [4], [High availability],
    [5], [Expandability],
  )]
  , kind: table
  )

This is #strong[not] a maximum-throughput hyperscale training cluster.
It is a manageable enterprise research inference platform.

#horizontalrule

= Physical Summary
<physical-summary>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,right,),
    table.header([Item], [Specification],),
    table.hline(),
    [GPUs], [#strong[64× NVIDIA B200]],
    [GPU servers], [8],
    [GPUs per server], [8],
    [#strong[Racks (baseline)]], [#strong[4] (2× GPU + 1× bootstrap + 1×
    storage)],
    [GPU rack density], [32 GPUs/rack (4 servers)],
    [Fabric], [400GbE RoCEv2 rail-optimized (Arista 7060DX5)],
    [NICs], [#strong[8× 400GbE per server] (1:1 with GPUs)],
    [Orchestration], [Kubernetes + NVIDIA GPU Operator],
    [Primary workload], [MoE LLM inference],
  )]
  , kind: table
  )

#horizontalrule

= Rack Layout and Facility Zones
<rack-layout-and-facility-zones>
== How many racks?
<how-many-racks>
#figure(
  align(center)[#table(
    columns: (23.53%, 23.53%, 52.94%),
    align: (auto,auto,auto,),
    table.header([Rack], [Role], [Required?],),
    table.hline(),
    [#strong[GPU-1]], [4× B200 servers (32 GPUs) + rail leaves share +
    OOB], [Yes],
    [#strong[GPU-2]], [4× B200 servers (32 GPUs) + rail leaves share +
    OOB], [Yes],
    [#strong[BOOT]], [DC bootstrap / management / control
    plane], [#strong[Yes (minimum 1)]],
    [#strong[STOR]], [Hot model FS + 1-year inference object
    lake], [#strong[Yes (1 is enough at this scale)]],
    [STOR-2], [Archive growth / second failure domain], [Optional
    (phase-2)],
    [GPU-3], [+32 GPUs expansion], [Optional (phase-2)],
  )]
  , kind: table
  )

#strong[Baseline footprint: 4 racks.] \
You do #strong[not] need a second storage rack for day-1 750 TB--1.5 PB
usable flash if nodes/appliances are dense. Add #strong[STOR-2] when
archive exceeds \~1.5--2 PB usable, you want rack-level failure
isolation for the lake, or you separate “hot models” from “cold year
archive” physically by policy.

== Why a dedicated BOOT rack?
<why-a-dedicated-boot-rack>
Keep bootstrap #strong[off] the GPU power/cooling failure domain and
free GPU RU for compute + rail optics.

#figure(
  align(center)[#table(
    columns: (38.1%, 61.9%),
    align: (auto,auto,),
    table.header([Function], [Lives in BOOT],),
    table.hline(),
    [K8s control plane (3 nodes)], [Yes],
    [PXE / image / iPXE / Metal3 or MAAS], [Yes],
    [DNS, DHCP, NTP, IPA/LDAP jump], [Yes],
    [#strong[NetBox (DCIM / IPAM / cabling SoT)]], [Yes],
    [GitOps, registry, Vault/secrets], [Yes],
    [Monitoring / logging (Prometheus, Loki, …)], [Yes],
    [Inference archive bus brokers (Kafka/Redpanda) if compact], [Often
    here],
    [CloudVision / NMS (optional)], [Yes],
    [Console servers, serial, crash carts path], [Yes],
    [Spines and/or border (optional co-locate)], [Prefer here or row
    end],
    [Storage data plane nodes], [#strong[No] → STOR],
    [GPU workers], [#strong[No] → GPU-1/2],
  )]
  , kind: table
  )

BOOT is #strong[lightweight RU and kW] compared to GPU; one 42--48U rack
is enough with headroom.

== Why one STOR rack (usually)?
<why-one-stor-rack-usually>
#figure(
  align(center)[#table(
    columns: (12.9%, 32.26%, 54.84%),
    align: (auto,auto,auto,),
    table.header([Tier], [Day-1 size], [Fits in one rack?],),
    table.hline(),
    [Hot models + landing], [150--300 TB usable NVMe], [Yes (3--6 nodes
    or 1--2 appliances)],
    [Inference archive], [≥750 TB usable (path 1.5--2
    PB)], [#strong[Yes] with dense NVMe/object nodes or one scale-out
    appliance + shelves],
    [Future 2 PB+ or dual-site style isolation], [---], [Plan
    #strong[STOR-2]],
  )]
  , kind: table
  )

Storage is #strong[network-attached on 7060DX5], not DAS to GPUs.
Physical separation from GPU racks is good practice (blast radius,
service windows); a #emph[second] storage rack is capacity/isolation
driven, not a hard topology requirement at 64-GPU scale.

== Baseline elevation (logical)
<baseline-elevation-logical>
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

\* Prefer #strong[spines in BOOT] (or dedicated network bay) so GPU
racks stay power-dense for servers + busbars. Rail #strong[leaves] stay
close to GPU NICs (short DAC/AOC) → place in #strong[GPU-1 / GPU-2].

== Per-rack contents (RU budget sketch)
<per-rack-contents-ru-budget-sketch>
Assumes \~42--48U racks; numbers are planning, not final elevation
drawings.

=== GPU-1 / GPU-2 (each)
<gpu-1-gpu-2-each>
#figure(
  align(center)[#table(
    columns: 3,
    align: (auto,right,right,),
    table.header([Contents], [Qty], [RU (approx)],),
    table.hline(),
    [B200 8-GPU servers (Dell XE9680)], [4], [24 (6U each)],
    [Rail leaf 7060DX5-32 (share of 8)], [3--5], [3--5],
    [OOB 7010TX-48], [1], [1],
    [Patch / fiber manager], [1--2], [2--4],
    [rPDU A/B], [2], [0--2],
    [#strong[Headroom]], [], [reserve for optics density],
  )]
  , kind: table
  )

Cable: 4 servers × 8×400G = #strong[32× 400G] host links per GPU rack.

=== BOOT
<boot>
#figure(
  align(center)[#table(
    columns: 3,
    align: (auto,right,right,),
    table.header([Contents], [Qty], [RU (approx)],),
    table.hline(),
    [K8s control plane], [3], [3--6],
    [Bootstrap / utility], [2--4], [2--8],
    [Spines 7060DX5-64S], [2], [4],
    [Optional service leaf ports / border], [0--1], [1--2],
    [Redpanda/Kafka (if not on STOR)], [3], [3--6],
    [Catalog DB / monitoring], [2--4], [2--8],
    [OOB uplink aggregation / jump], [1], [1--2],
    [Console / KVM], [1], [1],
    [#strong[Headroom]], [], [large (growth, CVP, labs)],
  )]
  , kind: table
  )

=== STOR
<stor>
#figure(
  align(center)[#table(
    columns: (36.36%, 13.64%, 50%),
    align: (auto,right,right,),
    table.header([Contents], [Qty], [RU (approx)],),
    table.hline(),
    [Hot NVMe FS nodes or appliance], [3--6 or 1--2], [6--20],
    [Archive object nodes / shelves], [EC set], [8--20],
    [Storage 400G leaf attachment (or dual-home to fabric)], [via GPU
    row leaves or local ToR ports], [---],
    [Storage BMC → OOB (extend from BOOT/GPU OOB)], [---], [---],
    [#strong[Headroom]], [], [for +shelves before STOR-2],
  )]
  , kind: table
  )

== Decision summary
<decision-summary>
#figure(
  align(center)[#table(
    columns: (57.14%, 42.86%),
    align: (auto,auto,),
    table.header([Question], [Answer],),
    table.hline(),
    [Need BOOT rack?], [#strong[Yes --- at least one]],
    [Need extra racks for storage day-1?], [#strong[One STOR rack is
    enough] for hot + ≥750 TB archive],
    [When add STOR-2?], [\>\~1.5--2 PB usable, rack failure domain
    split, or policy isolation hot vs cold],
    [Total baseline racks], [#strong[4]],
    [Power domains], [GPU-1/2 high-kW; BOOT + STOR normal enterprise
    power],
  )]
  , kind: table
  )

#horizontalrule

= Compute Nodes
<compute-nodes>
== GPU Server Platform
<gpu-server-platform>
#strong[Standard platform: Dell PowerEdge XE9680] --- #strong[8
servers].

#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Item], [Specification],),
    table.hline(),
    [Model], [Dell PowerEdge XE9680],
    [Chassis], [6U rack server, air-cooled],
    [GPU tray], [NVIDIA HGX B200 (8× SXM)],
    [Quantity], [#strong[8] (4× GPU-1 + 4× GPU-2)],
  )]
  , kind: table
  )

Alternates considered (not selected): NVIDIA MGX B200, HPE Cray XD,
Supermicro HGX B200, Lenovo ThinkSystem AI. The rail/NIC/rack design is
portable to any HGX B200-class 8-GPU node; BOM and RU drawings assume
XE9680.

== Per-Server Specification
<per-server-specification>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Component], [Specification],),
    table.hline(),
    [Chassis], [Dell PowerEdge XE9680 (6U, air-cooled)],
    [GPU], [8× NVIDIA B200 (SXM, HGX B200)],
    [GPU memory], [\~1.4 TB HBM3e],
    [GPU compute], [\~1.4 PFLOPS FP8 (approx.)],
    [CPU], [2× Intel Xeon Scalable (4th/5th Gen)],
    [CPU cores], [96--128],
    [System RAM], [2 TB DDR5 ECC],
    [Boot], [2× M.2 1.92 TB NVMe RAID1 (BOSS-N1)],
    [Local NVMe], [8× 3.84 TB],
    [Data network], [#strong[8× 400GbE] (1 NIC per GPU;
    rail-optimized)],
    [NIC class], [ConnectX-7 / BlueField-3 SuperNIC (PCIe Gen5 x16
    slots)],
    [GPU↔NIC], [PCIe locality / GPUDirect RDMA; NIC paired to each
    B200],
    [Management], [1× 1GbE dedicated (iDRAC9)],
    [Power], [8--10 kW],
  )]
  , kind: table
  )

== Cluster Aggregate Capacity
<cluster-aggregate-capacity>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,right,),
    table.header([Resource], [Amount],),
    table.hline(),
    [GPUs], [64],
    [HBM3e memory], [\~11.5 TB],
    [CPU cores], [\~1,000],
    [System RAM], [16 TB],
    [Local NVMe], [\~250 TB],
    [GPU FP8 compute], [\~11--12 PFLOPS],
    [Host 400G ports], [#strong[64] (8 servers × 8 NICs)],
    [Cluster host edge], [#strong[25.6 Tbps]],
  )]
  , kind: table
  )

#horizontalrule

= GPU Parallelism Model
<gpu-parallelism-model>
For a \~3T MoE model, do #strong[not] run one giant tensor-parallel job
across all GPUs by default.

== Logical Layout
<logical-layout>
```
                    Model Router
                          |
           +--------------+--------------+
           |              |              |
    Expert Group 1  Expert Group 2  Expert Group 3  Expert Group 4
       GPU 0–15        GPU 16–31       GPU 32–47       GPU 48–63
```

== Parallelism Dimensions
<parallelism-dimensions>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Dimension], [Role],),
    table.hline(),
    [TP], [Tensor parallel (within node / NVLink domain)],
    [EP], [Expert parallel (across nodes over fabric)],
    [PP], [Pipeline parallel (optional depth split)],
  )]
  , kind: table
  )

== Example Configurations
<example-configurations>
```
TP=8, EP=8, PP=1
TP=4, EP=16, PP=1
```

Exact values depend on model architecture, expert count, and latency
targets.

#horizontalrule

= Network Architecture
<network-architecture>
For MoE inference, the fabric is part of the computer.

#strong[Standard platform:] Arista #strong[7060DX5] series, EOS,
optional CloudVision.

== Host NIC Model --- 1× 400GbE per GPU (required baseline)
<host-nic-model-1-400gbe-per-gpu-required-baseline>
Prior drafts assumed #strong[2× 400G per server]. That is a common
#emph[shared-NIC] enterprise pattern and is #strong[insufficient] as the
baseline for this B200 MoE cluster.

#figure(
  align(center)[#table(
    columns: (18.52%, 48.15%, 33.33%),
    align: (auto,right,auto,),
    table.header([Model], [NICs / server], [When used],),
    table.hline(),
    [Shared PCIe NIC], [1--2× 400G], [Light east-west; many general GPU
    clouds],
    [#strong[Rail-optimized (this design)]], [#strong[8×
    400G]], [#strong[1 NIC per GPU]\; GPUDirect RDMA; MoE EP / NCCL],
  )]
  , kind: table
  )

#strong[Baseline:] each B200 has a #strong[dedicated 400GbE] adapter
(ConnectX-7 or BlueField-3 SuperNIC), PCIe-local to that GPU.

```
  GPU0 ── NIC0 ── 400G ── Rail-0 leaf
  GPU1 ── NIC1 ── 400G ── Rail-1 leaf
  ...
  GPU7 ── NIC7 ── 400G ── Rail-7 leaf
```

Why 1:1:

#figure(
  align(center)[#table(
    columns: (50%, 50%),
    align: (auto,auto,),
    table.header([Reason], [Effect],),
    table.hline(),
    [GPUDirect RDMA], [GPU↔NIC without hairpin through another GPU's
    root complex],
    [Avoid PCIe bottleneck], [8 GPUs sharing 1--2 NICs saturates host
    I/O under EP],
    [Rail scheduling], [Same GPU index on every node lands on the same
    leaf (NCCL multi-rail)],
    [Predictable EP], [Expert-parallel all-to-all maps cleanly onto
    rails],
  )]
  , kind: table
  )

#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Scope], [Bandwidth],),
    table.hline(),
    [Per GPU], [400 Gbps],
    [Per server], [#strong[3.2 Tbps] (8×400G)],
    [Cluster host edge], [#strong[25.6 Tbps] (64×400G)],
  )]
  , kind: table
  )

== Fabric Requirements
<fabric-requirements>
#figure(
  align(center)[#table(
    columns: (38.89%, 61.11%),
    align: (auto,auto,),
    table.header([Feature], [Requirement],),
    table.hline(),
    [Platform], [Arista 7060DX5],
    [NOS], [Arista EOS],
    [Link speed], [400GbE (QSFP-DD)],
    [Host NICs], [#strong[8× 400G per GPU server] (1:1)],
    [Topology], [#strong[Rail-optimized] leaf tier + spine],
    [Transport], [RoCEv2],
    [Congestion], [ECN, PFC, DCQCN / advanced congestion mgmt],
    [Load balancing], [ECMP + Dynamic Load Balancing (DLB); rail-aware
    where applicable],
    [Overlay / control], [BGP EVPN (VXLAN as needed)],
    [Automation], [eAPI / CloudVision],
    [Tuning], [AI / lossless Ethernet profile],
  )]
  , kind: table
  )

== Topology Rules
<topology-rules>
#strong[RoCEv2 lossless Ethernet does not require equal leaf and spine
counts] --- but #strong[rail count usually matches GPUs per node] (here
#strong[8 rails → 8 rail leaves]).

What keeps MoE/EP well-behaved:

#figure(
  align(center)[#table(
    columns: (44%, 56%),
    align: (auto,auto,),
    table.header([Requirement], [Why it matters],),
    table.hline(),
    [1 NIC per GPU], [Removes host NIC as the EP bottleneck],
    [Rail-aligned wiring], [GPU-#emph[i] on all nodes → same rail leaf],
    [Low / zero oversub leaf→spine], [Cross-rail / non-rail traffic
    stays non-blocking],
    [PFC + ECN + DCQCN], [Lossless without pause storms],
    [ECMP / DLB on spine tier], [Spread cross-rail flows],
    [Jumbo MTU end-to-end], [Lower PPS],
    [Buffer + queue telemetry], [Microburst visibility],
  )]
  , kind: table
  )

Spine count still follows bandwidth math (not “must equal leaf count”
for lossless protocol reasons):

```
Σ leaf uplink BW  ≥  Σ leaf downlink (host) BW   # for 1:1 non-blocking
```

== Topology --- Rail-Optimized (default)
<topology-rail-optimized-default>
=== Default: 8 rail leaves + 2 spines
<default-8-rail-leaves-2-spines>
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

#figure(
  align(center)[#table(
    columns: (23.53%, 29.41%, 17.65%, 29.41%),
    align: (auto,auto,right,auto,),
    table.header([Role], [Model], [Qty], [Notes],),
    table.hline(),
    [Rail leaf], [#strong[DCS-7060DX5-32]], [#strong[8]], [One leaf per
    GPU index (rail 0--7)],
    [Spine], [#strong[DCS-7060DX5-64S] (or
    64E)], [#strong[2]], [Cross-rail + storage/services],
  )]
  , kind: table
  )

#strong[Host fan-in per rail leaf:] 8 servers × 1 NIC = #strong[8× 400G]
downlinks (3.2 Tbps).

#strong[1:1 leaf→spine example:] ≥ #strong[8× 400G] uplink per rail leaf
(e.g.~4×400G to each spine). \
8 leaves × 8 uplinks = #strong[64] leaf--spine 400G links → fits cleanly
on #strong[2× 64-port] spines with ports left for storage/border.

=== Optional: single-SKU square Clos
<optional-single-sku-square-clos>
Use #strong[8× DX5-32 spine] (or keep 2× 64S) if procurement wants all
leafy SKUs. Still #strong[8 rail leaves]\; spine count is HA/BW, not
“must be 8” for lossless.

=== Placement
<placement>
#figure(
  align(center)[#table(
    columns: (66.67%, 33.33%),
    align: (auto,auto,),
    table.header([Location], [Gear],),
    table.hline(),
    [Rack 1], [worker01--04 + share of rail leaves / OOB],
    [Rack 2], [worker05--08 + remaining rail leaves / OOB],
    [Leaves may be split across racks; #strong[rail identity is
    logical], not “one rack owns four rails” only], [],
  )]
  , kind: table
  )

Cable so #strong[GPU0 from every server → Rail0 leaf], etc., regardless
of rack.

== Leaf Switches --- Arista 7060DX5-32 (rail leaves)
<leaf-switches-arista-7060dx5-32-rail-leaves>
#strong[Quantity:] #strong[8] \
#strong[SKU class:] DCS-7060DX5-32

#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Feature], [Value],),
    table.hline(),
    [Ports], [32× 400G QSFP-DD],
    [Breakout], [up to 128× 100G],
    [L2/L3 throughput], [12.8 Tbps],
    [Forwarding], [\~5.3 Bpps],
    [Packet buffer], [57 MB shared],
    [Latency], [from \~850 ns],
    [Typical power], [\~289 W],
    [Airflow], [F-R or R-F (match rack)],
    [HA hardware], [1+1 PSU, N+1 fans],
    [Routing], [BGP EVPN, 128-way ECMP],
    [AI features], [DLB, advanced congestion, LANZ],
    [QoS], [PFC / ECN for RoCEv2],
  )]
  , kind: table
  )

== Spine Switches --- 7060DX5-64 (qty 2)
<spine-switches-7060dx5-64-qty-2>
#figure(
  align(center)[#table(
    columns: (15.38%, 12.82%, 12.82%, 25.64%, 15.38%, 5.13%, 12.82%),
    align: (auto,auto,auto,auto,auto,auto,auto,),
    table.header([Option], [Model], [Ports], [Throughput], [Buffer], [RU], [Notes],),
    table.hline(),
    [#strong[A1 (preferred)]], [#strong[DCS-7060DX5-64S]], [64× 400G
    QSFP-DD], [25.6 Tbps], [114 MB], [2], [Native 400G],
    [A2], [#strong[DCS-7060DX5-64E]], [32× 800G → 64× 400G], [25.6
    Tbps], [114 MB], [1], [800G path],
  )]
  , kind: table
  )

#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Feature], [Value],),
    table.hline(),
    [ECMP], [up to 128-way],
    [Latency], [from \~850 ns],
    [Typical power], [\~489 W (64S) / \~548 W (64E)],
    [Airflow], [Front-to-rear],
    [HA hardware], [1+1 PSU, N+1 fans],
  )]
  , kind: table
  )

#strong[Default procurement:] #strong[8× DX5-32 rail leaf + 2× DX5-64S
spine].

== Server Connectivity (per GPU server)
<server-connectivity-per-gpu-server>
```
        Dell PowerEdge XE9680 (HGX B200, 8 GPUs)
        ├── GPU0 ── NIC0 ── 400G ── Rail-0 leaf
        ├── GPU1 ── NIC1 ── 400G ── Rail-1 leaf
        ├── GPU2 ── NIC2 ── 400G ── Rail-2 leaf
        ├── GPU3 ── NIC3 ── 400G ── Rail-3 leaf
        ├── GPU4 ── NIC4 ── 400G ── Rail-4 leaf
        ├── GPU5 ── NIC5 ── 400G ── Rail-5 leaf
        ├── GPU6 ── NIC6 ── 400G ── Rail-6 leaf
        └── GPU7 ── NIC7 ── 400G ── Rail-7 leaf
```

Within the node, #strong[TP prefers NVLink]\; NICs carry
#strong[inter-node EP/PP], storage, and control that is mapped onto data
NICs. Do not design as if 8 GPUs share two uplinks.

#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Scope], [Bandwidth],),
    table.hline(),
    [Per GPU / NIC], [400 Gbps],
    [Per server], [#strong[3.2 Tbps]],
    [Cluster host edge], [#strong[25.6 Tbps] (64× 400G)],
  )]
  , kind: table
  )

== Port Plan (Planner Baseline)
<port-plan-planner-baseline>
#strong[Per rail leaf (7060DX5-32):]

#figure(
  align(center)[#table(
    columns: 3,
    align: (auto,right,auto,),
    table.header([Use], [Ports], [Speed],),
    table.hline(),
    [GPU rail downlinks (8 workers ×
    GPU-#emph[i])], [#strong[8]], [400G],
    [Spine uplinks (1:1 → \~8 total)], [#strong[8]], [400G],
    [Storage / services (subset of leaves)], [0--4], [400G],
    [Spare / growth], [remainder], [400G],
  )]
  , kind: table
  )

Leaf front-panel: 8 down + 8 up = 16 ports used for pure compute fabric;
32-port SKU has headroom.

#strong[Per spine (7060DX5-64S):]

#figure(
  align(center)[#table(
    columns: 3,
    align: (auto,right,auto,),
    table.header([Use], [Ports (example)], [Speed],),
    table.hline(),
    [Rail leaf uplinks (8 leaves × 4)], [#strong[32]], [400G],
    [\(if 8 uplinks/leaf: 8×8)], [#strong[64]], [400G],
    [Storage cluster], [2--8], [400G],
    [Border / DCI / services], [2--4], [400G],
    [Spare], [remainder], [400G],
  )]
  , kind: table
  )

With #strong[8 uplinks per leaf], two 64-port spines are fully
subscribed on leaf-facing ports if split 32+32 --- size storage on extra
spines/ports or reduce leaf uplinks only if accepting oversub.

== Optics and Cabling
<optics-and-cabling>
#figure(
  align(center)[#table(
    columns: (21.05%, 78.95%),
    align: (auto,auto,),
    table.header([Link], [Preferred media],),
    table.hline(),
    [Server ↔ leaf (same rack)], [400G-DR4 / DAC or AOC as length
    allows],
    [Leaf ↔ spine (in-row / adjacent)], [400G-DR4 or FR4 per plant
    standards],
    [Connector], [QSFP-DD on 7060DX5-32 / 64S],
    [Spares], [20% optics/cables minimum],
  )]
  , kind: table
  )

Exact optics SKUs finalized in `docs/bom.md` and `docs/network.md`.

== RoCEv2 / AI Ethernet Profile (Arista EOS)
<rocev2-ai-ethernet-profile-arista-eos>
Required fabric behaviors for MoE all-to-all / EP traffic:

#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Control], [Setting direction],),
    table.hline(),
    [Priority flow control], [Lossless queue for RoCE PFC priority],
    [ECN], [Enabled on RoCE queue; mark before drop],
    [DCQCN], [Host CNP reaction; switch ECN marking thresholds tuned],
    [DLB], [Prefer Dynamic Load Balancing over static hash for large
    flows],
    [MTU], [Jumbo (e.g.~9000) end-to-end],
    [ECMP], [Max-path ≥ leaf uplink count; resilient hashing],
    [Telemetry], [LANZ / queue depth; drop & ECN counters scraped],
  )]
  , kind: table
  )

== Out-of-Band / Management Network
<out-of-band-management-network>
Separate from the 400G RoCE fabric. #strong[Never] carry GPU data-plane
traffic.

#strong[Standard platform:] Arista #strong[7010TX-48] (7010X series),
EOS.

=== Platform
<platform>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Item], [Spec],),
    table.hline(),
    [Model], [#strong[DCS-7010TX-48] (AC) or #strong[DCS-7010TX-48-DC]],
    [Form factor], [1RU],
    [Access ports], [48× 10/100/1000BASE-T (RJ45)],
    [Uplinks], [4× SFP28 (1/10/25GbE)],
    [Throughput], [296 Gbps / \~220 Mpps],
    [Buffer], [4 MB shared],
    [Power], [1+1 redundant PSU],
    [Fans], [1+1 hot-swap; reversible airflow],
    [NOS], [Arista EOS (same family as 7060DX5)],
  )]
  , kind: table
  )

Related SKUs: `7010TX-48C` / `7010TX-48C-DC` if copper/console variant
needed per quote.

=== Quantity and placement
<quantity-and-placement>
#figure(
  align(center)[#table(
    columns: (25%, 18.75%, 56.25%),
    align: (auto,right,auto,),
    table.header([Role], [Qty], [Placement],),
    table.hline(),
    [OOB leaf], [#strong[2]], [1 per GPU rack (baseline)],
    [Optional 3rd], [1], [Management rack (K8s + storage BMCs) if port
    pressure],
  )]
  , kind: table
  )

Two OOB switches are dual-homed uplink or MLAG pair so a single OOB
switch failure does not black-hole BMC access.

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

=== What attaches to 7010TX-48
<what-attaches-to-7010tx-48>
#figure(
  align(center)[#table(
    columns: 3,
    align: (auto,auto,auto,),
    table.header([Endpoint], [Speed], [Notes],),
    table.hline(),
    [GPU server BMC (iDRAC)], [1G], [Always-on lights-out],
    [GPU server mgmt NIC (mgmt0)], [1G], [OS install / PXE (VLAN 10)],
    [K8s control-plane mgmt], [1G], [Dedicate ports; not RoCE NICs],
    [7060DX5 Management1], [1G], [Out-of-band EOS mgmt + #strong[ZTP]],
    [Storage / PDU / serial consoles], [1G], [As present],
    [CloudVision / jump / IPMI tools], [1G], [Ops plane],
  )]
  , kind: table
  )

=== Port budget (per rack, 4 GPU servers)
<port-budget-per-rack-4-gpu-servers>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,right,),
    table.header([Use], [Ports (approx.)],),
    table.hline(),
    [4× GPU BMC], [4],
    [4× OS mgmt NIC (optional)], [0--4],
    [2× leaf 7060DX5 mgmt], [2],
    [1× spine share or local], [0--1],
    [PDU / rPDU], [2--4],
    [Console server], [1],
    [Spares], [remainder of 48],
  )]
  , kind: table
  )

48 ports per rack is comfortable at this scale.

=== Uplinks
<uplinks>
#figure(
  align(center)[#table(
    columns: (50%, 50%),
    align: (auto,auto,),
    table.header([Item], [Spec],),
    table.hline(),
    [Ports], [1--2× 10G (or 25G) SFP28 per 7010TX-48],
    [Target], [Redundant path to mgmt/core or services block],
    [HA], [#strong[MLAG pair] between the two 7010TX-48 (peer-link 2×
    SFP28) --- design in `docs/network.md` §4],
  )]
  , kind: table
  )

OOB is #strong[loss-tolerant best-effort] (no RoCE PFC). Do not enable
lossless QoS on 7010TX-48.

=== Security
<security>
#figure(
  align(center)[#table(
    columns: (38.89%, 61.11%),
    align: (auto,auto,),
    table.header([Control], [Requirement],),
    table.hline(),
    [Isolation], [Dedicated VRF / VLAN; no route to RoCE data VRF except
    controlled jump],
    [Access], [MFA jump host; no public BMC],
    [ACLs], [Allow only mgmt subnets → BMC/IPMI/SSH/HTTPS],
    [Logging], [EOS AAA + syslog/telemetry to ops stack],
  )]
  , kind: table
  )

#horizontalrule

= Storage
<storage>
Inference is #strong[not] a training I/O path. Storage must be fast
enough to #strong[load multi-TB MoE checkpoints], hold versions, and
support research artifacts --- without competing with RoCE expert
traffic incorrectly, and without needing an all-flash training forge.

== Role of Storage in This Cluster
<role-of-storage-in-this-cluster>
#figure(
  align(center)[#table(
    columns: (8.16%, 24.49%, 28.57%, 38.78%),
    align: (auto,auto,auto,auto,),
    table.header([Path], [When it runs], [Bandwidth need], [Latency
      sensitivity],),
    table.hline(),
    [#strong[Model cold start / rollout]], [Deploy, restart, scale,
    canary], [High burst (tens of GB/s cluster)], [Startup time only],
    [#strong[Steady inference]], [After weights in HBM/DRAM], [Near-zero
    for weights], [Tokens from GPU HBM],
    [#strong[Inference archive (1 year)]], [Every request
    (async)], [Sustained write + research scan], [Write path must not
    block TTFT],
    [#strong[KV / prefix cache spill] (optional)], [Long context /
    multi-tenant], [Medium, local-first], [Moderate],
    [#strong[Datasets / eval / embeddings]], [Research jobs
    (Ray)], [Medium sequential], [Low--medium],
    [#strong[Ops metrics / traces]], [Always], [Low], [Low],
  )]
  , kind: table
  )

Design principles:

+ #strong[Weights] live on hot shared NVMe; steady-state path is GPU
  HBM. \
+ #strong[All inference] (prompts, completions, metadata) is retained
  #strong[≥ 1 year] for research. \
+ Archive write is #strong[async / sidecar] --- never on the critical
  token path.

== Logical Architecture
<logical-architecture>
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

== Integration with the Network
<integration-with-the-network>
Storage attaches to the #strong[same Arista 7060DX5 data fabric] as GPU
servers (not the 7010TX-48 OOB).

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

#figure(
  align(center)[#table(
    columns: (50%, 50%),
    align: (auto,auto,),
    table.header([Item], [Spec],),
    table.hline(),
    [Fabric], [7060DX5 leaf-spine],
    [Host mount path], [GPU NICs (data plane), not BMC/OOB],
    [Isolation], [Dedicated #strong[storage VRF] or VLAN; QoS separate
    from pure RoCE EP class if needed],
    [Transport], [NFS/RDMA, Weka/BeeGFS/Lustre client, or S3 over
    TCP/HTTP --- product-dependent],
    [Oversubscription], [Storage uplinks sized so model load does not
    starve EP if sharing queues; prefer #strong[separate DSCP/PFC
    priority] for storage vs RoCE bulk if mixed],
  )]
  , kind: table
  )

#strong[BMC / storage controllers] → 7010TX-48 OOB only.

== Capacity and Performance Targets
<capacity-and-performance-targets>
=== Hot tier (models + short landing)
<hot-tier-models-short-landing>
#figure(
  align(center)[#table(
    columns: (50%, 50%),
    align: (auto,auto,),
    table.header([Metric], [Target],),
    table.hline(),
    [Usable NVMe], [#strong[100--250 TB] models + #strong[20--50 TB]
    inference landing],
    [Single large MoE checkpoint], [#strong[5--40 TB] compressed/sharded
    per version],
    [Concurrent model versions], [3--5 online],
    [Aggregate model read], [#strong[≥ 40 GB/s] (stretch 80+)],
    [Single-node model read], [#strong[≥ 10--20 GB/s]],
  )]
  , kind: table
  )

=== Inference archive tier (1-year retention) --- #strong[required]
<inference-archive-tier-1-year-retention-required>
#strong[Policy:] retain #strong[every] inference exchange for
#strong[365 days] (research cluster default). Extendable later; deletes
only via explicit policy after retention.

#strong[Recorded per request (minimum):]

#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Field], [Required],),
    table.hline(),
    [`request_id`, `trace_id`, timestamp (UTC)], [Yes],
    [Tenant / user id (pseudonymized if needed)], [Yes],
    [Model id + version + serving revision], [Yes],
    [Full prompt / messages (as served)], [Yes],
    [Full completion tokens (as returned)], [Yes],
    [Sampling params (temp, top\_p, max\_tokens, seed)], [Yes],
    [Token counts in/out, TTFT, TPOT, status, error], [Yes],
    [Router / expert stats (if available)], [Research-preferred],
    [Logprobs / top-k (optional, large)], [Opt-in per project],
    [Tool calls / RAG citations], [When used],
    [Content hash + schema version], [Yes],
  )]
  , kind: table
  )

#strong[Do not store on the critical path:] large binary attachments
stay as object pointers; text payload is first-class.

=== Capacity planning model
<capacity-planning-model>
Planning assumptions from cluster goals (\~50 concurrent, \~32k context
class, research use):

#figure(
  align(center)[#table(
    columns: (9.88%, 17.28%, 22.22%, 50.62%),
    align: (auto,auto,auto,right,),
    table.header([Scenario], [What is stored], [Est. avg
      sustained], [#strong[1-year retained] (after compression)],),
    table.hline(),
    [#strong[Lean]], [Text in/out + metadata; multi-turn #strong[delta]
    or single final turns; zstd/parquet], [\~0.5--2 TB/day raw →
    compress \~3--5×], [#strong[\~50--150 TB]],
    [#strong[Standard research (default)]], [Full prompts+completions
    each call; light metadata; parquet+zstd; some history
    duplication], [\~2--8 TB/day raw → compress
    \~3--5×], [#strong[\~200--600 TB]],
    [#strong[Full fidelity]], [+ logprobs / n-best / rich traces;
    frequent long 32k contexts], [\~10--40 TB/day raw], [#strong[\~1--3
    PB]],
  )]
  , kind: table
  )

#strong[Baseline procure for this program:] size the
#strong[object/archive lake for ≥ 750 TB usable] (covers standard
research + headroom), with a growth path to #strong[1.5--2 PB] without
re-architecture. Revisit after 30--90 days of measured bytes/request.

Quick sanity math (standard):

```
~2 req/s average × 150 KB JSON-equivalent/request
  ≈ 25 GB/day uncompressed text-ish payload
  × research overhead / multi-turn / indexes ≈ 3–10×
  → hundreds of TB/year compressed columnar is realistic
```

Peak token generation (\~1k tok/s) is #strong[not] the archive size
driver; #strong[full prompt context logged per turn] is.

=== Archive performance targets
<archive-performance-targets>
#figure(
  align(center)[#table(
    columns: (50%, 50%),
    align: (auto,auto,),
    table.header([Metric], [Target],),
    table.hline(),
    [Ingest durability], [Multi-AZ or erasure-coded object; no single
    disk loss of year],
    [Write path], [Async; p99 archive lag #strong[≤ 60s] under normal
    load],
    [Impact on TTFT], [#strong[None] (buffer + drop-oldest on extreme
    backlog with alert --- research may forbid drop; then backpressure
    only non-interactive jobs)],
    [Query], [Partition by `day/model/tenant`\; scan last 7d
    interactive; full-year batch OK],
    [Immutability], [WORM-optional; default append-only prefixes +
    lifecycle],
  )]
  , kind: table
  )

== Node-Local Storage (already on GPU servers)
<node-local-storage-already-on-gpu-servers>
Each GPU server has #strong[8× 3.84 TB NVMe] (\~30 TB raw). Use as:

#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Mount], [Purpose],),
    table.hline(),
    [`/var/lib/kubelet` / containerd], [Images, ephemeral],
    [`/scratch` or hostPath], [Shard download cache, compile cache],
    [Optional KV offload dir], [Framework spill (if enabled)],
  )]
  , kind: table
  )

#strong[Not] primary model catalog. Rebuild-from-shared is the DR story
for local cache.

== Kubernetes Integration
<kubernetes-integration>
#figure(
  align(center)[#table(
    columns: (75%, 25%),
    align: (auto,auto,),
    table.header([Mechanism], [Use],),
    table.hline(),
    [#strong[CSI driver] (NFS, Weka, CephFS, Dell/Pure, etc.)], [RWX for
    model weights + shared datasets],
    [#strong[PVC] `models-rwx`], [Mounted read-mostly on all GPU pods],
    [#strong[initContainer] / Job], [Stage weights → local NVMe if
    faster second start],
    [#strong[KServe StorageUri]], [`pvc://` or `s3://` → runtime load],
    [#strong[Inference logger]], [Sidecar or gateway plugin → bus/object
    (see §6.7)],
    [#strong[Image is not the model]], [Do not bake multi-TB weights
    into images],
  )]
  , kind: table
  )

Example #strong[serving] path:

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

== Inference Capture and 1-Year Archive Pipeline
<inference-capture-and-1-year-archive-pipeline>
Research requirement: #strong[100% of inference traffic retained 1
year.]

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

#figure(
  align(center)[#table(
    columns: (20.83%, 58.33%, 20.83%),
    align: (auto,auto,auto,),
    table.header([Stage], [Tech direction], [Notes],),
    table.hline(),
    [Emit], [OpenTelemetry gen-AI attrs #strong[or] custom JSON
    schema], [Stable `schema_version`],
    [Transport], [Kafka/Redpanda/NATS #strong[or] direct multipart
    S3], [Prefer bus if multi-consumer],
    [Format], [#strong[Parquet] (zstd) primary; JSONL only for
    debug], [Columnar = year-scale scans],
    [Partition], [`day` / `model_version` / `tenant`], [Prune queries],
    [Index], [Lightweight catalog DB (request\_id → object key)], [Point
    lookup without full scan],
    [Retention], [#strong[365 days] default lifecycle rule], [Legal hold
    flag available],
    [Access], [Read via research VPC/IAM; GPU path write-only
    key], [Segregate credentials],
  )]
  , kind: table
  )

#strong[Gateway vs sidecar:] prefer #strong[API gateway or dedicated
logger service] once, so multipod TP/EP shards do not multiply records.
If logging at engine, #strong[dedupe on `request_id`].

#strong[PII / policy:] research cluster still needs classification hooks
(blocklist, user opt-out, secret scrub) before durable write; rejected
payloads stored as tombstone + reason code when policy denies full text.

== Data Layout
<data-layout>
#strong[Models (hot FS):]

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

#strong[Inference archive (object):]

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

Promote models with immutable dirs + atomic `current`. Archive is
append-only by day.

== Platform Options
<platform-options>
Split #strong[hot model FS] from #strong[year-long inference lake] (can
be one product with two pools, or two products).

#figure(
  align(center)[#table(
    columns: (16%, 68%, 16%),
    align: (auto,auto,auto,),
    table.header([Tier], [Preferred options], [Role],),
    table.hline(),
    [#strong[Hot models]], [Weka / BeeGFS / Lustre / FlashBlade-class
    NFS], [Checkpoint load RWX],
    [#strong[Inference archive]], [S3-compatible: Ceph RGW, MinIO, Vast,
    Pure, cloud-adjacent], [1-year lake, parquet],
    [#strong[Bus (optional)]], [Redpanda / Kafka], [Fan-out to archive +
    online eval],
    [#strong[Catalog]], [Postgres / OpenSearch], [request\_id lookup,
    audit],
  )]
  , kind: table
  )

#strong[Default recommendation:]

#figure(
  align(center)[#table(
    columns: (40%, 60%),
    align: (auto,auto,),
    table.header([Need], [Choice],),
    table.hline(),
    [Model load], [Parallel FS or appliance NFS on NVMe (100--250 TB)],
    [1-year inference], [#strong[S3 API object lake ≥ 750 TB usable],
    erasure coding, lifecycle 365d],
    [Research query], [External table / Ray datasets over parquet
    prefixes],
  )]
  , kind: table
  )

== Reference Hardware Footprint
<reference-hardware-footprint>
#figure(
  align(center)[#table(
    columns: (28.12%, 71.88%),
    align: (auto,right,),
    table.header([Component], [Qty / size (indicative)],),
    table.hline(),
    [Hot NVMe model (+ landing)], [3--6 nodes/appliance,
    #strong[150--300 TB] usable],
    [Archive object nodes or appliance], [EC set, #strong[≥ 750 TB]
    usable (path to 2 PB)],
    [400GbE to 7060DX5 leaves], [2--4 ports per storage node/pair],
    [Archive ingest brokers (if used)], [3 VMs/nodes on mgmt or storage
    rack],
    [OOB], [All BMCs → 7010TX-48],
  )]
  , kind: table
  )

Exact BOM: `docs/storage.md` / `docs/bom.md`.

== Failure and Lifecycle
<failure-and-lifecycle>
#figure(
  align(center)[#table(
    columns: (38.46%, 61.54%),
    align: (auto,auto,),
    table.header([Event], [Behavior],),
    table.hline(),
    [Hot FS node loss], [Models still load (repl/EC); slower start],
    [Archive node loss], [No loss of committed objects (EC/repl)],
    [Bus backlog], [Alert; expand consumers; #strong[do not] block token
    stream unless policy=strict],
    [Fabric leaf loss], [ECMP dual-home storage + GPU],
    [Bad model promote], [Immutable versions; roll back
    InferenceService],
    [GPU wipe], [Re-pull models; local cache disposable],
    [Day-366], [Lifecycle delete #strong[or] legal-hold keep],
    [Steady inference vs hot FS outage], [Live QPS OK if weights loaded;
    #strong[new] starts fail],
    [Archive write outage], [Live QPS OK; gap alarms; replay from buffer
    if any],
  )]
  , kind: table
  )

== What Storage Does #emph[Not] Do Here
<what-storage-does-not-do-here>
- Not a substitute for HBM
- Not the MoE expert all-to-all path (GPU RoCE/NVLink)
- Not on 7010TX-48
- Not training-scale continuous multi-TB/s checkpoint writes
- Inference archive is #strong[not] mounted as latency-critical RWX on
  GPU pods

== Summary Integration Map
<summary-integration-map>
#figure(
  align(center)[#table(
    columns: 3,
    align: (auto,auto,auto,),
    table.header([Plane], [Switch / system], [Storage role],),
    table.hline(),
    [Data fabric], [7060DX5], [Models + archive ingest + research
    scans],
    [OOB], [7010TX-48], [BMCs only],
    [Hot FS], [CSI RWX], [Checkpoints],
    [Object lake], [S3 API], [#strong[1-year inference + artifacts]],
    [Bus], [Kafka/Redpanda (opt)], [Reliable async capture],
    [Local NVMe], [GPU server], [Cache / emit buffer],
    [GPU HBM], [B200], [Steady-state weights],
  )]
  , kind: table
  )

#horizontalrule

= Kubernetes Architecture
<kubernetes-architecture>
== Management Nodes
<management-nodes>
#strong[Quantity:] 3 (HA control plane)

#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Component], [Spec],),
    table.hline(),
    [CPU], [32 cores],
    [RAM], [256 GB],
    [Storage], [NVMe],
  )]
  , kind: table
  )

== GPU Workers
<gpu-workers>
```
worker01 … worker08
  each: 8× B200
```

== Software Stack
<software-stack>
```
Kubernetes
  └── NVIDIA GPU Operator
        └── CUDA
              └── TensorRT-LLM / vLLM
                    └── KServe
                          └── Ray (research / batch)
```

#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Layer], [Role],),
    table.hline(),
    [Kubernetes], [Scheduling, HA, multi-tenancy],
    [GPU Operator], [Driver, device plugin, DCGM, MIG (if used)],
    [vLLM / TensorRT-LLM], [High-performance serving],
    [KServe], [Model serving CRDs, canary, autoscaling hooks],
    [Ray], [Research jobs, eval, offline batch],
  )]
  , kind: table
  )

#horizontalrule

= Inference Request Flow
<inference-request-flow>
```
User
  → API Gateway
    → Authentication / Authorization
      → Inference Scheduler
        → Model Server
          → GPU Cluster
            → Response Tokens
```

== Serving Requirements
<serving-requirements>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Attribute], [Target direction],),
    table.hline(),
    [Latency], [Interactive (TTFT + TPOT tuned)],
    [Context], [Up to 32k (initial planning assumption)],
    [Concurrency], [\~50 simultaneous users],
    [Throughput], [\~1,000 tokens/sec aggregate],
  )]
  , kind: table
  )

== Capacity Sketch
<capacity-sketch>
```
50 concurrent users × 20 tokens/sec/user ≈ 1,000 tokens/sec
```

A 64× B200 cluster is in the correct range for this profile on a large
MoE, subject to model/kernel tuning.

#horizontalrule

= Power
<power>
== Per GPU Rack (32 GPUs / 4 servers)
<per-gpu-rack-32-gpus-4-servers>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,right,),
    table.header([Component], [Watts],),
    table.hline(),
    [4 GPU servers], [\~40 kW],
    [Rail leaves share + optics], [\~2--3 kW],
    [OOB / TOR share], [\~0.5 kW],
    [#strong[GPU rack total]], [#strong[\~43--46 kW]],
  )]
  , kind: table
  )

== BOOT Rack
<boot-rack>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,right,),
    table.header([Component], [Watts],),
    table.hline(),
    [K8s + bootstrap + utilities], [\~2--4 kW],
    [Spines (2× DX5-64S)], [\~1--1.5 kW],
    [Bus / monitoring], [\~1--2 kW],
    [#strong[BOOT total]], [#strong[\~4--8 kW]],
  )]
  , kind: table
  )

== STOR Rack
<stor-rack>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,right,),
    table.header([Component], [Watts],),
    table.hline(),
    [Hot FS + archive NVMe (day-1)], [\~5--12 kW],
    [Growth to \~1.5--2 PB], [up to \~15 kW class],
    [#strong[STOR total (day-1)]], [#strong[\~5--15 kW]],
  )]
  , kind: table
  )

== Facility
<facility>
#figure(
  align(center)[#table(
    columns: (50%, 50%),
    align: (auto,auto,),
    table.header([Item], [Spec],),
    table.hline(),
    [Cluster IT load (baseline 4 racks)], [#strong[\~100--115 kW]],
    [Available facility power], [#strong[130--150 kW] recommended
    (headroom + STOR growth)],
    [GPU rows], [High-density 415 VAC, A/B; \~50 kW/rack class],
    [BOOT + STOR], [Standard density OK; A/B feeds],
    [Feeds], [A/B redundant all racks],
  )]
  , kind: table
  )

#horizontalrule

= Cooling
<cooling>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([Tier], [Approach],),
    table.hline(),
    [Minimum], [Hot-aisle containment + high-airflow CRAC],
    [Preferred], [Rear-door heat exchangers],
    [Future], [Direct liquid cooling (DLC)],
  )]
  , kind: table
  )

Plan rack and facility layout so DLC retrofit is possible.

#horizontalrule

= Monitoring and Observability
<monitoring-and-observability>
== GPU
<gpu>
- NVIDIA DCGM
- GPU utilization
- HBM usage
- ECC errors
- NVLink health
- Power / thermal

== Network
<network>
- Interface errors
- ECN marks
- Packet drops
- RoCE congestion counters
- Fabric latency / loss

== Application
<application>
- Tokens/sec
- Time-to-first-token (TTFT)
- Time-per-output-token (TPOT)
- Queue depth
- GPU occupancy / KV-cache utilization
- Error rate / timeouts

#horizontalrule

= High Availability
<high-availability>
#figure(
  align(center)[#table(
    columns: (42.86%, 57.14%),
    align: (auto,auto,),
    table.header([Domain], [Approach],),
    table.hline(),
    [Control plane], [3-node Kubernetes HA],
    [Fabric], [8×400G/node rail leaves (7060DX5-32 ×8), dual spine
    (7060DX5-64) ECMP + DLB],
    [Power], [A/B feeds],
    [Model serving], [Multi-replica where parallelism allows; rolling
    updates via KServe],
    [Storage], [Redundant NVMe pool / erasure or replication per
    product],
  )]
  , kind: table
  )

Failure domains should align with racks and leaf pairs so a single leaf
or rack loss does not take the full model offline if EP groups are
placed carefully.

#horizontalrule

= Expandability
<expandability>
#figure(
  align(center)[#table(
    columns: (44.44%, 55.56%),
    align: (auto,auto,),
    table.header([Path], [Notes],),
    table.hline(),
    [+1 GPU rack (32 GPUs)], [Add rail leaf capacity as needed, extend
    EVPN, join workers],
    [+server within GPU rack], [Power/cooling/RU headroom first],
    [Storage growth in STOR], [Add NVMe nodes/shelves until RU/power
    full],
    [#strong[\+STOR-2]], [When usable archive \>\~1.5--2 PB or
    rack-level failure split],
    [Multi-model], [Partition expert groups / namespaces by team],
  )]
  , kind: table
  )

Initial design: #strong[4 racks] with clear expansion to 5--6 (GPU-3,
STOR-2) without redesigning fabric roles.

#horizontalrule

= Approximate Cost
<approximate-cost>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,right,),
    table.header([Category], [Estimate],),
    table.hline(),
    [64× B200 GPUs], [\$4--6M],
    [GPU servers], [\$1--1.5M],
    [Network fabric], [\$1--1.5M],
    [Storage], [\$500k],
    [Rack / power / cooling], [\$500k],
    [#strong[Total]], [#strong[\$7--10M]],
  )]
  , kind: table
  )

Costs are order-of-magnitude planning numbers only; obtain vendor quotes
for procurement.

#horizontalrule

= Final Design Recommendation
<final-design-recommendation>
For a research organization running interactive multi-trillion MoE
inference:

#figure(
  align(center)[#table(
    columns: (45.45%, 54.55%),
    align: (auto,auto,),
    table.header([Layer], [Choice],),
    table.hline(),
    [Compute], [64× B200 / 8× Dell PowerEdge XE9680 / #strong[2 GPU
    racks]],
    [Facility], [#strong[4 racks:] GPU-1, GPU-2, #strong[BOOT],
    #strong[STOR]],
    [Network], [#strong[8×400G/node] rail fabric: 8× DX5-32 + 2×
    DX5-64S; #strong[7010TX-48] OOB],
    [Storage], [100TB+ NVMe model repository],
    [Platform], [Kubernetes + GPU Operator + vLLM/TensorRT-LLM + KServe
    \+ Ray],
    [Ops], [DCGM + EOS/LANZ fabric telemetry + token-level SLOs],
  )]
  , kind: table
  )

This is the scale at which the system behaves like a real AI
supercomputer while remaining operable by an enterprise infrastructure
team.

#horizontalrule

= Document Roadmap
<document-roadmap>
Follow-on specs (to be written next):

+ `docs/bom.md` --- bill of materials and SKUs \
+ #strike[`docs/network.md`] --- #strong[done] (ZTP day-0, numbered eBGP
  underlay, RoCEv2 lossless profile) \
+ #strike[`docs/bootstrap.md`] --- #strong[done] (BOOT seed,
  Metal3/CAPI, Flux platform) + `bootstrap/` \
+ #strike[`docs/netbox.md` / `docs/cabling.md`] --- #strong[done]
  (NetBox DCIM/IPAM SoT + cabling export) \
+ `docs/k8s.md` --- day-2 cluster ops, tenancy, upgrades \
+ `docs/storage.md` --- model repo layout and performance targets \
+ `docs/facility.md` --- rack elevations, power, cooling \
+ `docs/slo.md` --- latency/throughput SLOs and capacity model \
+ #strike[`docs/build-guide.md`] --- #strong[done] (physical build:
  rack, power, cable, bring-up, burn-in) \
+ #strike[`docs/overlay.md`] --- #strong[done] (EVPN/VXLAN overlay: vrf
  `storage` + vrf `edge`, border, API ingress) \
+ #strike[`docs/serving.md`] --- #strong[done] (Kimi K2 Thinking deploy,
  inference scheduler, API gateway/auth, capture wiring)

#horizontalrule

= Revision History
<revision-history>
#figure(
  align(center)[#table(
    columns: (43.75%, 25%, 31.25%),
    align: (auto,auto,auto,),
    table.header([Version], [Date], [Notes],),
    table.hline(),
    [0.1], [2026-07-18], [Initial specification],
    [0.2], [2026-07-18], [Network standardized on Arista 7060DX5 (DX5-32
    leaf, DX5-64S spine)],
    [0.3], [2026-07-18], [Clarified lossless ≠ equal leaf/spine; added
    square Clos Option B],
    [0.4], [2026-07-18], [OOB standardized on Arista 7010TX-48 (2×, 1
    per rack)],
    [0.5], [2026-07-18], [Storage integration: fabric, CSI/KServe,
    tiers, targets],
    [0.6], [2026-07-18], [1-year inference archive lake (≥750 TB usable,
    async capture)],
    [0.7], [2026-07-18], [Host NIC 8×400G (1:1 GPU); rail-optimized 8
    leaf + 2 spine],
    [0.8], [2026-07-18], [Facility: 4 racks (2× GPU + BOOT + STOR);
    STOR-2 optional],
    [0.9], [2026-07-18], [Bootstrap stack: seed + Metal3/CAPI + Flux
    platform (`bootstrap/`, `docs/bootstrap.md`)],
    [1.0], [2026-07-18], [NetBox SoT: inventory, IPAM, cabling guide
    (`bootstrap/netbox/`, `docs/netbox.md`, `docs/cabling.md`)],
    [1.1], [2026-07-19], [GPU servers standardized on Dell PowerEdge
    XE9680 (8×, 6U)],
    [1.2], [2026-07-19], [Network: ZTP day-0 (OOB bench ZTP → relay
    ZTP), eBGP underlay, RoCEv2 lossless profile (`docs/network.md`);
    OOB = MLAG pair; +mgmt0/Ma1/peer cabling (169 cables)],
    [1.3], [2026-07-19], [EVPN/VXLAN overlay (vrf storage/edge, border
    --- `docs/overlay.md`); Kimi K2 Thinking deployment + inference
    scheduler + API access (`docs/serving.md`,
    `bootstrap/platform/apps/{models,api}`)],
  )]
  , kind: table
  )

