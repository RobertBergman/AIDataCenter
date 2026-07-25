#import "lib.typ": *

= AI Fabric Topology: Beyond Generic Leaf-Spine

Enterprise leaf-spine answers the question "how does every server get network access?" AI
fabric design answers a different question: *"how do I preserve GPU-to-GPU bandwidth for a
specific, known communication pattern at minimum cost and blast radius?"*

== Foundations: Clos, bisection, and oversubscription

The scale-out fabric is a *fat-tree / folded Clos*: leaves (ToR or in-rack), spines, and at
large scale a third *core/super-spine* tier connecting pods. Key quantitative vocabulary:

- *Bisection bandwidth* — cut the cluster into two halves; the bandwidth crossing the cut. A *non-blocking (1:1)* fabric provides full bisection: any half can talk to the other half at full NIC rate.
- *Oversubscription* — the ratio of downlink to uplink capacity at a tier. A leaf with 32 x 800G down and 16 x 800G up is 2:1.
- The engineering rule of thumb: *the GPU back-end fabric is built 1:1 through at least the pod level*, because all-reduce and all-to-all genuinely use the bisection. Front-end/storage networks can tolerate oversubscription; the gradient fabric mostly cannot. Where budgets force oversubscription, it is placed *between* pods, and the scheduler keeps jobs inside pods.

Worked example you can do on a whiteboard: 1,024 GPUs with one 400G NIC each = 409.6 Tb/s of
NIC capacity. Non-blocking two-tier fabric with 64-port 800G switches (running ports as
2 x 400G toward hosts): each leaf uses 32 ports down / 32 up, needing 32 leaves and 16 spines
for a 512-GPU pod at 1:1; two such pods join at a core tier sized to the inter-pod traffic
you intend to allow. The point of the exercise: *fabric sizing is arithmetic from GPU count
and NIC speed* — hiring panels love this question.

== Rail-optimized design

The signature AI topology. In an 8-GPU HGX server, each GPU has its own dedicated
400G/800G NIC. Number the NICs 0--7. A *rail* is the set of NIC k across all servers.

- *Rail-optimized fabric:* NIC k of every server connects to leaf/plane k. Eight parallel "rails," each its own subtree (or its own entire plane).
- *Why:* NCCL organizes inter-node communication so that GPU k on one server predominantly talks to GPU k on other servers (same rail). Same-rail traffic crosses *one leaf hop* instead of traversing spines — lower latency, fewer buffer contention points, and spine capacity reserved for the collectives that truly need it. Cross-rail traffic inside a server rides NVLink (NCCL's PXN feature moves data to the right GPU over NVLink so it can exit on the right rail).
- *Operational consequence:* cabling and NIC-to-leaf mapping are *load-bearing correctness constraints*. One server with NIC 3 cabled into rail 5 forces cross-rail traffic through spines, and NCCL's topology assumptions quietly degrade — "one mis-cabled rail can reduce millions of dollars of GPU productivity." Automated cabling validation (LLDP against the design's source of truth) is mandatory, not optional (Chapter 9).

== Multi-plane fabrics and NVLink domain boundaries

- *Multi-plane:* instead of one giant fabric, build k independent parallel fabrics ("planes"), each connecting one NIC per server. Planes bound failure blast radius (a spine failure degrades one plane by 1/k, not the whole cluster), simplify very large scale-out, and map naturally onto rails.
- *NVLink domain:* inside a server (8 GPUs, ~900 GB/s per GPU on NVLink4/NVSwitch) or a rack-scale NVL72 system (72 GPUs on an NVLink switch fabric), GPU-to-GPU bandwidth is roughly an order of magnitude above the network fabric. *The fabric's job begins where the NVLink domain ends.* Cluster design is therefore hierarchical: NVLink domain → rail/leaf → pod (often a "scalable unit" of a few hundred to ~1k GPUs at 1:1) → core tier between pods.
- *Alternative topologies:* dragonfly and dragonfly+ (HPC heritage, groups with all-to-all local links and global links between groups) trade cost for path diversity and appear in some IB and research designs; torus/mesh appears in TPU pods. For Ethernet AI fabrics, fat-tree/Clos with rails remains the dominant answer — but know the names and trade-offs.

== Failure domains and placement

Because collectives are barriers, *where* a job lands matters as much as fabric health:

- Keep a job's DP/TP groups within the smallest enclosing domain (NVL domain → rail group → pod). A job spanning pods pays inter-pod oversubscription on every all-reduce.
- Schedulers (Slurm topology plugin, Kubernetes topology-aware scheduling) consume a topology description *you* help maintain — fabric engineering and job scheduling co-design (Chapter 9).
- Blast-radius thinking: a leaf failure in a rail design takes out one NIC on every server beneath it (jobs continue degraded on 7 of 8 rails) versus a whole server group on a conventional ToR. Design reviews in this world explicitly enumerate "what does the job feel" for each component failure.

== Load balancing: the ECMP problem and its fixes

Static 5-tuple ECMP fails AI traffic (few flows, low entropy, elephant sizes — Chapter 4).
Know the escalation ladder of fixes:

+ *More entropy from the NICs:* RoCE UDP source-port randomization per QP; NCCL splitting traffic across multiple QPs (`NCCL_IB_QPS_PER_CONNECTION`) to give the hash more material.
+ *Dynamic / adaptive load balancing (DLB):* switch reassigns flows (or *flowlets* — bursts separated by idle gaps) to the least-loaded uplink based on real-time egress load. Flowlet switching exploits collectives' natural pauses to re-path without reordering.
+ *Packet spraying / per-packet multipathing:* distribute every packet round-robin or load-aware across all uplinks — perfect utilization, but packets arrive out of order, so the *receiver must reorder*: modern NICs with DDP handle out-of-order RDMA placement (writing data directly where it belongs regardless of arrival order); Ultra Ethernet builds this in (Chapter 10). NVIDIA Spectrum-X markets exactly this combination — switch-side fine-grained spraying plus NIC-side reordering, with telemetry-driven congestion feedback.
+ *IB adaptive routing:* the InfiniBand equivalent, mature and SM-orchestrated, with destination-side reordering.

#gotcha[
  A recurring real-world incident: fabric at 40% average utilization, one uplink at 100% with
  ECN marks and pauses — two elephant QPs hashed together. Enterprise instinct says "plenty of
  headroom"; AI fabric reality says "hash collision starving one rail." The fix is adaptive
  load balancing or more QP entropy — not more bandwidth. Recognizing this pattern from
  counters is a standard interview scenario.
]

#soundbite[
  "I would describe a modern AI back-end as: NVLink domains at the bottom, rail-optimized
  leaves above them, non-blocking to the pod boundary, planes for blast-radius isolation, and
  only then oversubscription between pods — with the scheduler topology-aware so jobs stay
  inside their domain. And because the flow count is tiny by enterprise standards, I assume
  static ECMP will fail and plan for adaptive load balancing or packet spraying with
  NIC-side reordering from day one."
]
