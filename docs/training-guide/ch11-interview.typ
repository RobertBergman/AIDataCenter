#import "lib.typ": *

= Interview Preparation: Questions, Model Answers, and Positioning

This chapter converts the technical material into interview performance. The model answers
are deliberately senior in tone: they state the concept, the failure modes, and the
operational discipline — the three layers interviewers listen for.

== How to position an enterprise background

Lead with the mental-model shift (Chapter 1), then anchor every answer in your transferable
strengths: routing at scale (the RoCE underlay is BGP), QoS depth (PFC/ECN is QoS with higher
stakes), telemetry (gNMI is your Splunk instinct at higher cadence), and automation (fabric-
as-code is IaC discipline applied to switches). Never apologize for lacking GPU-cluster
mileage; demonstrate you know precisely *which* skills are new and show evidence you are
building them (the lab work in Chapter 12 is that evidence).

== Technical questions and model answers

#qa[Why can't you just run RoCE on a default-configured enterprise switch?][
  RoCEv2 carries InfiniBand's reliable-connection transport, which traditionally recovers
  loss with go-back-N — one drop retransmits the whole window, stalling a collective that
  thousands of GPUs are waiting on. Default Ethernet drops on congestion, so I must engineer
  the fabric: consistent DSCP-to-traffic-class mapping end to end, ECN/WRED thresholds so
  DCQCN rate control acts first, PFC on the RoCE class as a safety net with properly sized
  headroom and a deadlock watchdog, and CNPs in a protected strict-priority queue. Then I
  monitor marks, pauses, and watermarks to prove it stays engineered.
]

#qa[Explain DCQCN end to end.][
  Three roles. Congestion point: the switch marks packets CE via ECN as queue depth crosses
  thresholds. Notification point: the receiving NIC sees CE-marked RoCE packets and returns
  CNPs to the sender. Reaction point: the sending NIC cuts that queue pair's rate sharply on
  CNP arrival and recovers additively, governed by a decaying congestion estimate. Tuning is
  about the ECN thresholds — mark too early and you waste bandwidth, too late and queues grow
  until PFC fires. The design intent is ECN resolves congestion at RTT timescales so PFC
  almost never engages.
]

#qa[What is a PFC storm and how do you contain it?][
  PFC pause propagates: a paused device's buffers fill, so it pauses its own upstreams, and
  congestion cascades backward — potentially from a single broken receiver that stopped
  draining. One malfunctioning NIC can degrade a whole pod. Containment: PFC watchdog to
  detect queues paused beyond a threshold and force-drain them, valley-free routing to avoid
  cyclic buffer dependency deadlocks, alarming on pause-frame rates so a chronically pausing
  endpoint gets quarantined, and keeping PFC scoped to only the RoCE class so the blast
  radius never includes control traffic.
]

#qa[Why are AI fabrics rail-optimized?][
  Each of the eight GPUs in a server has its own NIC; rail k of every server connects to the
  same leaf or plane. NCCL is topology-aware and organizes inter-node traffic so GPU k talks
  predominantly to GPU k on other nodes — same rail, one leaf hop, no spine crossing — while
  cross-rail movement rides NVLink inside the chassis. It preserves GPU-to-GPU bandwidth and
  cuts contention. The operational flip side: the cable map is a correctness constraint, so I
  validate cabling automatically against the source of truth — one mis-cabled rail silently
  degrades every job that touches it.
]

#qa[A training job is 17% slower than last week. Walk me through your approach.][
  First scope from the job inward: which ranks, which collective, when it started — NCCL logs
  and per-rank timings tell me if it's a straggler or systemic. Straggler: that host's PCIe
  width and GPU-NIC affinity, NIC counters for retransmit symptoms and pauses, per-lane FEC
  and DOM on its links — the classic culprit is a marginal optic on one rail. Systemic:
  correlate changes — config pushes, firmware, NCCL versions, and whether the scheduler
  placed the job across pods — then compare fabric baselines: ECN mark rates, pause trends,
  watermark peaks, ECMP member imbalance. I reproduce below the application with ib_write_bw
  and all_reduce_perf to bisect fabric versus host versus workload, and whatever I find
  becomes a permanent alarm or CI check.
]

#qa[Why does static ECMP struggle with AI traffic, and what are the fixes?][
  Collectives generate a handful of enormous, long-lived, synchronized flows — almost no
  entropy for a five-tuple hash, so two elephants land on one uplink while neighbors idle:
  hot link, marks, pauses, stragglers, at 40% average utilization. Fixes in escalation:
  more entropy (per-QP UDP source ports, multiple QPs per connection), flowlet-based dynamic
  load balancing that re-paths in the natural gaps, and ultimately packet spraying with
  NIC-side reordering — which is what IB adaptive routing and Spectrum-X do today and what
  Ultra Ethernet standardizes.
]

#qa[How do you size PFC headroom, and what happens if you get it wrong?][
  Headroom absorbs in-flight data after XOFF: propagation delay both ways — so cable length
  matters — plus peer response time and the frames already serializing. Too little headroom
  means drops on a nominally lossless class, which is the worst failure mode because
  everyone assumes lossless means lossless; too much wastes shared buffer that other ports
  need. I use the platform's per-cable-length guidance, keep cable lengths in the source of
  truth, and alarm on any ingress drop in the lossless class as a design violation.
]

#qa[What does GPUDirect RDMA require from the infrastructure?][
  An RDMA NIC and GPU with peer-to-peer PCIe visibility — same root complex, ideally the same
  PCIe switch, verified with nvidia-smi topo; ACS configured so peer TLPs aren't forced
  through the root complex; the peer-memory kernel module or DMA-BUF path loaded; and a
  qualified driver/firmware/CUDA/NCCL version matrix. Symptom of getting it wrong: bandwidth
  tests that hit line rate host-to-host but collapse GPU-to-GPU, because data is silently
  bouncing through system memory.
]

#qa[InfiniBand or Ethernet for the next cluster?][
  Both are proven at frontier scale, so it's an engineering-economics decision. InfiniBand:
  losslessness by credit-based flow control with no tuning, mature adaptive routing, SHARP
  in-network reduction, one vendor's turnkey performance — at cost of a parallel skill set,
  single-vendor supply, and a separate operational stack. Ethernet/RoCE: ecosystem economics,
  multi-vendor leverage, one operational model with the rest of the plant, and with modern
  platforms — adaptive routing, NIC reordering, tuned DCQCN — comparable delivered
  performance; UEC is closing the remaining transport gaps. My answer for most organizations
  is Ethernet for strategic alignment unless the workload profile and vendor relationship
  argue for IB — and I'd insist the decision include operations, not just benchmarks.
]

#qa[What monitoring would you build for a new GPU fabric?][
  Streaming gNMI at seconds cadence into a time-series pipeline: per-queue watermarks, ECN
  marks, PFC pauses per priority, drops by reason, per-lane FEC corrected and uncorrectable,
  DOM trends. Host side: NIC RoCE counters — out-of-sequence, retransmit timeouts, CNPs — plus
  DCGM for GPU idle time, on the same timeline. Topology-joined, so a rank maps to a rail
  and a port in one query. Then synthetic canaries — scheduled perftest and small NCCL runs —
  as continuous proof of fabric performance, and as the pre/post gate in the change pipeline.
  The design goal is answering 'is any job network-stalled' in minutes.
]

#qa[How does your change management differ on an AI fabric?][
  Everything is a PR against a source of truth, rendered to golden configs, validated in CI —
  but the AI-specific discipline is performance regression testing: before and after every
  change we run RDMA and NCCL baselines on reference paths and compare against stored
  results with thresholds. Reachability tests don't catch an ECN threshold typo or a buffer
  profile regression; a sixty-second all-reduce benchmark does. Plus automated rollback,
  canary scope-outs, and drift detection reconciling operational state — FEC modes, PFC
  state — against intent.
]

#qa[What is SHARP and why does it matter?][
  In-network computing: InfiniBand switches perform the reduction arithmetic of all-reduce
  inside the fabric, aggregating as data flows up a tree and multicasting results down.
  It roughly halves the data movement and removes latency stages, which matters most at
  large scale and for frequent small collectives. It's also a preview of where Ethernet is
  headed — UEC defines in-network collectives, and switch-assisted reduction is a
  differentiator vendors compete on.
]

#qa[What would you check before handing a new fabric to the ML platform team?][
  A formal acceptance suite: cabling validated by LLDP diff against the rail map; every link
  at full speed and width with clean per-lane FEC baselines and DOM within thresholds; QoS
  rendering verified on every device — classification, ECN thresholds, PFC state, headroom;
  underlay routing convergence tested with failure injection; then performance acceptance —
  ib_write_bw full-mesh sweeps per rail, then nccl-tests all-reduce and all-to-all at
  increasing scope from single rack to full pod, compared against the design's expected bus
  bandwidth. All results stored as the fleet's birth certificate for future regression
  comparison.
]

#qa[Where do you see AI network engineering going in the next few years?][
  Transport: Ultra Ethernet — packet spraying, selective retransmission, congestion control
  that doesn't require fully lossless fabrics — begins retiring today's delicate PFC-centric
  engineering. Physical: 1.6T ports, linear-drive and eventually co-packaged optics to
  contain power. Scale-up and scale-out blur as NVLink-class domains grow and fabrics carry
  more of the collective load in-network. And operationally, the job keeps moving toward
  fleet software engineering: the differentiator is the telemetry, validation, and automation
  stack, not CLI fluency.
]

== Questions to ask the interviewer

Asking sharp questions signals seniority as strongly as answering them:

- "Ethernet or InfiniBand back-end, and what drove that choice? Are you tracking UEC for the next generation?"
- "How is the fabric validated after changes — do you run NCCL/RDMA performance baselines pre/post, or reachability only?"
- "What's the current top network-attributed cause of job slowdown or restart, and how is it detected today?"
- "Is cabling/rail mapping validated automatically against a source of truth? What's the SoT?"
- "Where does the network team's ownership end — switchport, NIC firmware, host stack, NCCL tuning?"
- "What does the telemetry pipeline look like — gNMI cadence, queue watermarks, correlation with job metrics?"
- "How are jobs placed relative to failure domains, and does the network team feed the scheduler's topology?"

== Red flags to avoid in your own answers

- Talking about link utilization averages as evidence of health (signals enterprise reflexes).
- Claiming PFC alone makes a fabric lossless and healthy (ignores ECN's primary role and PFC's pathologies).
- Treating the host as out of scope ("that's the server team") — in this role the NIC and PCIe topology are yours.
- Vendor-war absolutism in the IB-versus-Ethernet question — the senior answer is engineering-economics, not tribal.
- Any suggestion that manual CLI operation scales to this environment.
