#import "lib.typ": *

= The Mental Shift: The Network Is Part of the Computer

== Why this role is different

If you come from enterprise or service-provider networking, you already have most of the raw
material for this job: routing at scale, VXLAN/EVPN fabrics, QoS, telemetry, and automation.
What changes is not the protocols — it is the *definition of success*.

An enterprise network exists to provide reliable connectivity, segmentation, security, and
predictable operations to thousands of loosely coupled applications. If a link drops a few
packets, TCP retransmits, users never notice, and the SLA dashboard stays green.

An AI training fabric exists for exactly one purpose: *to make thousands of GPUs behave like
one giant computer with minimal idle time.* The network is the backplane of a distributed
supercomputer. Distributed training is a tightly synchronized bulk-synchronous workload:
every GPU computes, then every GPU exchanges gradients or activations, then every GPU waits
until that exchange completes before the next step begins. The job advances at the pace of
the *slowest* participant.

#keyidea[
  In enterprise networking, packet loss is an inconvenience absorbed by TCP. In an AI fabric,
  a single congested queue, a marginal optic, or one mis-cabled rail creates a *straggler* —
  and because collectives are barriers, one straggler stalls every GPU in the job. A cluster
  of 16,000 GPUs at roughly 2--3 dollars per GPU-hour burns tens of thousands of dollars per
  hour of aggregate idle time. Tail latency is not a nicety here; it is the product.
]

== The economics that drive the engineering

Every design decision in this domain traces back to one number: *GPU utilization* (often
discussed as MFU — model FLOPS utilization — or "goodput" at the job level). The network is
typically 10--15 percent of cluster capital cost, but a poorly behaving network can idle the
other 85--90 percent. That asymmetry explains behaviors that look extreme by enterprise
standards:

- Building *non-blocking or lightly oversubscribed* fabrics when enterprise designs happily run 4:1 or worse.
- Treating *microbursts, ECN mark rates, and PFC pause counters* as first-class operational signals, not curiosities.
- Replacing optics on *rising correctable FEC error trends*, long before the link actually flaps.
- Running *synthetic RDMA and NCCL benchmarks before and after every change*, the way an enterprise team might run a ping sweep.
- Refusing "it's up, ping works" as a definition of healthy. The bar is: *the job is not network-stalled.*

== What actually changes for you

#table(
  columns: (1fr, 1.4fr, 1.4fr),
  table.header([*Dimension*], [*Enterprise mindset*], [*AI fabric mindset*]),
  [Success metric], [Availability, five nines, MTTR], [Job completion time, GPU idle time, step-time variance],
  [Loss], [TCP recovers; some loss is normal], [Loss collapses RDMA throughput; fabric engineered lossless or loss-tolerant by design],
  [Latency], [Averages matter], [P99.9 (tail) matters; collectives finish at the slowest flow],
  [Flows], [Millions of small flows; ECMP hashes well], [Few, huge, synchronized elephant flows; ECMP hash collisions are a core problem],
  [QoS], [Voice/video priority queues], [PFC + ECN engineered per traffic class; buffer thresholds tuned per platform],
  [Monitoring], [Port up/down, utilization, syslog], [Queue depth, pause frames, ECN marks, FEC histograms, NCCL timing correlation],
  [Change control], [Maintenance windows, manual CLI], [GitOps pipelines, CI validation, automated pre/post performance baselines],
  [The host], [Someone else's problem], [NIC firmware, drivers, NUMA, and PCIe topology are *part of the network*],
)

== Translating your enterprise experience

Hiring managers are not looking for someone who abandons enterprise discipline. They want
that discipline *applied to a new failure model*. Here is how existing senior-level skills map:

#table(
  columns: (1fr, 1.8fr),
  table.header([*You already know*], [*How it translates to the AI datacenter*]),
  [BGP / core routing], [BGP is the standard underlay for large RoCE fabrics (RFC 7938-style eBGP per switch, unnumbered interfaces, /31s or IPv6 link-locals). Your routing depth transfers almost directly to the scale-out fabric underlay and to DCI.],
  [VXLAN/EVPN], [Still heavily used on the *front-end* network (management, storage access, user traffic, multi-tenancy). Back-end GPU fabrics are usually plain routed IP — simpler, but your overlay skills remain valuable for the rest of the plant.],
  [QoS experience], [Directly foundational for PFC, ECN, DSCP-to-traffic-class mapping, and buffer tuning — the single most important new skill area (Chapter 3).],
  [Telemetry, Splunk/Zabbix], [Evolves into gNMI streaming telemetry at seconds-level cadence, queue watermarks, and correlating fabric counters with GPU job metrics (Chapter 8).],
  [Automation / IaC], [Becomes mandatory. 1,000--100,000 GPU fabrics are operated as code: source-of-truth-driven config, CI validation, automated cabling checks (Chapter 9).],
  [Optical / DWDM exposure], [Maps to 400G/800G optics, FEC analysis, and coherent DCI (Chapters 6 and 10).],
)

#soundbite[
  "The biggest shift coming from enterprise is redefining what 'working' means. In my world,
  loss was absorbed by TCP and averages mattered. In an AI fabric, the network is the
  backplane of one distributed computer — collectives are synchronization barriers, so tail
  latency and microbursts directly convert into GPU idle time and dollars. My job is not to
  keep ports up; it is to keep the job from being network-stalled."
]

== The role in one sentence

A senior AI network engineer is *part network engineer, part HPC fabric engineer, part
Linux/NIC troubleshooter, part automation engineer, and part performance analyst*. The rest
of this guide builds each of those parts in the order a fabric is built: transport semantics
first, then losslessness, then the workload, then topology, then the physical plant, then the
host, then operations.
