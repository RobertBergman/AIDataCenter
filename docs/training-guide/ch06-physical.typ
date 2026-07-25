#import "lib.typ": *

= The 400G/800G Physical Layer: Where Performance Problems Are Born

At 800G, the physical plant stops being a link-up/link-down concern and becomes a
*performance* concern. Marginal links do not go down — they correct errors, add latency,
drop the occasional frame, and quietly turn into stragglers. A senior AI network engineer is
expected to be genuinely good at layer 1.

== Form factors and cabling options

- *OSFP* — the dominant 800G form factor in AI fabrics (NVIDIA ecosystem especially). Larger, better thermals (often integrated heatsink fins, or "riding heatsink" variants); OSFP-RHS fits NIC cages.
- *QSFP-DD / QSFP-DD800* — backward-compatible with QSFP heritage; dominant in many Ethernet switch lines. You will encounter both ecosystems; port-cage-to-module compatibility is a real procurement and sparing issue.
- 800G today is *8 lanes of 100G PAM4* (or 4 x 200G emerging). PAM4 signaling (4 amplitude levels, 2 bits per symbol) is inherently noisier than NRZ — which is why FEC is mandatory (below).

Interconnect ladder, by reach and cost:

#table(
  columns: (0.9fr, 1.6fr, 1.5fr),
  table.header([*Type*], [*What it is*], [*Where it fits*]),
  [DAC], [Passive copper twinax], [Cheapest, zero power, ~1--2.5 m at 800G — in-rack only, thick and stiff (bend radius, airflow)],
  [ACC/AEC], [Active copper (redriven/retimed)], [Extends copper to ~3--7 m; AECs popular for in-row GPU-server-to-leaf],
  [AOC], [Active optical cable, fixed ends], [Tens of meters, lighter than copper; failure means replacing the whole assembly],
  [Transceivers + fiber], [Pluggable optics over structured fiber (DR8/2xDR4 on parallel SMF via MPO, FR4/2xFR4 on duplex, VR/SR multimode short reach)], [Row-to-row and fabric tiers; MPO-12/MPO-16 APC connectors, polarity management, insertion-loss budgets],
  [LPO], [Linear pluggable optics — no DSP in module, host SerDes does equalization], [Emerging: big power/latency savings per port, tighter host-module interop requirements],
  [CPO], [Co-packaged optics — optical engines beside the switch ASIC], [The roadmap answer to optics power at 1.6T+; operational model still maturing],
)

#gotcha[
  Optics dominate fabric power and a surprising share of failures. An 800G module burns
  roughly 13--18 W; 64 of them is over a kilowatt *per switch* just for optics — with direct
  thermal consequences: optics running hot see rising bit-error rates and shortened life.
  Fleet experience consistently ranks optics/cabling among the top causes of link and job
  incidents. Treat optics as a managed fleet: inventory by part/firmware, DOM telemetry
  trended, thermal alarming, spares on site.
]

== FEC and BER: reading link health like a pro

At PAM4 rates the raw channel is *designed* to have errors: pre-FEC BER around 1e-5 to 1e-6
is normal and *RS-544 FEC (Reed-Solomon "KP4")* corrects it to a post-FEC target better than
~1e-15. This changes how you assess link health:

- *Pre-FEC (raw) BER / FEC corrected codewords* — your early-warning signal. A link whose corrected-error rate trends upward (temperature, aging laser, contaminated connector) is degrading *long before* anything drops.
- *Uncorrectable codewords* — actual frame loss. On an RDMA fabric each one can trigger go-back-N retransmission; even rates that round to zero percent loss create measurable job impact. Alarm on any sustained non-zero rate.
- *FEC symbol-error distribution / histograms* — bursts concentrated on one lane point to a specific fiber strand, connector, or SerDes lane rather than general degradation.
- *Per-lane view* — 800G is 8 lanes; a single bad lane (dirty MPO fiber position, marginal laser) shows as errors concentrated on one lane. Tools: `mlxlink` on NICs, vendor `show interfaces ... phy`/`transceiver` detail, `ethtool --show-fec` / `ethtool -S`.

FEC also buys its correction with *latency* (~100 ns class) and with a cliff-edge failure
mode: links look perfect until error rates exceed correction capacity, then degrade sharply.

== DOM telemetry, link training, and flap forensics

- *DOM/DDM (digital optical monitoring):* every module reports temperature, supply voltage, TX bias, TX power, and RX power per lane. Baseline at turn-up; trend continuously; alarm on drift (falling RX power = dirty/kinked fiber or dying far-end laser; rising temperature = airflow or seating problem).
- *Link training and autoneg:* at 400/800G, bring-up is a multi-second negotiation of equalizer settings per lane between SerDes, module DSPs, and the far end. Links that train slowly, or only after a specific power-cycle order, or negotiate down, indicate marginal channels *now* and flaps *later*. Firmware compatibility between NIC, module, and switch matters — matrix-test and pin versions.
- *Flap forensics:* a link flap on an AI fabric is a job-level event (NCCL communicator errors, job restart from checkpoint). For each flap collect: which end initiated (local fault vs remote fault), FEC/BER history before the event, DOM history, and correlation across links sharing a conduit, panel, or switch — one flapping optic is a component; twelve flapping ports on one panel is a physical-plant or power event.

== Breakouts, polarity, and the cabling discipline

- *Breakout rules:* an 800G switch port often runs as 2 x 400G or 4 x 200G/8 x 100G toward hosts. ASICs group ports; using one breakout member can constrain its siblings' speeds, and breakout choice interacts with FEC mode and autoneg. Know your platform's port-group rules before design, not after cabling.
- *MPO/MTP hygiene:* multi-fiber push-on connectors are the workhorse — and the top contamination point. Polarity schemes (A/B/C), APC vs UPC, insertion-loss budgets across patch panels, and *inspect-and-clean before every mate* are non-negotiable disciplines. A single dusty MPO position = one bad lane = FEC bursts = straggler rail.
- *Rail cabling maps:* in a rail-optimized fabric the cable plan encodes the logical design (Chapter 5). The cabling documentation, LLDP-verified against the source of truth, is a first-class deliverable of fabric build — and re-verified after every physical intervention.

#soundbite[
  "At 800G I treat FEC counters the way I used to treat interface CRC errors — except the
  interesting signal is *pre-failure*: corrected-codeword trends, per-lane error skew, and DOM
  drift tell me which optic will hurt a job next week. On an RDMA fabric a link doesn't have
  to go down to cost money; a marginal optic that's 'up' is a straggler generator. So my
  physical-layer posture is: baseline everything at turn-up, trend DOM and FEC continuously,
  and replace on trend, not on failure."
]
