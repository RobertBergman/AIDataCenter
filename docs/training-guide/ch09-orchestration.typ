#import "lib.typ": *

= Orchestration, NOS Diversity, and Fabric-as-Code

== Kubernetes: how the fabric reaches the pod

Most AI platforms schedule training via Kubernetes (or Slurm, often Slurm-on-K8s). The
network engineer's concern: *how do RDMA NICs and GPUDirect capabilities get exposed to
containers correctly?*

- *NVIDIA Network Operator* — the keystone component. It deploys and lifecycle-manages, as Kubernetes resources: the DOCA/OFED driver (as a container, decoupled from host image), the *RDMA shared device plugin*, the *SR-IOV device plugin*, and secondary network attachment for RDMA traffic. It pairs with the *GPU Operator* (drivers, DCGM, `nvidia-peermem`) so GPUDirect RDMA works end to end.
- *Multus* — pods get their default cluster network (the primary CNI) *plus* secondary high-performance interfaces via `NetworkAttachmentDefinition`: SR-IOV VFs, macvlan/ipvlan on the rail interfaces, or host-device passthrough. The training pod does NCCL over the secondary rails, not the cluster CNI.
- *Resource semantics:* NICs/VFs are schedulable resources (`nvidia.com/hostdev`-style requests via device plugins). Topology-aware scheduling and NUMA alignment (Topology Manager) keep the allocated GPU, NIC, and CPU cores on the same root complex — Chapter 7's rules, enforced by the scheduler.
- What you own in interviews: the flow "pod requests GPU + RDMA resource → device plugin allocates VF/device on the right rail → Multus attaches it → NCCL discovers it (`NCCL_IB_HCA`, `NCCL_SOCKET_IFNAME`) → traffic rides your QoS-engineered class."

== Slurm: the HPC scheduler view

Slurm remains standard in HPC-style shops: `gres` declares GPUs/NICs per node;
*`topology.conf`* describes the switch hierarchy so the scheduler packs jobs into the
smallest enclosing switch domain (exactly the failure-domain placement from Chapter 5);
prologs/epilogs run health checks (including NIC/link state) before and after each job. The
network team feeds Slurm its topology truth and consumes its job-placement data for
observability correlation.

== NOS diversity: SONiC, whitebox, and life beyond appliance CLI

AI shops mix NOS ecosystems in ways enterprise rarely does:

- *SONiC* — open-source NOS (Microsoft-originated, now broadly adopted; hyperscalers and increasingly enterprise AI). Architecture you should be able to sketch: containerized daemons (BGP/FRR, `orchagent`, platform containers) around a central Redis *CONFIG_DB/APPL_DB/STATE_DB*, with *`syncd`* programming the ASIC through *SAI (Switch Abstraction Interface)* — the vendor-neutral ASIC API. Config is JSON in Redis, not a config file you "write mem" on; operations are Linux-native (it *is* Debian), and telemetry/config surface is gNMI/gNOI.
- *SAI limitations* — the abstraction covers the common denominator; ASIC-specific buffer/QoS knobs may lag or need vendor extensions. When an AI-fabric tuning guide says "set this Tomahawk register behavior," you need to know whether your NOS exposes it.
- *FBOSS / custom NOS* — Meta-style fully in-house stacks; relevant to hyperscaler roles primarily as context.
- *Traditional NOS in AI mode* — Arista EOS (deep buffer visibility, LANZ, AI-tuned profiles), Cisco Nexus/NX-OS and Silicon One, Juniper QFX/Apstra: still very common, especially in "enterprise-to-AI" environments. The senior skill is *not* memorizing one CLI — it is understanding the ASIC behavior underneath and driving any NOS through structured APIs.
- *gNMI/gNOI* — the management plane: gNMI for streaming telemetry and declarative config (`Set`/`Subscribe` on YANG paths), gNOI for operations (reboot, cert rotation, ping, factory reset). In pipeline-driven fleets, humans read dashboards and merge PRs; only break-glass touches a CLI.

== Fabric-as-code: the operating model

At 1,000--100,000 GPUs, manual CLI operation is not merely inefficient — it is the leading
cause of the exact one-off inconsistencies (a missing QoS map, a wrong MTU) that create
silent stragglers. The target operating model:

+ *Source of truth (SoT)* — NetBox/Nautobot or equivalent holds the intended world: devices, ports, cables (the rail map!), IPs, ASNs, QoS profiles. The SoT is authoritative; the network is a *rendering* of it.
+ *Golden config generation* — templates render per-device config from SoT data. No hand-edited device configs; changes are data changes.
+ *GitOps pipeline* — every change is a PR: peer review, then CI validates (lint, schema, config diff, topology simulation — containerlab/vendor digital twin, route/policy checks), then staged rollout with health gates and *automated rollback* on regression.
+ *ZTP* — new or RMA'd switches boot, fetch identity and golden config, and join the fabric without a console session; at AI-buildout scale (hundreds of switches per pod), this is the only way to hit schedules.
+ *Automated cabling validation* — LLDP neighbor data continuously diffed against the SoT cable plan. This is the mechanized answer to "one mis-cabled rail": detected in minutes at build time, not discovered weeks later as a performance mystery.
+ *Performance CI ("pre/post" discipline)* — before and after every meaningful change: synthetic `ib_write_bw`/`ib_read_bw` path tests and `nccl-tests` baselines on a reference set of node groups, compared against stored baselines with regression thresholds. A change that passes config validation but drops all-reduce bus bandwidth 8% *fails* and rolls back.
+ *Continuous drift detection* — running config and operational state (FEC modes, PFC state, buffer profiles) reconciled against intent on a schedule.

#gotcha[
  The pre/post NCCL baseline is the discipline that most distinguishes AI fabric operations
  from enterprise change management. Enterprise verifies *reachability* after a change; AI
  fabric teams verify *performance*. Many costly regressions — an ECN threshold typo, a buffer
  profile swap, a link running at half FEC health after re-seat — are invisible to ping and
  BGP state, and perfectly visible to a 60-second `all_reduce_perf` run.
]

#soundbite[
  "I treat the fabric as a rendering of a source of truth: NetBox holds the rail map and QoS
  intent, templates render golden configs, every change is a reviewed PR that has to pass CI —
  including synthetic RDMA and NCCL baselines pre- and post-change, with automated rollback.
  And I'm deliberately NOS-agnostic: whether it's EOS, NX-OS, or SONiC programming the ASIC
  through SAI, the pipeline speaks gNMI and the source of truth doesn't care whose logo is on
  the faceplate."
]
