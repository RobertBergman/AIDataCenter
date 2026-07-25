#import "lib.typ": *

= Lossless Ethernet: PFC, ECN, DCQCN, and Buffer Engineering

This is the single most important new skill area for an engineer coming from enterprise
switching. Everything here exists to solve one problem: *RoCE transport punishes loss
brutally, and Ethernet drops by default.* The solution is a two-layer system — ECN-based
congestion control as the primary mechanism, PFC as the last-resort safety net — plus careful
buffer and QoS engineering to make both behave.

== PFC: Priority Flow Control (IEEE 802.1Qbb)

PFC is per-priority pause. When a switch ingress queue for a given priority crosses its
*XOFF threshold*, the switch sends a PFC pause frame upstream naming that priority; the
upstream device stops transmitting *that priority only* until an XON resumes it. Done
correctly, frames wait in upstream buffers instead of being dropped.

The mechanics you must be able to whiteboard:

- PFC operates *per traffic class* on a link — pausing the RoCE class must not touch management, storage, or CNP traffic. This is why DSCP-to-TC mapping (below) must be consistent fabric-wide.
- *Headroom buffer.* After sending XOFF, in-flight bytes keep arriving for one round trip (cable propagation both ways + peer response time + MTU-sized frames already serializing). The ingress must reserve *headroom* per port per priority to absorb them. Headroom scales with link speed and *cable length* — a 100 m AOC needs materially more headroom than a 2 m DAC. Getting headroom wrong means drops *despite* PFC being "on."
- Thresholds are typically dynamic (a fraction "alpha" of remaining shared buffer) rather than static, so a busy switch tightens pause behavior as the shared pool depletes.

=== Why PFC is a safety net, not a control system

PFC is *blunt*: it stops everything in the class at the previous hop, punishing every flow
that shares the priority, not just the one causing congestion.

- *Head-of-line blocking.* One congested egress can pause an ingress that also feeds uncongested egresses — innocent flows stall.
- *Pause propagation / pause storms.* The paused upstream switch's buffers fill, so *it* pauses *its* upstreams. Congestion propagates backward hop by hop, and a single misbehaving endpoint (a slow NIC, a broken receiver that stops draining) can cascade pauses across a large region of the fabric. A malfunctioning NIC that emits continuous pause frames can measurably degrade an entire pod.
- *PFC deadlock.* If buffer dependencies form a cycle (possible with certain routing/failure combinations in Clos fabrics), every switch in the cycle waits for the next to release credit — permanent standstill until something breaks the cycle. Mitigations: keep RoCE traffic on strictly up-down (valley-free) paths, and enable the *PFC watchdog* — which detects a queue paused beyond a threshold (typically hundreds of milliseconds) and force-drains or ignores pause to break the deadlock, trading a burst of loss for fabric liveness.

#gotcha[
  The classic operational trap: PFC counters look "normal" because pauses are being sent and
  honored — but job performance is terrible. Pause frames are not a sign of health; they are a
  sign ECN failed to keep queues short. A well-tuned fabric shows *ECN marks routinely, PFC
  pauses rarely*. Rising sustained PFC pause counters are an alarm, not background noise.
]

== ECN and DCQCN: the actual congestion control

*ECN (Explicit Congestion Notification)* uses two bits in the IP header. Fabric switches are
configured with WRED/ECN thresholds per queue: as queue depth crosses the minimum threshold,
the switch begins *marking* packets (CE — Congestion Experienced) with rising probability
instead of dropping them.

*DCQCN (Data Center Quantized Congestion Notification)* is the end-to-end control loop built
on those marks — the de facto congestion control for RoCEv2, implemented in NIC hardware:

+ *CP (Congestion Point)* — the switch marks CE on packets as its queue grows.
+ *NP (Notification Point)* — the *receiving NIC* sees CE-marked RoCE packets and sends a *CNP (Congestion Notification Packet)* back to the sender for that flow.
+ *RP (Reaction Point)* — the *sending NIC* receives the CNP and cuts that QP's transmit rate sharply, then recovers with additive increase plus fast-recovery stages, governed by an internal "alpha" congestion estimate that decays when CNPs stop arriving.

Design and tuning points that distinguish a senior candidate:

- *CNPs must travel in a protected high-priority class.* If congestion feedback itself gets stuck behind the congestion it reports, the loop fails. Standard practice: RoCE data in one class (commonly DSCP 26, queue 3), CNPs in a strict-priority class (commonly DSCP 48, queue 6).
- *ECN thresholds (Kmin/Kmax/Pmax) tune the trade-off.* Mark too early: NICs throttle prematurely and you leave bandwidth idle. Mark too late: queues grow, latency rises, and PFC starts firing. Vendor AI deployment guides (Arista/Broadcom, NVIDIA, Cisco) publish per-ASIC starting values; fleets then tune from telemetry.
- *ECN before PFC — always.* The whole design intent is that ECN thresholds sit *below* PFC XOFF thresholds so the rate-control loop resolves congestion before pause is ever needed. If you observe pauses before meaningful mark rates, your thresholds are inverted or misconfigured.
- Timescale intuition: DCQCN reacts at network RTT timescales (microseconds); PFC reacts at link RTT (sub-microsecond); buffers absorb what both miss.

== DSCP-to-traffic-class mapping

Lossless behavior only works if classification is consistent on *every* port of *every*
switch and NIC in the fabric. A representative RoCE QoS plan:

#table(
  columns: (1.2fr, 0.8fr, 1fr, 1.6fr),
  table.header([*Traffic*], [*DSCP*], [*Queue/TC*], [*Treatment*]),
  [RoCE data (GPU-to-GPU)], [26], [3], [Lossless: PFC enabled, ECN marking, guaranteed bandwidth (e.g., WRR ~50%+)],
  [CNP (congestion feedback)], [48], [6], [Strict priority, no PFC, never delayed],
  [Management / underlay control (BGP, gNMI)], [48/56], [7], [Strict or protected queue],
  [Storage / checkpoint traffic], [varies], [dedicated], [Often lossy-but-weighted, or its own lossless class — design decision],
  [Everything else], [0], [0], [Best effort],
)

#gotcha[
  A single switch port with a missing or mismatched DSCP-to-TC map silently declassifies RoCE
  into the best-effort queue on that hop — no PFC, no ECN. Result: intermittent drops under
  load, RDMA retransmits, and a "17% slower job" with every port nominally up. Fabric-wide QoS
  config validation belongs in your CI pipeline (Chapter 9), not in a human's memory.
]

== Buffer architecture and microbursts

Understanding your ASIC's buffer model is what separates configuring QoS from *engineering*
it:

- Datacenter switch ASICs (e.g., Broadcom Tomahawk class, NVIDIA Spectrum) have tens of MB of *shared* on-chip buffer, partitioned into reserved per-port/per-class minimums, a shared dynamic pool governed by alpha values, and PFC headroom. Deep-buffer ASICs (Broadcom Jericho class, multi-GB external HBM/packet memory) appear mainly at DCI and storage boundaries, not usually inside the GPU fabric.
- *Microbursts* are the defining stress: collectives make hundreds of NICs transmit line-rate bursts *simultaneously* (Chapter 4), and multiple 400G/800G flows can converge on one egress for microseconds. Average utilization graphs at 30-second polling show 40% while queues overflow at microsecond timescales. This is why watermark counters, high-frequency telemetry, and burst-aware monitoring matter (Chapter 8).
- *Incast* is the pathological pattern: N senders, one receiver (common in reduce and checkpoint phases). Buffer occupancy spikes at N times the per-sender burst; ECN/DCQCN plus sane collective algorithms keep it survivable.

== Putting it together: the lossless design conversation

A hiring manager asking "how would you design the RoCE fabric" wants to hear a layered
answer:

+ Consistent DSCP/TC classification and trust settings fabric-wide, from NIC to every switch hop.
+ ECN/WRED thresholds set per vendor AI guidance for the ASIC, positioned to act *before* PFC.
+ PFC enabled on the RoCE class only, with correctly sized per-cable-length headroom, watchdog enabled, and pause counters alarmed.
+ CNPs in a strict-priority class.
+ Adaptive/dynamic load balancing or packet spraying to prevent ECMP hot links (Chapter 5).
+ Continuous telemetry on marks, pauses, watermarks, and drops, validated by synthetic RDMA tests in CI.

#soundbite[
  "I think of lossless Ethernet as a control system with a safety valve. DCQCN — switch ECN
  marking driving NIC rate control via CNPs — is the control system that keeps queues short.
  PFC is the safety valve for the microbursts the control loop can't catch in time. If I see
  PFC firing regularly, I don't celebrate that it prevented drops — I go tune why ECN didn't
  keep us out of the pause regime. And I always keep the failure modes in mind: pause storms,
  head-of-line blocking, and PFC deadlock, which is why the watchdog and valley-free routing
  are non-negotiable."
]
