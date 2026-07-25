#import "lib.typ": *

= AI Fabric Observability and Failure Analysis

Enterprise monitoring answers "is the network up and how busy is it?" AI fabric
observability answers a harder question: *"is any job network-stalled, and which component is
responsible?"* The defining incident type is not an outage — it is "this training job is 17%
slower than yesterday," with every port green.

== The counter set that actually matters

#table(
  columns: (1.15fr, 1.85fr),
  table.header([*Signal*], [*Why it matters / what it tells you*]),
  [PFC pause frames (tx/rx, per port, per priority)], [The safety valve firing. Sustained pause TX from a switch = its buffers are stressed; pause RX = your neighbor is stressed. Rising trends localize congestion; a single host emitting constant pause = broken NIC endangering the pod.],
  [ECN marked-packet rate (per queue)], [The control loop working. Some marking under load is healthy; mark rate trends are your earliest congestion signal and your ECN-threshold tuning feedback.],
  [Queue depth watermarks / buffer occupancy], [Peak (not average) queue depth per port per class — the direct measurement of microbursts. Watermark polling or streaming beats any utilization graph.],
  [Drops by reason (WRED, tail, ingress admission)], [On a lossless class, any drop is an event worth explaining — usually QoS misclassification (Chapter 3) or headroom exhaustion.],
  [FEC corrected/uncorrectable, per lane; DOM trends], [Physical-layer pre-failure signal (Chapter 6). The "which optic hurts jobs next week" feed.],
  [Link flaps, CRC, symbol errors], [Job-restart-level events; correlate across shared panels/conduits/power.],
  [NIC RoCE counters (`out_of_sequence`, `packet_seq_err`, timeouts, CNPs sent/handled, retransmits)], [The end-system's verdict on the fabric: retransmit symptoms prove loss/reordering that switch counters may not attribute; CNP volume shows the DCQCN loop's workload.],
  [Per-job/per-tenant network utilization], [Attribution: which job drives which links; capacity and chargeback truth.],
  [NCCL timing and GPU idle time (DCGM)], [The business metric. Collective completion times and "GPU waiting on communication" percentage convert network counters into dollars.],
)

== Telemetry architecture

- *gNMI streaming telemetry* replaces SNMP polling: subscriptions push counters at 1--10 s cadence (watermarks even faster) into a pipeline (collector → time-series DB → dashboards/alerting — Prometheus/Grafana-style or vendor equivalents: Arista CloudVision/TerminAttr, Cisco MDT, SONiC's gNMI container). Your Splunk/Zabbix experience maps directly — the delta is cadence, cardinality, and *queue-level* rather than interface-level data.
- *On-ASIC burst tooling:* watermark histograms, mirror-on-drop / What-Just-Happened-style event streams (packet + drop reason + queue snapshot), sampled INT/postcards. This class of tooling is how you *see* a 50-microsecond incast that a 30-second counter never will.
- *Host-side pipeline:* node exporters for `ethtool`/`rdma stat` counters plus DCGM for GPU metrics, sharing a time base with fabric telemetry so counters and job phases align.
- *Synthetic probes:* scheduled `perftest`/`nccl-tests` canaries across representative paths and rails — the fabric's continuous "selftest," and the pre/post gate for changes (Chapter 9).

#keyidea[
  The unifying discipline is *correlation by time and topology*: every alert, counter, job
  event, and cable belongs to a shared topology model and a shared timeline. "Rank 213 slow at
  14:32" must join against "leaf-7 port 18 FEC burst at 14:31" in seconds, not via a human
  swivel-chairing between five dashboards. Building that join — SoT-backed topology plus
  time-aligned fabric/host/job telemetry — is one of the highest-leverage things a senior
  engineer delivers.
]

== Worked example: "Why is this job 17% slower?"

The methodology, as you would narrate it in an interview:

+ *Scope from the job inward.* Get job facts first: which ranks/hosts, which collective is slow (NCCL logs, framework profiler), when it started, gradual or step-change. NCCL debug or profiler output showing all-reduce time inflated on specific ranks turns "the network is slow" into a bounded search.
+ *Straggler or systemic?* Compare per-rank timings. One or a few slow ranks → host/link/rail hunt (go to 3). Uniformly slow → fabric-wide or config-change hunt (go to 5).
+ *Straggler path:* for the slow rank's host — `nvidia-smi topo`, PCIe `LnkSta`, thermals; NIC counters (`out_of_sequence`, pause, CNPs); `mlxlink` FEC per lane; the switchport's FEC/DOM/queue counters. Classic finding: FEC uncorrectable bursts on one rail link — every collective crossing it stalls, and the whole job inherits that tail.
+ *Reproduce below the application:* `ib_write_bw` / `all_reduce_perf` over the suspect path. If synthetic reproduces it, bisect by moving one endpoint until the bad hop/link is isolated. If it doesn't reproduce, it's workload-level (dataloader, checkpoint interference, noisy neighbor).
+ *Systemic path:* change correlation first — config pushes, firmware, NCCL/driver versions, *and job placement* (did the scheduler split this job across pods today?). Then fabric health deltas versus last week: ECN mark rates, pause totals, watermark peaks, ECMP imbalance (per-member link utilization spread), new elephant tenants sharing the class.
+ *Close the loop.* Whatever was found becomes a permanent detector: a counter alarm, a CI check, a placement rule. The fleet learns; the 17% never recurs silently.

== Failure analysis culture

- Blameless, evidence-driven postmortems, with *counter forensics* attached (the flap's FEC history, the pause trend before deadlock, the mark-rate change after tuning).
- Fleet thinking: one weird optic is a component; the same optic part number failing at 3x baseline across the fleet is a vendor engagement and a proactive replacement campaign.
- Cost fluency: translate findings into GPU-hours. "That marginal link cost roughly 400 idle GPU-hours a day" is the sentence that gets physical-layer budget approved.

#soundbite[
  "My monitoring philosophy changed from 'is the port up and how busy is it' to 'prove the job
  isn't network-stalled.' Concretely that means streaming queue watermarks, ECN mark rates,
  PFC pauses, and per-lane FEC into the same timeline as NCCL and GPU idle metrics, with a
  topology model to join them. Utilization averages are almost useless here — the events that
  cost money live at microsecond timescales and in the tails, so I instrument for bursts and
  stragglers, and I keep synthetic RDMA canaries running so the fabric tells me it degraded
  before a training team does."
]
