#import "lib.typ": *

= Facilities, DCI, and Where the Standards Are Going

== Power, cooling, and rack reality

AI network design is physically constrained in ways enterprise design never was. The network
engineer who ignores facilities gets designs that cannot be built:

- *Rack power density:* enterprise racks run 5--15 kW; air-cooled GPU racks 30--50 kW; liquid-cooled rack-scale systems (GB200/GB300 NVL72 class) roughly 120--140 kW *per rack*. Power, not space, is the scarce resource — "just add another switch/rack" is frequently a *megawatt* question, not a U-space question.
- *Liquid cooling changes layout:* direct-to-chip liquid loops, manifolds, and CDUs occupy space and dictate rack rows; network gear may remain air-cooled inside liquid-cooled rows, creating airflow islands that must be engineered. Rear-door heat exchangers, containment, and airflow direction (port-side intake vs exhaust switches — order the right airflow SKU!) are design inputs.
- *Optics thermals:* Chapter 6's kilowatt-per-switch of optics needs front-panel airflow; dense OSFP cages at the top of a hot rack run modules near thermal limits, raising BER. Thermal design is a *link reliability* input.
- *Cable physics at scale:* an 8-rail 1,024-GPU pod is thousands of cables. Copper DAC/AEC is thick and short-reach — it constrains switch placement (middle-of-rack/row designs to keep runs under limits); fiber needs bend-radius discipline, tray capacity planning, and labeled, SoT-matched runs. Cable weight and tray fill are genuine structural questions in dense builds.
- *Serviceability:* clearance to swap a 2 kg, hot, finned OSFP module or re-seat an MPO without disturbing neighbors; blast-radius-aware positioning of leaf switches; spare optics stocked *on site* because a missing spare is idle GPUs.

== DCI for AI: connecting clusters and regions

Multi-site AI infrastructure (DR for checkpoints, data gravity, multi-region training
experiments, or simply "the next building") brings service-provider skills back to the fore
— Cisco 8000, Juniper PTX, Arista R-series, Nokia-class platforms:

- *Coherent pluggable optics:* 400ZR/ZR+ (and 800ZR emerging) put coherent DWDM into router/switch ports — *IP-over-DWDM / routed optical networking* collapses the traditional transport layer for metro/regional reaches. Know the reach classes (ZR ~120 km amplified point-to-point; ZR+ higher power/longer reach over line systems).
- *Deep buffers at the boundary:* checkpoint replication and dataset transfer are massive elephant flows hitting bandwidth steps (from multi-Tb/s fabric onto n x 400G WAN). Deep-buffer routing silicon (Jericho-class VOQ platforms) at the DCI edge absorbs these transitions; this is one of the few places deep buffers are the right answer.
- *MACsec / encryption at line rate:* model weights and training data are crown-jewel IP; inter-site links run MACsec (or IPsec at lower rates) at 400G line rate — a hardware capability you must specify at purchase, not bolt on.
- *Traffic classes on the WAN:* checkpoint replication (bulk, deadline-driven), dataset ingest, storage replication, and control traffic get explicit bandwidth contracts; a checkpoint push must not starve interactive/control paths — classic SP traffic engineering (SR-TE, RSVP-TE heritage) applied to AI flows.
- *Failure isolation:* sites must fail independently: fiber-diverse paths, no shared line systems for redundant links, and — critically — *training jobs designed so a WAN event costs a checkpoint interval, not a cluster*. Cross-site *synchronous* training is generally impractical (speed of light: ~1 ms per 100 km one way; collectives at that RTT stall GPUs), so inter-site traffic is asynchronous: checkpoints, data, and hierarchical/async training schemes.

== Standards direction: Ultra Ethernet and the road ahead

Track the *Ultra Ethernet Consortium (UEC)* — the industry effort (AMD, Arista, Broadcom,
Cisco, Intel, Meta, Microsoft, HPE, and many more) to make Ethernet the definitive AI/HPC
fabric. *UEC Specification 1.0* (2025) spans NICs, switches, optics, and cables. The
technical headlines a candidate should know:

- *UET (Ultra Ethernet Transport):* a modern RDMA transport replacing RoCE's IB-heritage semantics — designed for *packet spraying* (out-of-order delivery is normal; NIC places data directly), *selective retransmission* (no go-back-N), and fast *ephemeral connection setup* (no heavyweight QP handshake per peer) for jobs with massive fan-out.
- *Congestion management:* sender-based and receiver-credit-based schemes designed to run *without requiring PFC-lossless fabrics* — loss-tolerant by design, plus richer congestion signaling (beyond one ECN bit) and programmable congestion control.
- *Link-layer options:* LLR (link-level retry) and credit-based flow control on Ethernet links, in-network collectives (INC) — notice these are Ethernet adopting InfiniBand's best ideas while keeping the Ethernet ecosystem.
- *Why it matters to you:* the PFC/ECN/DCQCN engineering in Chapter 3 is the *current* generation. The direction of travel is fabrics that spray packets, tolerate loss, and self-manage congestion — vendor implementations (NVIDIA Spectrum-X adaptive routing + DDP, Broadcom's AI fabric features) are already partway there. A senior hire is expected to run today's fabrics *and* have a view on this transition.

#soundbite[
  "For multi-site AI my starting position is: synchronous training doesn't cross the WAN —
  physics says so — therefore DCI is engineered for asynchronous elephants: checkpoint and
  dataset replication over 400ZR+ routed-optical links, deep-buffer VOQ platforms at the
  bandwidth step-down, MACsec everywhere because model weights are the company's crown
  jewels, and traffic contracts so a checkpoint push can't starve control planes. And I'm
  tracking UEC closely — packet spraying with selective retransmit essentially retires the
  go-back-N problem that makes today's lossless engineering so delicate."
]
