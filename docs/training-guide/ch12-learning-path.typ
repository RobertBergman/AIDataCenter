#import "lib.typ": *

= A Practical Learning Path, Labs, Glossary, and References

== The five-phase learning path

=== Phase 1 — Network transport (2--3 weeks)

Master Chapters 2 and 3 until you can whiteboard them: RoCEv2 encapsulation, RDMA verbs and
queue pairs, InfiniBand's credit-based losslessness, PFC mechanics and pathologies, ECN/DCQCN,
DSCP-to-TC mapping, and congestion behavior. Concrete exercises:

- Read a vendor AI/RoCE deployment guide end to end (Arista/Broadcom AI networking guide, NVIDIA RoCE configuration guides) and reproduce its QoS design rationale in your own words.
- *No-hardware lab:* Soft-RoCE (`rdma_rxe`) turns any Linux VM NIC into an RDMA device: `rdma link add rxe0 type rxe netdev eth0`, then run `ib_write_bw`/`ib_send_lat` between two VMs and watch verbs, QPs, and completions with `rdma stat`. Semantics without the hardware.
- Explain to a colleague why go-back-N makes loss catastrophic for RC transport — if you can teach it, you own it.

=== Phase 2 — GPU workload awareness (2--3 weeks)

Master Chapter 4: collectives, NCCL, parallelism strategies, and traffic signatures.

- Run PyTorch distributed on CPUs (Gloo backend) or any small GPU setup: implement data-parallel training of a toy model, log where time goes per step.
- Build `nccl-tests` and study the output columns until algorithm bandwidth versus bus bandwidth is second nature; learn `NCCL_DEBUG=INFO` output — ring/tree construction, chosen interfaces, rails.
- Hand-derive ring all-reduce cost: N GPUs, S bytes each — reduce-scatter plus all-gather, each moving S x (N-1)/N per GPU. Interviewers ask this.

=== Phase 3 — Build/test muscle (3--4 weeks)

Get hands on RDMA hardware if at all possible: two to four Linux servers with ConnectX NICs
(used ConnectX-5/6 cards are affordable; two direct-attached hosts suffice to start).

- Full `perftest` matrix: `ib_write_bw`, `ib_read_bw`, `ib_send_lat` across message sizes; pin with `numactl` and measure the NUMA penalty yourself.
- NIC forensics drill: `mlxconfig -d <dev> query`, `mlxlink` per-lane FEC/DOM readout, `ethtool -S` counter walk before and after a saturating run — find the pause and CNP counters.
- If a managed switch is available: configure the RoCE QoS class (DSCP 26 to queue 3, ECN thresholds, PFC on the class, CNP strict-priority), then *deliberately misconfigure one element* and observe the counter signature of each failure mode. This drill builds the diagnostic intuition Chapters 3 and 8 describe.
- `nccl-tests` over the fabric; compare bus bandwidth against line rate; degrade a link (FEC-stressed cable, forced lower speed) and watch the straggler effect.

=== Phase 4 — Fabric operations (3--4 weeks)

Practice operating like Chapter 9:

- Model a small fabric (even your lab) in NetBox: devices, interfaces, cables; write a script diffing LLDP neighbors against it — you have now built cabling validation.
- Stand up gNMI collection (or SONiC's telemetry container, or `gnmic` against a vEOS/cEOS lab) into Prometheus/Grafana; dashboard queue watermarks, pause counters, ECN marks.
- Build a containerlab topology with SONiC or cEOS nodes; template configs from the NetBox data with Jinja2; put the render-validate-deploy loop in CI (GitHub Actions is fine).
- Write the pre/post harness: a script that runs `ib_write_bw` and `all_reduce_perf` across defined pairs, stores JSON results, and diffs against baseline with thresholds.

=== Phase 5 — Vendor depth (ongoing)

Pick one AI stack and one Ethernet stack for depth; stay conversational on the rest:

- *Strong combo:* NVIDIA Spectrum-X + InfiniBand ecosystem (Cumulus/NVOS, UFM, SHARP, ConnectX/BlueField) *plus* Arista EOS or SONiC/Broadcom. Cisco Nexus/Silicon One and Juniper QFX/PTX/Apstra matter especially in enterprise-to-AI shops.
- Certifications/curricula that map well: NVIDIA's AI networking certifications (associate and professional level), vendor AI fabric design guides, and the UEC 1.0 specification overview documents.
- Follow the primary sources: UEC working-group publications, NVIDIA networking documentation, Arista/Broadcom AI deployment guides, SONiC release notes, and large-scale training infrastructure papers from Meta, Microsoft, and Google — these papers are effectively free senior-level case studies.

== Glossary

#grid(columns: (1fr, 1fr), gutter: 12pt,
[
- #gterm[All-reduce][Collective where every GPU obtains the sum of all GPUs' data]
- #gterm[All-to-all][Every GPU sends distinct data to every other GPU (MoE routing)]
- #gterm[BER][Bit error rate; pre-FEC and post-FEC rates assessed separately]
- #gterm[Bisection bandwidth][Bandwidth across a worst-case halving of the fabric]
- #gterm[CNP][Congestion Notification Packet — DCQCN's feedback message]
- #gterm[Collective][Group communication operation synchronizing GPUs]
- #gterm[DCQCN][ECN-driven congestion control for RoCEv2, in NIC hardware]
- #gterm[DDP][Direct data placement — NIC writes out-of-order packets to correct memory]
- #gterm[DOM/DDM][Digital optical monitoring — per-lane optic health telemetry]
- #gterm[ECMP][Equal-cost multipath; hash-based, struggles with elephant flows]
- #gterm[ECN][Explicit Congestion Notification — marking instead of dropping]
- #gterm[FEC][Forward error correction; RS-544 mandatory at PAM4 rates]
- #gterm[Flowlet][Burst of a flow separated by idle gaps; re-pathable safely]
- #gterm[GPUDirect RDMA][NIC DMAs directly to/from GPU memory, bypassing host RAM]
- #gterm[Go-back-N][Retransmission of the entire window after one loss]
- #gterm[Headroom][PFC buffer reserve absorbing in-flight data after pause]
- #gterm[HOL blocking][Head-of-line blocking — paused class stalls innocent flows]
- #gterm[Incast][Many senders converging on one receiver simultaneously]
- #gterm[LID][InfiniBand local identifier assigned by the subnet manager]
- #gterm[LPO][Linear pluggable optics — no module DSP, lower power]
],
[
- #gterm[MFU][Model FLOPS utilization — the cluster efficiency metric]
- #gterm[MPO/MTP][Multi-fiber connector for parallel optics; top contamination point]
- #gterm[NCCL][NVIDIA's topology-aware collective communication library]
- #gterm[NVLink domain][GPUs connected by NVLink/NVSwitch (server or NVL72 rack)]
- #gterm[OSFP/QSFP-DD][800G-capable pluggable module form factors]
- #gterm[PAM4][4-level signaling, 2 bits per symbol; needs FEC]
- #gterm[PFC][Priority Flow Control (802.1Qbb) — per-class pause]
- #gterm[PFC watchdog][Breaks deadlocks by draining chronically paused queues]
- #gterm[PXN][NCCL routing via NVLink to exit on the correct rail]
- #gterm[QP][Queue pair — RDMA's connection endpoint]
- #gterm[Rail][NIC k of every server, cabled to a common leaf/plane]
- #gterm[RoCEv2][RDMA over Converged Ethernet — IB transport over UDP/IP (port 4791)]
- #gterm[SAI][Switch Abstraction Interface — NOS-to-ASIC API (SONiC)]
- #gterm[SHARP][IB in-network reduction — switches compute the all-reduce]
- #gterm[SM][InfiniBand subnet manager (OpenSM/UFM)]
- #gterm[SoT][Source of truth — intended-state database (e.g., NetBox)]
- #gterm[Straggler][Slowest participant that stalls a synchronized collective]
- #gterm[UEC/UET][Ultra Ethernet Consortium / its new RDMA transport]
- #gterm[Verbs][The RDMA programming API (libibverbs)]
- #gterm[WRED][Weighted random early detection — the ECN marking mechanism]
],
)

== References

+ NVIDIA Spectrum-X Ethernet Platform for AI Networking — `https://www.nvidia.com/en-us/networking/spectrumx/`
+ Arista/Broadcom, High-Performance Ethernet Networking for Artificial Intelligence (AI deployment guide) — `https://www.arista.com/assets/data/pdf/Arista-Broadcom-AI-Networking-Deployment-Guide.pdf`
+ NVIDIA Collective Communications Library (NCCL) — `https://developer.nvidia.com/nccl`
+ NVIDIA Network Operator, Deployment on Kubernetes — `https://docs.nvidia.com/networking/display/kubernetes2570/deployment-guide-kubernetes.html`
+ Ultra Ethernet Consortium, Specification 1.0 announcement — `https://ultraethernet.org/ultra-ethernet-consortium-uec-launches-specification-1-0-transforming-ethernet-for-ai-and-hpc-at-scale/`

Further primary sources worth bookmarking: NVIDIA networking documentation (RoCE
configuration, GPUDirect), `perftest` and `nccl-tests` GitHub repositories, SONiC project
documentation, RFC 7938 (BGP in large-scale datacenters), and the DCQCN paper ("Congestion
Control for Large-Scale RDMA Deployments," SIGCOMM 2015).

== Closing

The distance between a strong enterprise network engineer and a strong AI datacenter network
engineer is real but bounded: one new transport model, one new congestion discipline, one new
workload to internalize, one physical layer to respect, one host stack to own, and an
operational culture that measures itself in GPU idle time. Every one of those is learnable
with the path above — and the enterprise discipline you already have (rigor, change safety,
telemetry instinct, automation) is precisely what AI infrastructure teams are desperate to
hire.
