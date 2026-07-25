#import "lib.typ": *

= GPU Collective Traffic: What the Workload Does to Your Fabric

You cannot design or troubleshoot an AI fabric without knowing what distributed training
actually transmits. This chapter is the "know your customer" chapter: NCCL, the collective
operations, the parallelism strategies that generate them, and the traffic signatures they
leave on the wire.

== NCCL: the traffic generator

*NCCL (NVIDIA Collective Communications Library)* is the communication engine underneath
PyTorch and JAX distributed training on NVIDIA hardware. It implements collective operations
across GPUs within a server (over NVLink) and across servers (over IB or RoCE), and it is
*topology-aware*: at startup it discovers NVLink connectivity, PCIe layout, NIC placement,
and rails, then builds ring and tree communication graphs over that topology.

Two consequences make NCCL your concern as a network engineer:

+ *The network topology directly shapes job performance*, because NCCL's rings and trees are laid over the physical paths you built. A rail-optimized fabric (Chapter 5) exists specifically to serve NCCL's communication patterns.
+ *NCCL behavior is tunable and mis-tunable* via environment variables (`NCCL_ALGO`, `NCCL_PROTO`, `NCCL_IB_HCA`, `NCCL_SOCKET_IFNAME`, `NCCL_IB_QPS_PER_CONNECTION`, `NCCL_MIN_CTAS`…). "The network is slow" tickets are frequently NCCL picking a wrong interface or algorithm — you must be able to read NCCL debug output (`NCCL_DEBUG=INFO`) and the `nccl-tests` benchmarks.

== The collective operations

For a data size S per GPU across N GPUs, know what each collective does and what it costs:

#table(
  columns: (1fr, 1.9fr, 1.3fr),
  table.header([*Collective*], [*What it does*], [*Where you see it*]),
  [All-reduce], [Every GPU ends with the element-wise sum of all GPUs' buffers. Equivalent to reduce-scatter + all-gather. Each GPU sends/receives about 2S x (N-1)/N.], [Gradient synchronization in data parallelism — the classic training collective],
  [Reduce-scatter], [Sum is computed but each GPU keeps only its 1/N shard.], [First half of all-reduce; ZeRO/FSDP gradient sharding],
  [All-gather], [Every GPU's shard is concatenated to every GPU.], [FSDP/ZeRO parameter gathering before each layer's compute],
  [Broadcast], [One GPU's buffer copied to all.], [Weight initialization, checkpoint restore fan-out],
  [All-to-all], [Every GPU sends a distinct block to every other GPU — N x (N-1) simultaneous flows.], [Mixture-of-Experts routing; the most fabric-hostile pattern],
  [Point-to-point send/recv], [Pairwise transfers.], [Pipeline parallelism activations between stages],
)

=== Ring vs tree all-reduce

- *Ring:* GPUs form a logical ring; data moves in chunks around it in 2(N-1) steps. Bandwidth-optimal (each link carries the minimum possible), so it dominates for large messages. Cost: latency grows linearly with N — at thousands of GPUs, ring latency for small messages hurts.
- *Tree:* logarithmic depth, latency-optimal for small/medium messages at large scale. NCCL switches between rings, trees, and hybrid algorithms per message size and scale.
- *SHARP/in-network reduction* (IB, and switch-assisted collectives elsewhere) offloads the arithmetic into switches, roughly halving traffic and cutting latency — worth raising in any IB-vs-Ethernet discussion.

The `nccl-tests` suite (`all_reduce_perf` etc.) reports *algorithm bandwidth* (data size /
time) and *bus bandwidth* (normalized to per-link utilization so it is comparable to line
rate). Bus bandwidth at ~85--95% of line rate is healthy; interpreting these numbers is a
practical skill hiring teams probe.

== Parallelism strategies and their network signatures

Large-model training composes several parallelism dimensions, and each stresses the network
differently. This mapping is core senior-level knowledge:

#table(
  columns: (1.1fr, 1.7fr, 1.6fr),
  table.header([*Strategy*], [*What it splits*], [*Network signature*]),
  [Data parallel (DP)], [Same model replicated; each GPU gets different data; gradients synchronized every step.], [Periodic large all-reduce across the DP group — big, bursty, synchronized; tolerant of moderate latency, hungry for bandwidth.],
  [Fully sharded DP (FSDP/ZeRO)], [Parameters, gradients, optimizer state sharded across GPUs.], [All-gather + reduce-scatter *per layer*, overlapped with compute — more frequent, finer-grained collectives; sensitive to latency and jitter.],
  [Tensor parallel (TP)], [Individual layers' matrices split across GPUs.], [All-reduce/all-gather inside every layer, multiple times per step — extremely latency-sensitive; kept *inside the NVLink domain* (within a server or NVL72 rack), almost never across your fabric.],
  [Pipeline parallel (PP)], [Model layers split into sequential stages.], [Point-to-point activation/gradient transfers between adjacent stages — moderate bandwidth, steady cadence.],
  [Expert parallel (MoE)], [Different experts on different GPUs; tokens routed dynamically.], [All-to-all at every MoE layer — dense any-to-any mesh of flows, unpredictable per-destination volume; the pattern that most punishes oversubscription and poor load balancing.],
)

#keyidea[
  The placement rule that shapes cluster design: *the most latency-sensitive parallelism (TP)
  stays inside the NVLink domain; bandwidth-heavy but latency-tolerant parallelism (DP/PP)
  crosses the scale-out fabric.* Your fabric is primarily carrying DP all-reduce,
  FSDP all-gather/reduce-scatter, PP point-to-point, and MoE all-to-all. Schedulers and NCCL
  assume this hierarchy — and a job placed across failure domains that violates it will
  underperform on a perfectly healthy network.
]

== Traffic characteristics that break enterprise assumptions

- *Synchronized bursts, not statistical multiplexing.* Enterprise fabrics work because millions of independent flows average out. Training traffic is the opposite: a compute phase of near-silence, then *every NIC transmits at line rate simultaneously* when the collective starts. Design for coordinated microbursts, not for averages.
- *Few, fat, long-lived flows with low entropy.* A GPU server pair may exchange a handful of enormous QP flows. Five-tuple ECMP hashing was designed for flow-count diversity that simply is not there — hash collisions park two elephants on one uplink while its neighbor idles (Chapter 5).
- *Barrier semantics.* Every step ends with synchronization. The slowest flow sets the pace for all N GPUs — this is why P99.9 flow-completion time, not average throughput, is the design metric.
- *Periodicity.* Steps repeat every few hundred milliseconds to seconds, so fabric pathologies show up as *rhythmic* congestion with the job's step frequency — a genuinely useful diagnostic signature.
- *Checkpoint traffic.* Every checkpoint interval, the job dumps model + optimizer state (from hundreds of GB to tens of TB for frontier models) to storage — a massive synchronized *write* burst on the storage network. If checkpoints and gradients share links or buffers, checkpoints can stall training; many designs isolate a storage/front-end fabric from the GPU back-end fabric partly for this reason.

== The failure-mode view

Because of barrier semantics, workload symptoms map to network causes in characteristic ways:

- One degraded link (FEC storm, flapping optic) → one slow rail → stragglers → *every* step slower.
- ECMP collision → persistent hot uplink → specific ranks always late → step-time variance.
- A single "slow NIC" (thermal throttling, wrong PCIe width) → that rank lags every collective → job-wide slowdown that looks like "the network."
- Lost RDMA packets (QoS misconfig on one hop) → go-back-N retransmit stalls → sawtooth throughput and `out_of_sequence` counters climbing on NICs.

#soundbite[
  "Training traffic inverts every statistical assumption enterprise QoS relies on: instead of
  millions of uncorrelated small flows, I get a few thousand synchronized elephant flows that
  all start in the same microsecond, because NCCL collectives are barriers. So I design for
  the burst, not the average — and when a job 'gets slow', my first mental model is a
  straggler: one rail, one link, one NIC dragging every step, not the fabric being uniformly
  busy."
]
