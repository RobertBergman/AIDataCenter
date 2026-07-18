// 64× NVIDIA B200 AI Inference Cluster — Review Specification
// Compile: typst compile docs/spec.typ docs/spec.pdf

#set document(
  title: "64× NVIDIA B200 AI Inference Cluster Specification",
  author: "Infrastructure / AI Platform",
  date: datetime(year: 2026, month: 7, day: 18),
)

#set page(
  paper: "us-letter",
  margin: (x: 0.85in, y: 0.8in),
  header: context {
    if counter(page).get().first() > 1 {
      set text(size: 8.5pt, fill: luma(90))
      grid(
        columns: (1fr, auto),
        [64× B200 Inference Cluster — Draft Spec],
        [Confidential — Internal Review],
      )
      v(-0.3em)
      line(length: 100%, stroke: 0.4pt + luma(180))
    }
  },
  footer: context {
    set text(size: 8.5pt, fill: luma(90))
    line(length: 100%, stroke: 0.4pt + luma(180))
    v(-0.3em)
    grid(
      columns: (1fr, auto, 1fr),
      [Rev 0.6 · 2026-07-18],
      align(center)[Page #counter(page).display("1 of 1", both: true)],
      align(right)[Typst],
    )
  },
)

#set text(font: ("New Computer Modern", "Liberation Serif", "DejaVu Serif"), size: 10pt)
#set par(justify: true, leading: 0.65em)
#set heading(numbering: "1.1")
#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  v(0.4em)
  block(below: 0.8em)[
    #set text(size: 14pt, weight: "bold")
    #counter(heading).display() #h(0.4em) #it.body
  ]
  line(length: 100%, stroke: 0.8pt + rgb("#1a365d"))
  v(0.4em)
}
#show heading.where(level: 2): it => {
  v(0.6em)
  block(below: 0.5em)[
    #set text(size: 11.5pt, weight: "bold", fill: rgb("#1a365d"))
    #counter(heading).display() #h(0.35em) #it.body
  ]
}
#show heading.where(level: 3): it => {
  v(0.4em)
  block(below: 0.4em)[
    #set text(size: 10.5pt, weight: "bold")
    #counter(heading).display() #h(0.3em) #it.body
  ]
}

#set table(
  stroke: 0.4pt + luma(160),
  inset: 6pt,
  align: left,
)
#show table.cell.where(y: 0): set text(weight: "bold", size: 9pt)
#show table: set text(size: 9pt)
#show raw.where(block: true): it => block(
  width: 100%,
  fill: luma(245),
  inset: 10pt,
  radius: 3pt,
  stroke: 0.4pt + luma(200),
  text(font: ("DejaVu Sans Mono", "Liberation Mono", "Courier New"), size: 7.8pt, it),
)
#show link: set text(fill: rgb("#1a365d"))

#let callout(title, body) = block(
  width: 100%,
  fill: rgb("#edf2f7"),
  stroke: 0.6pt + rgb("#1a365d"),
  inset: 10pt,
  radius: 3pt,
  {
    text(weight: "bold", fill: rgb("#1a365d"), title)
    v(0.3em)
    body
  },
)

// ── Cover ──────────────────────────────────────────────────────────

#align(center)[
  #v(1.5in)
  #text(size: 12pt, fill: luma(80), tracking: 1.5pt)[INFRASTRUCTURE SPECIFICATION]
  #v(0.6em)
  #line(length: 40%, stroke: 1.2pt + rgb("#1a365d"))
  #v(0.8em)
  #text(size: 22pt, weight: "bold")[64× NVIDIA B200\
  AI Inference Cluster]
  #v(0.5em)
  #text(size: 12pt)[Production Research Platform Specification]
  #v(0.4em)
  #line(length: 40%, stroke: 0.6pt + luma(160))
  #v(1.0em)

  #block(width: 85%)[
    #set align(left)
    #table(
      columns: (1.4in, 1fr),
      stroke: none,
      inset: (x: 4pt, y: 5pt),
      [*Status*], [Draft — for architecture review],
      [*Purpose*], [Interactive multi-trillion MoE inference],
      [*Scale*], [~1,000 registered users · ~50 concurrent],
      [*Retention*], [All inference retained *1 year*],
      [*Fabric*], [Arista 7060DX5 (data) · 7010TX-48 (OOB)],
      [*Orchestration*], [Kubernetes + NVIDIA GPU Operator],
      [*Revision*], [0.6 · 2026-07-18],
    )
  ]

  #v(1.2in)
  #text(size: 9.5pt, fill: luma(90))[
    Not a hyperscale training cluster.\
    Manageable enterprise research inference platform.
  ]
]

#pagebreak()

// ── TOC ────────────────────────────────────────────────────────────

#outline(title: [Contents], indent: 1.2em, depth: 2)

// ═══════════════════════════════════════════════════════════════════
= Design Goals

#table(
  columns: (0.7in, 1fr),
  table.header([Priority], [Goal]),
  [1], [Interactive inference latency],
  [2], [Large model support (multi-trillion MoE)],
  [3], [Research workload flexibility],
  [4], [High availability],
  [5], [Expandability],
)

This is *not* a maximum-throughput hyperscale training cluster. It is a manageable enterprise research inference platform.

// ═══════════════════════════════════════════════════════════════════
= Physical Summary

#table(
  columns: (1.6in, 1fr),
  table.header([Item], [Specification]),
  [GPUs], [*64× NVIDIA B200*],
  [GPU servers], [8],
  [GPUs per server], [8],
  [Racks], [*4* (2×GPU + BOOT + STOR)],
  [Rack density], [32 GPUs/rack],
  [Fabric], [400GbE RoCEv2 rail-opt (Arista 7060DX5)],
  [Host NICs], [*8×400GbE per server* (1:1 GPU)],
  [OOB], [Arista 7010TX-48],
  [Orchestration], [Kubernetes + NVIDIA GPU Operator],
  [Primary workload], [MoE LLM inference],
  [Inference archive], [1-year object lake (≥750 TB usable)],
)

// ═══════════════════════════════════════════════════════════════════
= Facility / Rack Zones

#table(
  columns: (0.9in, 2.4in, 1.2in),
  table.header([Rack], [Role], [Day-1]),
  [*GPU-1*], [4× B200 (32 GPU) + rail leaves + OOB], [Required],
  [*GPU-2*], [4× B200 (32 GPU) + rail leaves + OOB], [Required],
  [*BOOT*], [K8s CP, PXE/registry, spines, NMS, brokers], [*Required*],
  [*STOR*], [Hot model FS + 1-year object lake], [*Required* (one)],
  [STOR-2], [Archive growth / isolation], [Optional],
)

*BOOT:* separate blast radius from GPU kW; holds DC bootstrap.\
*STOR:* one rack is enough for 150–300 TB hot + ≥750 TB archive; add STOR-2 only past ~1.5–2 PB usable or for rack-level Failure domains.

= Compute Nodes

== GPU Server Quantity

*8 servers.* Example platforms: NVIDIA MGX B200, Dell XE9680-class, HPE Cray XD, Supermicro HGX/B200, Lenovo ThinkSystem AI.

== Per-Server Specification

#table(
  columns: (1.4in, 1fr),
  table.header([Component], [Specification]),
  [GPU], [8× NVIDIA B200],
  [GPU memory], [~1.4 TB HBM3e],
  [GPU compute], [~1.4 PFLOPS FP8 (approx.)],
  [CPU], [2× AMD EPYC Turin / Genoa],
  [CPU cores], [128–192],
  [System RAM], [2 TB DDR5 ECC],
  [Boot], [2× 1.92 TB NVMe RAID1],
  [Local NVMe], [8× 3.84 TB],
  [Data network], [*8× 400GbE* (1 NIC per GPU; rail-optimized)],
  [NIC class], [ConnectX-7 / BlueField-3 SuperNIC class],
  [Management], [1× 1/10/25GbE],
  [Power], [8–10 kW],
)

== Cluster Aggregate Capacity

#table(
  columns: (1.6in, 1fr),
  table.header([Resource], [Amount]),
  [GPUs], [64],
  [HBM3e memory], [~11.5 TB],
  [CPU cores], [~1,200],
  [System RAM], [16 TB],
  [Local NVMe], [~250 TB],
  [GPU FP8 compute], [~11–12 PFLOPS],
)

// ═══════════════════════════════════════════════════════════════════
= GPU Parallelism Model

For a ~3T MoE model, do *not* run one giant tensor-parallel job across all GPUs by default.

== Logical Layout

```
                    Model Router
                          |
           +--------------+--------------+
           |              |              |
    Expert Group 1  Expert Group 2  Expert Group 3  Expert Group 4
       GPU 0–15        GPU 16–31       GPU 32–47       GPU 48–63
```

== Parallelism Dimensions

#table(
  columns: (0.8in, 1fr),
  table.header([Dim], [Role]),
  [TP], [Tensor parallel (within node / NVLink domain)],
  [EP], [Expert parallel (across nodes over fabric)],
  [PP], [Pipeline parallel (optional depth split)],
)

== Example Configurations

```
TP=8, EP=8, PP=1
TP=4, EP=16, PP=1
```

Exact values depend on model architecture, expert count, and latency targets.

// ═══════════════════════════════════════════════════════════════════
= Network Architecture

#callout[Host NIC baseline][
  Each B200 has a *dedicated 400GbE* NIC (not 2 shared NICs per server).\
  Per server *3.2 Tbps*; cluster host edge *25.6 Tbps* (64×400G). Rail-optimized: 8 rail leaves.
]

For MoE inference, the fabric is part of the computer.

*Standard platforms:* Arista *7060DX5* (data plane, EOS, optional CloudVision); Arista *7010TX-48* (OOB).

== Fabric Requirements

#table(
  columns: (1.5in, 1fr),
  table.header([Feature], [Requirement]),
  [Platform], [Arista 7060DX5],
  [NOS], [Arista EOS],
  [Link speed], [400GbE (QSFP-DD)],
  [Transport], [RoCEv2],
  [Congestion], [ECN, PFC, DCQCN / advanced congestion mgmt],
  [Load balancing], [ECMP + Dynamic Load Balancing (DLB)],
  [Overlay / control], [BGP EVPN (VXLAN as needed)],
  [Automation], [eAPI / CloudVision],
  [Tuning], [AI / lossless Ethernet profile],
)

== Topology Rules

#callout[Important][
  *RoCEv2 lossless Ethernet does not require equal leaf and spine counts.*
]

What keeps the fabric well-behaved for MoE/EP traffic:

#table(
  columns: (1.8in, 1fr),
  table.header([Requirement], [Why it matters]),
  [Low/zero oversub leaf→spine], [Avoid standing congestion that PFC turns into fabric-wide pause],
  [PFC + ECN + DCQCN], [Lossless queue without pause storms],
  [Enough ECMP / DLB paths], [Spread elephant flows; reduce incast hotspots],
  [End-to-end jumbo MTU], [Fewer packets, lower PPS stress],
  [Buffer + queue telemetry], [Catch microbursts before drops/pauses],
)

Equal leaf/spine counts appear in some designs as a *square Clos with one SKU* — a convenience choice, not a lossless protocol rule.

Spine count math:

```
spine_ports_needed ≈ (leaf_count × uplinks_per_leaf)
                     / ports_per_spine_toward_leaves

For 1:1 fabric:
  Σ leaf uplink BW  ≥  Σ leaf downlink (host) BW
```

== Topology Options

=== Option A — Efficient (default): 4 leaf + 2 spine

```
                 Spine1          Spine2
               7060DX5-64S     7060DX5-64S
                    |  \        /  |
                    |   \      /   |
                 Leaf1  Leaf2  Leaf3  Leaf4
                DX5-32 DX5-32 DX5-32 DX5-32
                    |     |      |     |
                 Rack1 workers  Rack2 workers
```

#table(
  columns: (0.9in, 2.2in, 0.6in),
  table.header([Role], [Model], [Qty]),
  [Rail leaf], [DCS-7060DX5-32], [8],
  [Spine], [DCS-7060DX5-64S (or 64E)], [2],
)

Host edge: 8 servers × 8×400G = *25.6 Tbps*. Rail model: one leaf per GPU index; GPU-_i_ on every node → Rail-_i_ leaf.
*Per rail leaf 1:1:* 8×400G hosts → ≥8×400G toward spines.

=== Option B — Square Clos, one SKU: 4 leaf + 4 spine

```
            Spine1  Spine2  Spine3  Spine4
              \   \   |   |   /   /
               Leaf1 Leaf2 Leaf3 Leaf4
                  (all 7060DX5-32)
```

#table(
  columns: (0.9in, 2.0in, 0.6in),
  table.header([Role], [Model], [Qty]),
  [Leaf], [DCS-7060DX5-32], [4],
  [Spine], [DCS-7060DX5-32], [4],
)

Use for identical BOM, full bipartite wiring, simpler sparing. *Not required for lossless.*

=== Chosen baseline

*Default: 8× DX5-32 rail leaf + 2× DX5-64S spine* (1 NIC per GPU, rail-optimized).

#table(
  columns: (1.0in, 1.4in, 1.4in),
  table.header([Rack], [Leaves], [GPU servers]),
  [Rack 1], [Leaf1, Leaf2], [worker01–04],
  [Rack 2], [Leaf3, Leaf4], [worker05–08],
)

== Leaf Switches — Arista 7060DX5-32

*Quantity:* *8* rail leaves · *SKU:* DCS-7060DX5-32

#table(
  columns: (1.4in, 1fr),
  table.header([Feature], [Value]),
  [Ports], [32× 400G QSFP-DD],
  [Breakout], [up to 128× 100G],
  [L2/L3 throughput], [12.8 Tbps],
  [Forwarding], [~5.3 Bpps],
  [Packet buffer], [57 MB shared],
  [Latency], [from ~850 ns],
  [Typical power], [~289 W],
  [Airflow], [F-R or R-F (match rack)],
  [HA hardware], [1+1 PSU, N+1 fans],
  [Routing], [BGP EVPN, 128-way ECMP],
  [AI features], [DLB, advanced congestion, LANZ],
  [QoS], [PFC / ECN for RoCEv2],
)

== Spine Switches

=== Option A spines — 7060DX5-64 (qty 2)

#table(
  columns: (0.7in, 1.5in, 1.4in, 0.9in, 0.6in),
  table.header([Opt], [Model], [Ports], [Tput], [RU]),
  [*A1*], [*DCS-7060DX5-64S*], [64× 400G QSFP-DD], [25.6 Tbps], [2],
  [A2], [DCS-7060DX5-64E], [32×800G → 64×400G], [25.6 Tbps], [1],
)

#table(
  columns: (1.4in, 1fr),
  table.header([Feature], [Value]),
  [ECMP], [up to 128-way],
  [Latency], [from ~850 ns],
  [Typical power], [~489 W (64S) / ~548 W (64E)],
  [Airflow], [Front-to-rear],
  [HA hardware], [1+1 PSU, N+1 fans],
)

=== Option B spines — 7060DX5-32 (qty 4)

Same SKU as leaves. Full bipartite; still size *uplink BW ≥ downlink BW* per leaf.

*Default procurement:* *8× DX5-32 rail leaf + 2× DX5-64S spine*.

== Server Connectivity

```
        HGX B200 Server
        GPU0..GPU7 ── NIC0..NIC7 ── 400G ── Rail0..Rail7 leaves
```

#table(
  columns: (2.2in, 1fr),
  table.header([Scope], [Bandwidth]),
  [Per server], [3.2 Tbps (8×400G)],
  [Per GPU / NIC], [400 Gbps],
  [Cluster aggregate server edge], [25.6 Tbps (64 × 400 Gbps)],
)

== Port Plan (Planner Baseline)

*Per leaf (7060DX5-32)* — rack of 4 GPU nodes, dual-homed:

#table(
  columns: (2.0in, 0.8in, 0.8in),
  table.header([Use], [Ports], [Speed]),
  [GPU server downlinks], [4], [400G],
  [Spine uplinks (2 per spine)], [4–8], [400G],
  [Storage / services], [2–4], [400G],
  [Spare / growth], [remainder], [400G],
)

Target oversubscription leaf→spine: *≤ 1:1* host-facing (prefer 2:1 uplink:downlink capacity where ports allow).

*Per spine (7060DX5-64S):*

#table(
  columns: (2.2in, 1.0in, 0.8in),
  table.header([Use], [Ports], [Speed]),
  [Leaf uplinks (4 leaves × 2–4)], [8–16], [400G],
  [Storage cluster], [2–4], [400G],
  [Border / DCI / services], [2–4], [400G],
  [Spare / expansion rack], [remainder], [400G],
)

== Optics and Cabling

#table(
  columns: (2.0in, 1fr),
  table.header([Link], [Preferred media]),
  [Server ↔ leaf (same rack)], [400G-DR4 / DAC or AOC as length allows],
  [Leaf ↔ spine], [400G-DR4 or FR4 per plant standards],
  [Connector], [QSFP-DD on 7060DX5-32 / 64S],
  [Spares], [20% optics/cables minimum],
)

== RoCEv2 / AI Ethernet Profile (Arista EOS)

#table(
  columns: (1.5in, 1fr),
  table.header([Control], [Setting direction]),
  [Priority flow control], [Lossless queue for RoCE PFC priority],
  [ECN], [Enabled on RoCE queue; mark before drop],
  [DCQCN], [Host CNP reaction; switch ECN thresholds tuned],
  [DLB], [Prefer DLB over static hash for large flows],
  [MTU], [Jumbo (e.g. 9000) end-to-end],
  [ECMP], [Max-path ≥ leaf uplink count; resilient hashing],
  [Telemetry], [LANZ / queue depth; drop & ECN counters scraped],
)

== Out-of-Band / Management Network

Separate from the 400G RoCE fabric. *Never* carry GPU data-plane traffic.

*Standard platform:* Arista *7010TX-48* (7010X series), EOS.

=== Platform

#table(
  columns: (1.3in, 1fr),
  table.header([Item], [Spec]),
  [Model], [*DCS-7010TX-48* (AC) or *DCS-7010TX-48-DC*],
  [Form factor], [1RU],
  [Access ports], [48× 10/100/1000BASE-T (RJ45)],
  [Uplinks], [4× SFP28 (1/10/25GbE)],
  [Throughput], [296 Gbps / ~220 Mpps],
  [Buffer], [4 MB shared],
  [Power], [1+1 redundant PSU],
  [Fans], [1+1 hot-swap; reversible airflow],
  [NOS], [Arista EOS],
)

=== Quantity and placement

#table(
  columns: (1.2in, 0.5in, 1fr),
  table.header([Role], [Qty], [Placement]),
  [OOB leaf], [*2*], [1 per GPU rack (baseline)],
  [Optional 3rd], [1], [Management rack if port pressure],
)

```
                    Mgmt core / border
                     /              \
              OOB-SW1              OOB-SW2
            7010TX-48              7010TX-48
             Rack 1                 Rack 2
                |                      |
     BMC, mgmt NIC, PDUs, 7060DX5 mgmt, jump hosts
```

=== Attachments

#table(
  columns: (2.2in, 0.6in, 1fr),
  table.header([Endpoint], [Speed], [Notes]),
  [GPU server BMC], [1G], [Always-on lights-out],
  [GPU OS mgmt NIC (opt)], [1G], [Rescue / PXE],
  [K8s control-plane mgmt], [1G], [Not RoCE NICs],
  [7060DX5 Management1], [1G], [EOS OOB mgmt],
  [Storage / PDU / console], [1G], [As present],
  [CloudVision / jump / IPMI], [1G], [Ops plane],
)

OOB is *loss-tolerant best-effort* (no RoCE PFC).

#table(
  columns: (1.2in, 1fr),
  table.header([Control], [Requirement]),
  [Isolation], [Dedicated VRF/VLAN; no route to RoCE data except controlled jump],
  [Access], [MFA jump host; no public BMC],
  [ACLs], [Mgmt subnets only → BMC/IPMI/SSH/HTTPS],
  [Logging], [EOS AAA + syslog/telemetry],
)

// ═══════════════════════════════════════════════════════════════════
= Storage

Inference is *not* a training I/O path. Storage must load multi-TB MoE checkpoints, hold versions, archive all inference for research, and stay off the critical token path.

== Role of Storage

#table(
  columns: (1.5in, 1.3in, 1.2in, 1.2in),
  table.header([Path], [When], [BW need], [Latency]),
  [*Model cold start*], [Deploy/restart], [High burst], [Startup only],
  [*Steady inference*], [Weights in HBM], [~0 for weights], [GPU HBM],
  [*Inference archive*], [Every request], [Sustained write], [Must not block TTFT],
  [KV spill (opt)], [Long context], [Med, local-first], [Moderate],
  [Datasets / eval], [Ray jobs], [Med sequential], [Low–med],
  [Ops metrics], [Always], [Low], [Low],
)

#callout[Design principles][
  + Weights on hot shared NVMe; steady-state path is GPU HBM. \
  + *All inference* (prompts, completions, metadata) retained *≥ 1 year*. \
  + Archive write is *async* — never on the critical token path.
]

== Logical Architecture

```
              Cold / research object lake (S3)
              1-year inference archive · 0.5–2+ PB class
                          ▲
                          │ compact / lifecycle
              Hot tier (NVMe)
              · Model repo 100–250 TB
              · Inference landing 7–30 days
                          │ 400GbE
          ┌───────────────┼───────────────┐
     GPU workers     Archive path    Research query
     serve + emit    (async bus)     Spark/Ray/SQL
          │               │
     vLLM/TRT-LLM    Kafka/Redpanda
     → HBM           or direct S3 PUT
```

== Network Integration

Storage attaches to the *same Arista 7060DX5 data fabric* (not 7010TX-48 OOB).

#table(
  columns: (1.4in, 1fr),
  table.header([Item], [Spec]),
  [Fabric], [7060DX5 leaf-spine],
  [Host path], [GPU NICs (data plane), not BMC/OOB],
  [Isolation], [Storage VRF/VLAN; QoS separate from RoCE EP if needed],
  [Transport], [NFS/RDMA, parallel FS client, or S3 — product-dependent],
)

*BMC / storage controllers* → 7010TX-48 OOB only.

== Capacity and Performance Targets

=== Hot tier (models + short landing)

#table(
  columns: (2.0in, 1fr),
  table.header([Metric], [Target]),
  [Usable NVMe], [*100–250 TB* models + *20–50 TB* landing],
  [Single MoE checkpoint], [*5–40 TB* compressed/sharded per version],
  [Concurrent versions], [3–5 online],
  [Aggregate model read], [*≥ 40 GB/s* (stretch 80+)],
  [Single-node model read], [*≥ 10–20 GB/s*],
)

=== Inference archive tier (1-year) — required

*Policy:* retain *every* inference exchange for *365 days*. Deletes only via explicit policy after retention.

*Minimum fields per request:*

#table(
  columns: (2.6in, 1fr),
  table.header([Field], [Required]),
  [`request_id`, `trace_id`, timestamp (UTC)], [Yes],
  [Tenant / user id (pseudonymized if needed)], [Yes],
  [Model id + version + serving revision], [Yes],
  [Full prompt / messages (as served)], [Yes],
  [Full completion tokens (as returned)], [Yes],
  [Sampling params (temp, top_p, max_tokens, seed)], [Yes],
  [Token counts, TTFT, TPOT, status, error], [Yes],
  [Router / expert stats], [Research-preferred],
  [Logprobs / top-k], [Opt-in (large)],
  [Tool calls / RAG citations], [When used],
  [Content hash + schema version], [Yes],
)

=== Capacity planning model

Assumptions: ~50 concurrent, ~32k context class, research use.

#table(
  columns: (1.3in, 1.8in, 1.2in, 1.1in),
  table.header([Scenario], [What is stored], [Sustained], [1-year retained]),
  [*Lean*], [Text + metadata; delta turns; parquet/zstd], [0.5–2 TB/d raw], [*~50–150 TB*],
  [*Standard* (default)], [Full prompt+completion each call], [2–8 TB/d raw], [*~200–600 TB*],
  [*Full fidelity*], [+ logprobs / 32k-heavy], [10–40 TB/d raw], [*~1–3 PB*],
)

#callout[Procurement baseline][
  Size object/archive lake for *≥ 750 TB usable* (standard research + headroom), growth path to *1.5–2 PB*. Revisit after 30–90 days of measured bytes/request. \
  \
  Peak ~1k tok/s is *not* the size driver — *full prompt context logged per turn* is.
]

=== Archive performance

#table(
  columns: (1.4in, 1fr),
  table.header([Metric], [Target]),
  [Durability], [Erasure-coded / multi-copy object; no single-disk year loss],
  [Write path], [Async; p99 archive lag *≤ 60s* normal],
  [Impact on TTFT], [*None*],
  [Query], [Partition `day/model/tenant`; 7d interactive; year batch OK],
  [Immutability], [Append-only prefixes + lifecycle; WORM optional],
)

== Node-Local Storage

Each GPU server: *8× 3.84 TB NVMe* (~30 TB raw) for kubelet/containerd, scratch cache, optional KV spill. *Not* primary model catalog.

== Kubernetes Integration

#table(
  columns: (1.5in, 1fr),
  table.header([Mechanism], [Use]),
  [CSI driver], [RWX for weights + datasets],
  [PVC `models-rwx`], [Read-mostly on GPU pods],
  [initContainer / Job], [Stage weights → local NVMe],
  [KServe StorageUri], [`pvc://` or `s3://`],
  [Inference logger], [Gateway plugin → bus/object],
  [Images], [Do *not* bake multi-TB weights into images],
)

```
KServe InferenceService
  storageUri: pvc://models-rwx/moe-3t/v…/
       │
       ▼
GPU pod CSI mount → load to HBM
       ├── tokens to client
       └── async InferenceRecord → archive pipeline
```

== Inference Capture and 1-Year Archive Pipeline

*Requirement: 100% of inference traffic retained 1 year.*

```
 Client → API Gateway (redaction/ToS)
            → Model Server (vLLM / TRT-LLM / KServe)
                 ├── response (sync)
                 └── InferenceRecord (async)
                        → buffer (NVMe ring / NATS / Redpanda / Kafka)
                        → compactor workers
                        → s3://inference-archive/year=…/month=…/day=…/
                        → Ray / Spark / DuckDB / warehouse
```

#table(
  columns: (1.1in, 2.0in, 1.5in),
  table.header([Stage], [Tech direction], [Notes]),
  [Emit], [OTel gen-AI or JSON schema], [Stable `schema_version`],
  [Transport], [Kafka/Redpanda/NATS or S3], [Bus if multi-consumer],
  [Format], [*Parquet* (zstd) primary], [Year-scale scans],
  [Partition], [`day` / `model` / `tenant`], [Prune queries],
  [Index], [Catalog DB request_id→key], [Point lookup],
  [Retention], [*365 days* lifecycle], [Legal hold available],
  [Access], [Research read IAM; write-only serve key], [Segregate creds],
)

Prefer *API gateway or dedicated logger* once (avoid TP/EP duplicate records). Dedupe on `request_id` if engine-side. PII hooks before durable write; policy denials → tombstone + reason.

== Data Layout

*Models (hot FS):*

```
/models/moe-3t/v…/{config,shards,CHECKSUMS}
/embeddings/  /adapters/  /datasets/  /eval/  /artifacts/
```

*Inference archive (object):*

```
s3://inference-archive/
  year=2026/month=07/day=18/model=moe-3t/ver=…/part-*.parquet
  _catalog/   _schema/v1.json
```

== Platform Options

#table(
  columns: (1.4in, 2.2in, 1.5in),
  table.header([Tier], [Preferred options], [Role]),
  [Hot models], [Weka / BeeGFS / Lustre / FlashBlade NFS], [Checkpoint RWX],
  [Inference archive], [Ceph RGW, MinIO, Vast, Pure, …], [1-year lake],
  [Bus (opt)], [Redpanda / Kafka], [Fan-out],
  [Catalog], [Postgres / OpenSearch], [request_id lookup],
)

#table(
  columns: (1.5in, 1fr),
  table.header([Need], [Choice]),
  [Model load], [Parallel FS or appliance NFS on NVMe (100–250 TB)],
  [1-year inference], [*S3 API object lake ≥ 750 TB*, EC, lifecycle 365d],
  [Research query], [Ray / external tables over parquet],
)

== Hardware Footprint (indicative)

#table(
  columns: (2.4in, 1fr),
  table.header([Component], [Qty / size]),
  [Hot NVMe model (+ landing)], [3–6 nodes/appliance, *150–300 TB* usable],
  [Archive object (EC)], [*≥ 750 TB* usable (path to 2 PB)],
  [400GbE to leaves], [2–4 ports per storage node/pair],
  [Ingest brokers (if used)], [3 VMs/nodes],
  [OOB], [All BMCs → 7010TX-48],
)

== Failure and Lifecycle

#table(
  columns: (1.6in, 1fr),
  table.header([Event], [Behavior]),
  [Hot FS node loss], [Models still load; slower start],
  [Archive node loss], [No loss of committed objects],
  [Bus backlog], [Alert; do *not* block tokens unless policy=strict],
  [Fabric leaf loss], [ECMP dual-home],
  [Day-366], [Lifecycle delete or legal-hold],
  [Hot FS outage (steady)], [Live QPS OK if weights loaded; new starts fail],
  [Archive outage], [Live QPS OK; gap alarms; buffer replay],
)

== Summary Integration Map

#table(
  columns: (1.2in, 1.4in, 1fr),
  table.header([Plane], [System], [Storage role]),
  [Data fabric], [7060DX5], [Models + archive + research scans],
  [OOB], [7010TX-48], [BMCs only],
  [Hot FS], [CSI RWX], [Checkpoints],
  [Object lake], [S3 API], [*1-year inference + artifacts*],
  [Bus], [Kafka/Redpanda], [Async capture],
  [Local NVMe], [GPU server], [Cache / emit buffer],
  [GPU HBM], [B200], [Steady-state weights],
)

// ═══════════════════════════════════════════════════════════════════
= Kubernetes Architecture

== Management Nodes

*Quantity:* 3 (HA control plane)

#table(
  columns: (1.2in, 1fr),
  table.header([Component], [Spec]),
  [CPU], [32 cores],
  [RAM], [256 GB],
  [Storage], [NVMe],
)

== GPU Workers

```
worker01 … worker08
  each: 8× B200
```

== Software Stack

```
Kubernetes
  └── NVIDIA GPU Operator
        └── CUDA
              └── TensorRT-LLM / vLLM
                    └── KServe
                          └── Ray (research / batch)
```

#table(
  columns: (1.6in, 1fr),
  table.header([Layer], [Role]),
  [Kubernetes], [Scheduling, HA, multi-tenancy],
  [GPU Operator], [Driver, device plugin, DCGM, MIG],
  [vLLM / TensorRT-LLM], [High-performance serving],
  [KServe], [CRDs, canary, autoscaling hooks],
  [Ray], [Research jobs, eval, offline batch],
)

// ═══════════════════════════════════════════════════════════════════
= Inference Request Flow

```
User → API Gateway → AuthN/Z → Inference Scheduler
     → Model Server → GPU Cluster → Response Tokens
     ↘ async InferenceRecord → 1-year archive
```

== Serving Requirements

#table(
  columns: (1.3in, 1fr),
  table.header([Attribute], [Target direction]),
  [Latency], [Interactive (TTFT + TPOT tuned)],
  [Context], [Up to 32k (initial planning)],
  [Concurrency], [~50 simultaneous users],
  [Throughput], [~1,000 tokens/sec aggregate],
)

```
50 concurrent × 20 tokens/sec/user ≈ 1,000 tokens/sec
```

A 64× B200 system is in the correct range for this profile on a large MoE, subject to model/kernel tuning.

// ═══════════════════════════════════════════════════════════════════
= Power

== Per Rack (32 GPUs / 4 servers)

#table(
  columns: (1.6in, 1in),
  table.header([Component], [Watts]),
  [4 GPU servers], [~40 kW],
  [Network], [~2 kW],
  [Storage share], [~3 kW],
  [Management share], [~1 kW],
  [*Rack total*], [*~46 kW*],
)

== Facility

#table(
  columns: (1.8in, 1fr),
  table.header([Item], [Spec]),
  [Baseline racks], [*4*: GPU-1, GPU-2, BOOT, STOR],
  [Cluster IT load], [~100–115 kW],
  [Available facility], [130–150 kW recommended],
  [GPU racks], [~43–46 kW each · 415 VAC A/B],
  [BOOT], [~4–8 kW (CP, bootstrap, spines)],
  [STOR], [~5–15 kW (hot FS + year archive)],
  [STOR-2], [Optional when archive >~1.5–2 PB],
  [Feeds], [A/B redundant all racks],
)

#callout[Storage racks][
  Day-1 needs *one* STOR rack for hot models + ≥750 TB archive. Second storage rack only for capacity/isolation growth — not required at 64-GPU scale.
]


// ═══════════════════════════════════════════════════════════════════
= Cooling

#table(
  columns: (1.2in, 1fr),
  table.header([Tier], [Approach]),
  [Minimum], [Hot-aisle containment + high-airflow CRAC],
  [Preferred], [Rear-door heat exchangers],
  [Future], [Direct liquid cooling (DLC)],
)

Plan layout so DLC retrofit is possible.

// ═══════════════════════════════════════════════════════════════════
= Monitoring and Observability

== GPU

NVIDIA DCGM · utilization · HBM · ECC · NVLink health · power / thermal

== Network

Interface errors · ECN marks · drops · RoCE congestion · fabric latency/loss · LANZ

== Application

Tokens/sec · TTFT · TPOT · queue depth · GPU / KV-cache occupancy · errors/timeouts · *archive lag & gap alarms*

// ═══════════════════════════════════════════════════════════════════
= High Availability

#table(
  columns: (1.3in, 1fr),
  table.header([Domain], [Approach]),
  [Control plane], [3-node Kubernetes HA],
  [Fabric], [Dual NIC, dual leaf (DX5-32), dual spine (DX5-64) ECMP + DLB],
  [Power], [A/B feeds],
  [Model serving], [Multi-replica where possible; KServe rolling updates],
  [Storage], [Hot FS repl/EC + archive object EC; 365d retention],
)

Align failure domains with racks and leaf pairs so a single leaf/rack loss does not take the full model offline if EP groups are placed carefully.

// ═══════════════════════════════════════════════════════════════════
= Expandability

#table(
  columns: (1.6in, 1fr),
  table.header([Path], [Notes]),
  [+1 rack (32 GPUs)], [Add leaf capacity, extend BGP EVPN, join workers],
  [+server within rack], [Power/cooling headroom first],
  [Storage growth], [Scale hot FS + object lake independently],
  [Multi-model], [Partition expert groups / namespaces by team],
)

// ═══════════════════════════════════════════════════════════════════
= Approximate Cost

#table(
  columns: (1.8in, 1.2in),
  table.header([Category], [Estimate]),
  [64× B200 GPUs], [\$4–6M],
  [GPU servers], [\$1–1.5M],
  [Network fabric], [\$1–1.5M],
  [Storage (hot + archive)], [\$0.5–1.5M+],
  [Rack / power / cooling], [\$500k],
  [*Total*], [*\$7–11M+*],
)

Order-of-magnitude planning only; obtain vendor quotes. Archive lake size drives storage variance.

// ═══════════════════════════════════════════════════════════════════
= Final Design Recommendation

#table(
  columns: (1.2in, 1fr),
  table.header([Layer], [Choice]),
  [Compute], [64× B200 / 8 nodes / 2 GPU racks],
  [Facility], [*4 racks*: GPU-1/2 + BOOT + STOR],
  [Network], [*8×400G/node* rails: 8×DX5-32 + 2×DX5-64S; *7010TX-48* OOB],
  [Storage], [Hot NVMe models + *≥750 TB* 1-year inference lake],
  [Platform], [Kubernetes + GPU Operator + vLLM/TRT-LLM + KServe + Ray],
  [Ops], [DCGM + EOS/LANZ + token SLOs + archive lag],
)

This is the scale at which the system behaves like a real AI supercomputer while remaining operable by an enterprise infrastructure team.

// ═══════════════════════════════════════════════════════════════════
= Document Roadmap

+ `docs/bom.md` — bill of materials and SKUs
+ `docs/network.md` — underlay, RoCE, QoS, IP plan
+ `docs/k8s.md` — cluster bootstrap, GPU Operator, serving
+ `docs/storage.md` — model repo, archive schema, performance
+ `docs/facility.md` — rack elevations, power, cooling
+ `docs/slo.md` — latency/throughput SLOs and capacity model

// ═══════════════════════════════════════════════════════════════════
= Revision History

#table(
  columns: (0.7in, 1.0in, 1fr),
  table.header([Ver], [Date], [Notes]),
  [0.1], [2026-07-18], [Initial specification],
  [0.2], [2026-07-18], [Network: Arista 7060DX5 (DX5-32 leaf, DX5-64S spine)],
  [0.3], [2026-07-18], [Lossless ≠ equal leaf/spine; square Clos Option B],
  [0.4], [2026-07-18], [OOB: Arista 7010TX-48 (2×, 1 per rack)],
  [0.5], [2026-07-18], [Storage integration: fabric, CSI/KServe, tiers],
  [0.6], [2026-07-18], [1-year inference archive lake (≥750 TB, async)],
)
