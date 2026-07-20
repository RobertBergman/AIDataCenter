// GENERATED from docs/build-guide.md — do not edit. Regenerate: python3 docs/md2pdf.py
#import "../docs/template.typ": *
#show: doc.with(title: "Build Guide — Real Hardware Implementation", kicker: "AIDATACENTER — BUILD GUIDE", rev: "0.2 · 2026-07-19")

Physical build of the 64× B200 inference cluster: site prep → rack &
stack → power → cabling → switch bring-up → server bring-up → burn-in →
handoff to software bootstrap.

Companion to #link("../SPEC.pdf")[SPEC.md] (design),
#link("cabling.pdf")[docs/cabling.md] (cable tables),
#link("netbox.pdf")[docs/netbox.md] (SoT),
#link("bootstrap.pdf")[docs/bootstrap.md] (software bring-up ---
#strong[starts where this guide ends]).

#quote(block: true)[
#strong[SoT rule:] racks, devices, RU positions, IPs, and cables are
authoritative in #strong[NetBox] (`bootstrap/netbox/seed/site.yaml`
pre-go-live). If this guide and NetBox disagree, fix NetBox, then
re-export.
]

#horizontalrule

= Scope
<scope>
#figure(
  align(center)[#table(
    columns: (40%, 60%),
    align: (auto,auto,),
    table.header([In scope], [Out of scope],),
    table.hline(),
    [Site readiness (power/cooling/floor)], [DC construction design →
    `docs/facility.md`],
    [BOM summary & receiving], [Full SKUs/pricing → `docs/bom.md`],
    [Racking, power, cabling (169 cables)], [RoCE/EVPN/QoS tuning →
    `docs/network.md`],
    [Switch baseline config + ZTP], [K8s / Metal3 / Flux bring-up →
    `docs/bootstrap.md`],
    [Server firmware + rail/NIC verification], [Model serving / storage
    tuning],
    [Hardware burn-in + acceptance], [Day-2 ops → `docs/k8s.md`],
  )]
  , kind: table
  )

#strong[Baseline footprint:] 4 racks --- GPU-1, GPU-2, BOOT, STOR (SPEC
§2A).

#horizontalrule

= Safety
<safety>
#figure(
  align(center)[#table(
    columns: (46.15%, 53.85%),
    align: (auto,auto,),
    table.header([Hazard], [Control],),
    table.hline(),
    [GPU server mass (8-GPU nodes are multi-person lifts)], [Mechanical
    lift for anything \> 40 kg; never solo-rack a B200 node],
    [High-amperage 415 VAC A/B feeds], [Licensed electrician for
    whips/PDUs; lockout-tagout during install],
    [Laser (400G optics, AOC)], [Dust caps on every unused optic; no
    eye-level inspection of live fibers],
    [ESD], [Wrist straps for all NIC/DIMM/GPU-adjacent work],
    [Hot aisle (43--46 kW/rack)], [No sustained work in contained hot
    aisle; hydrate, rotate staff],
    [Airflow direction], [Verify F-R vs R-F SKU per device
    #strong[before] racking (leaves/spines/OOB ordered to match row)],
  )]
  , kind: table
  )

#horizontalrule

= Site readiness checklist
<site-readiness-checklist>
Complete #strong[before] delivery day.

== Power (SPEC §9)
<power-spec-9>
#figure(
  align(center)[#table(
    columns: (19.05%, 52.38%, 28.57%),
    align: (auto,auto,auto,),
    table.header([Item], [Requirement], [Verify],),
    table.hline(),
    [Facility capacity], [#strong[130--150 kW] available (IT baseline
    \~100--115 kW + growth)], [Utility/UPS schedule],
    [GPU racks], [High-density #strong[415 VAC, A/B], \~50 kW/rack
    class], [Per-rack whip rating],
    [BOOT + STOR], [Standard enterprise density, A/B], [---],
    [Redundancy], [A/B to #strong[every] rack; rPDUs
    dual-corded], [A-side loss test planned],
    [rPDUs], [Metered/switched, C19/C13 mix per server PSU
    class], [Ports ≥ device cords],
  )]
  , kind: table
  )

== Cooling (SPEC §10)
<cooling-spec-10>
#figure(
  align(center)[#table(
    columns: (26.67%, 73.33%),
    align: (auto,auto,),
    table.header([Tier], [Requirement],),
    table.hline(),
    [Minimum], [Hot-aisle containment + high-airflow CRAC sized for 2×
    \~46 kW GPU racks],
    [Preferred], [Rear-door heat exchangers on GPU-1/GPU-2],
    [Future], [Layout must not block DLC retrofit (manifold path, CDU
    space)],
  )]
  , kind: table
  )

== Floor & logistics
<floor-logistics>
- ☐ Floor loading rated for 4 fully populated racks (GPU racks are the
  heavy ones)
- ☐ Delivery path: dock → freight elevator → row, door/turn clearances
  for crated 8-GPU servers
- ☐ Staging area near row for unboxing + MAC/serial capture
- ☐ Cage/rack space: 4 adjacent rack positions, GPU racks in the high-kW
  zone (SPEC §2A.4)

== Pre-staged data
<pre-staged-data>
- ☐ `bootstrap/netbox/seed/site.yaml` imported to design NetBox (or
  offline export run)
- ☐ `docs/cabling.md` + `docs/cabling.csv` exported and printed
- ☐ Cable labels printed #strong[both ends] (`R{rail}-W{nn}`,
  `L{rail}S{spine}-U{n}`, `OOB-{device}`)
- ☐ Operator workstation: `kubectl`, `clusterctl`, `flux`, `yq`, `jq`,
  serial console, Redfish tooling
- ☐ EOS images + Ubuntu 24.04 cloud image + Ironic IPA assets downloaded
  (see `docs/bootstrap.md` §5.1)
- ☐ BMC credentials decided (env-injected later; #strong[never]
  committed)

#horizontalrule

= Bill of materials (summary)
<bill-of-materials-summary>
Indicative quantities --- exact SKUs in `docs/bom.md`.

#figure(
  align(center)[#table(
    columns: (33.33%, 25%, 41.67%),
    align: (auto,right,auto,),
    table.header([Item], [Qty], [Notes],),
    table.hline(),
    [Dell PowerEdge XE9680 (HGX B200, 8× GPU)], [#strong[8]], [8× 400G
    NIC (ConnectX-7 / BF3), 2× Xeon Scalable, 2 TB RAM, 8× 3.84 TB NVMe,
    6U],
    [Rail leaf --- DCS-7060DX5-32], [#strong[8]], [One per rail; match
    airflow to rack],
    [Spine --- DCS-7060DX5-64S], [#strong[2]], [BOOT rack],
    [OOB --- DCS-7010TX-48], [#strong[2]], [One per GPU rack],
    [Mgmt server 1U (cp01--03)], [3], [32c / 256 GB / NVMe],
    [Mgmt/utility 1U (seed01, util01--03)], [4], [seed may be repurposed
    util-class],
    [Storage nodes / appliance], [per `docs/storage.md`], [Hot FS
    150--300 TB + archive ≥ 750 TB usable],
    [Racks 42--48U + rPDUs], [4], [GPU racks high-density rated],
    [DAC QSFP-DD 400G 3m], [64 + 20% spares], [Host ↔ leaf],
    [AOC QSFP-DD 400G 15m], [64 + 20% spares], [Leaf ↔ spine],
    [Cat6 5m], [14 + spares], [BMC ↔ OOB],
    [Console server / KVM], [1--2], [BOOT rack],
    [Optics spares], [≥ 20% of each type (SPEC §5.8)], [],
  )]
  , kind: table
  )

#horizontalrule

= Phase 1 --- Receive, stage, record
<phase-1-receive-stage-record>
+ #strong[Inspect on dock:] shock/tilt indicators on every crate;
  photograph damage before opening.
+ #strong[Unbox in staging; capture identity into NetBox] for every
  device:
  - Serial number, asset tag
  - #strong[BMC MAC] and #strong[mgmt0 MAC] (workers: also note rail NIC
    card positions)
  - Update `mac_mgmt`/BMC MACs in `seed/site.yaml` → re-run
    `netbox-sync.sh --offline` (design seed is pre-go-live SoT; see
    `docs/netbox.md`)
+ #strong[Firmware audit at staging] (faster than in-rack): record
  shipped BIOS/BMC/NIC/GPU firmware per node; flag deltas against
  baseline (§9.2).
+ #strong[Label every cable both ends] from the printed sheets before
  anyone touches a rack.

#strong[Exit:] NetBox devices = physical serials/MACs; labels printed;
staging inventory signed off.

#horizontalrule

= Phase 2 --- Rack & stack
<phase-2-rack-stack>
RU positions below match `seed/site.yaml` (NetBox is authoritative).
General rules: heaviest low, rail leaves at top near host NICs (short
DAC runs), OOB at rack top, patch/fiber management adjacent to leaves.

== GPU-1 / GPU-2 (identical layout)
<gpu-1-gpu-2-identical-layout>
#figure(
  align(center)[#table(
    columns: (15.38%, 46.15%, 38.46%),
    align: (auto,auto,auto,),
    table.header([RU], [Device], [Notes],),
    table.hline(),
    [48], [oob-sw1 (GPU-1) / oob-sw2 (GPU-2)], [7010TX-48],
    [42--39], [leaf-rail0--3 (GPU-1) / leaf-rail4--7
    (GPU-2)], [7060DX5-32, rail index = NetBox `rail_index`],
    [30, 24, 18, 12], [worker01--04 (GPU-1) / worker05--08
    (GPU-2)], [XE9680, 6U each; mechanical lift],
    [lower], [rPDU A/B], [Dual-cord every device],
  )]
  , kind: table
  )

- Verify #strong[airflow direction] matches row containment before
  bolting switches.
- Leave NIC-side clearance for 8× DAC per server; route via fiber
  managers, no kinks (DAC min bend radius).

== BOOT
<boot>
#figure(
  align(center)[#table(
    columns: 2,
    align: (auto,auto,),
    table.header([RU], [Device],),
    table.hline(),
    [40], [seed01],
    [36--34], [cp01--cp03],
    [30--28], [util01--util03],
    [20, 18], [spine1, spine2 (7060DX5-64S)],
    [+], [console server / KVM, patch panel],
  )]
  , kind: table
  )

== STOR
<stor>
Per `docs/storage.md` --- hot FS nodes low, archive nodes/shelves above,
storage BMCs → oob-sw2.

#strong[Exit:] all devices racked, torqued, airflow-checked; RU photos
taken; NetBox rack elevations confirmed.

#horizontalrule

= Phase 3 --- Power
<phase-3-power>
+ rPDUs on A/B feeds; #strong[meter before load] (phase balance).
+ Power sequencing: #strong[switches first, servers last] --- OOB →
  spines/leaves → storage → cp/util → GPU workers (one rack at a time).
+ GPU rack sanity: power #strong[one] worker, watch rPDU draw through
  POST (\~1--2 kW), then enable the rest. Full rack ≈ 43--46 kW under
  load later; validate cooling with all 4 nodes at burn-in, not
  production.
+ Confirm PSU redundancy: pull A-side per rack (planned window) --- no
  device drops.

#strong[Exit:] all nodes/switches powered; rPDU meters green on both
feeds; A/B failover proven.

#horizontalrule

= Phase 4 --- Cabling (169 cables)
<phase-4-cabling-169-cables>
Cable #strong[in this order] --- each class enables the next. Tables and
labels: #link("cabling.pdf")[docs/cabling.md] / `docs/cabling.csv`.

== OOB + mgmt --- 39× Cat6 + 2× DAC 25G (first!)
<oob-mgmt-39-cat6-2-dac-25g-first>
Per `cabling.md` §5, in order: #strong[14× BMC] (VLAN 20), #strong[15×
server mgmt0] (VLAN 10, OS/PXE), #strong[10× switch Ma1] (VLAN 20, ZTP),
#strong[2× OOB MLAG peer] (`Ethernet49–50`). OOB gives Redfish + ZTP
reachability for everything after.

== Leaf ↔ spine --- 64× AOC 400G
<leaf-spine-64-aoc-400g>
Per leaf: `Ethernet17–24` → 4× spine1 + 4× spine2, ports per
`cabling.md` §4 (`L{rail}S{spine}-U{n}`). Dress AOC with slack spools;
these are 15 m runs to BOOT.

== Host ↔ rail leaf --- 64× DAC 400G
<host-rail-leaf-64-dac-400g>
The rail identity is the whole design (SPEC §5.0): #strong[GPU-#emph[i]
NIC of every worker → leaf-rail\_i\_ `Ethernet{worker_index}`]
(`R{rail}-W{nn}`). Rail leaves sit in the same/near rack → 3 m DAC.

#figure(
  align(center)[#table(
    columns: (44.44%, 55.56%),
    align: (auto,auto,),
    table.header([Rule], [Check],),
    table.hline(),
    [GPU0/NIC0 → leaf-rail0 … GPU7/NIC7 → leaf-rail7], [Label audit per
    cable],
    [worker0N → leaf `EthernetN` on #strong[all 8 leaves]], [Port map,
    not just link light],
    [No host rail on the wrong leaf], [Audit by label #strong[and] LLDP
    (§10.4)],
  )]
  , kind: table
  )

== Post-cable audit
<post-cable-audit>
- ☐ All 169 labels scanned into NetBox; cable status → `connected`
- ☐ No DAC/AOC exceeding bend radius; no copper crossing power bundles
- ☐ Spares (20%) coiled, labeled, stored on-site

#strong[Exit:] NetBox cable status `connected` = physical; photos per
rack.

#horizontalrule

= Phase 5 --- Switch bring-up
<phase-5-switch-bring-up>
All 12 switches provision via #strong[Arista ZTP from seed01] --- full
design, rendered configs, and runbooks:
#link("network.pdf")[docs/network.md]. Nothing is hand-configured except
seed01 and emergency console access.

== OOB switches (oob-sw1/2) --- zero-day bench ZTP
<oob-switches-oob-sw12-zero-day-bench-ztp>
Per `docs/network.md` §3.2:

+ seed01 up on the bench (`00-seed-host.sh` done: dnsmasq + nginx +
  `/var/www/html/ztp/`).
+ Serials of both 7010TXs into `bootstrap/seed/ztp/serialmap.yaml` →
  `render.py` → configs staged.
+ Patch seed01 `eth0` → oob-sw1 front port; power on → ZTP pulls config
  by serial → reloads.
+ Repeat for oob-sw2. Rack both; cable access ports + MLAG peer
  (`Ethernet49–50`).
+ Fallback: console server + paste the same rendered config
  (`network.md` §3.2 step 6).

- Dual uplink both 7010TXs = MLAG pair, VARP gateways 10.10.0.1 /
  10.20.0.1; #strong[no lossless QoS on OOB].
- Verify: `show mlag` active/live; `show lldp neighbors` sees every BMC
  (14) + mgmt0 (15) + Ma1 (10).

== Spines + rail leaves --- ZTP via OOB relay
<spines-rail-leaves-ztp-via-oob-relay>
Per `docs/network.md` §3.3: Ma1 → OOB VLAN 20 → relay → dnsmasq
reservation (Ma1 MAC) → option 67 → `ztp.py` → per-serial config →
reload. Spines first (convention), then all 8 leaves; BGP establishes as
pairs complete.

+ Confirm reservations staged:
  `grep ztp bootstrap/seed/generated/dhcp-hosts.conf` = 10 lines.
+ Power spine1, spine2 → wait for `show zerotouch` = disabled →
  `show bgp summary` idle until leaves appear.
+ Power leaf-rail0--7 → ZTP; each leaf: 8 uplinks `up/up`, sessions
  `Established` to both spines.
+ Underlay + RoCEv2 AI profile arrive #strong[in the rendered config]
  (PFC, ECN, watchdog, MTU 9216, eBGP) --- do not improvise here; tuning
  deltas go through `docs/network.md` + `render.py`.

== Switch verification gates
<switch-verification-gates>
#figure(
  align(center)[#table(
    columns: (19.05%, 61.9%, 19.05%),
    align: (auto,auto,auto,),
    table.header([Gate], [Command (EOS)], [Pass],),
    table.hline(),
    [ZTP], [`show zerotouch`], [disabled on all 12; serial ↔ config
    match],
    [OOB MLAG], [`show mlag` / VARP], [active/live; `.1` answers both
    VLANs],
    [Links], [`show interfaces status`], [8 down + 8 up per leaf
    `connected`],
    [Optics], [`show interfaces transceiver`], [DOM in range, no flaps],
    [Fabric], [`show bgp summary`], [All peers Established],
    [Errors], [`show interfaces counters errors`], [0 CRC/FCS after 30
    min],
    [OOB], [`ping` every BMC from oob-sw], [14/14],
  )]
  , kind: table
  )

#strong[Exit:] 12/12 switches ZTP'd to target EOS, fabric up, zero-error
soak 30 min.

#horizontalrule

= Phase 6 --- Server bring-up (via OOB/Redfish)
<phase-6-server-bring-up-via-oobredfish>
Do this #strong[before] Metal3 touches anything --- it derisks the CAPI
run.

== BMC baseline (all 15 servers)
<bmc-baseline-all-15-servers>
- ☐ BMC reachable via OOB (`https://10.20.0.x` / Redfish)
- ☐ Set BMC admin credentials (from secrets, env-injected --- matches
  `BMC_USERNAME/BMC_PASSWORD` plan)
- ☐ NTP = `10.10.0.10`\; syslog → ops; Redfish enabled; default
  passwords dead
- ☐ Boot mode UEFI, PXE first on #strong[mgmt0] (10.10.x),
  virt/SR-IOV/ACS settings per GPU server vendor baseline

== Firmware baseline
<firmware-baseline>
- ☐ BIOS + BMC at pinned versions (record in NetBox or build sheet)
- ☐ #strong[NIC firmware] (ConnectX-7 / BF3) at target; RoCE enabled
- ☐ GPU firmware/VBIOS per NVIDIA baseline for the B200 platform
- ☐ NVMe firmware per vendor advisory

== Per-worker hardware inventory (POST / BMC SEL)
<per-worker-hardware-inventory-post-bmc-sel>
- ☐ 8× B200 visible; NVLink fabric present
- ☐ 8× 400G NICs present, #strong[PCIe locality matches GPU pairing]
  (NIC\_i next to GPU\_i)
- ☐ 2 TB RAM, 8× 3.84 TB NVMe, 2× boot NVMe RAID1
- ☐ BMC SEL clean (no correctable storms)

== Rail verification (critical)
<rail-verification-critical>
For each worker, each NIC\_i must link to `leaf-rail{i}`
`Ethernet{worker_index}`:

```bash
# per leaf — LLDP neighbor on EthernetN must be the right worker's right NIC
leaf-rail3# show lldp neighbors Ethernet4 detail   # expect worker04 rail3 NIC
```

- ☐ 64/64 host links land on the labeled rail leaf+port (LLDP audit vs
  `cabling.csv`)
- ☐ All 64 links `connected` 400G full, FEC counters incrementing
  cleanly

#strong[Exit:] every server Redfish-manageable, firmware pinned, 64
rails verified by LLDP.

#horizontalrule

= Phase 7 --- Burn-in & validation
<phase-7-burn-in-validation>
#figure(
  align(center)[#table(
    columns: (19.05%, 19.05%, 61.9%),
    align: (auto,auto,auto,),
    table.header([Test], [Tool], [Target / pass],),
    table.hline(),
    [GPU health], [`dcgmi diag -r 3` (post-OS, or vendor burn
    image)], [No failures, all 64 GPUs],
    [NVLink], [`dcgmi nvlink` / vendor tool], [All links up, no errors],
    [GPU thermal/power], [30--60 min GPU burn (all 8/node)], [No
    throttle below spec; rack ΔT within cooling plan],
    [Per-rail network], [`perftest` (`ib_write_bw`) server-pair per
    rail], [\~400G line rate per rail, 0 retransmits of concern],
    [Fabric soak], [All rails loaded 2 h], [ECN marks bounded,
    #strong[zero] PFC storm / watchdog events],
    [Storage attach], [fio against hot FS from a worker], [≥ 10--20 GB/s
    single-node (SPEC §6.4)],
    [OOB soak], [Continuous BMC polls 24 h], [No flaps],
  )]
  , kind: table
  )

Capture all results into the build record (attach to NetBox or ops
wiki).

#horizontalrule

= Phase 8 --- Handoff to software bootstrap
<phase-8-handoff-to-software-bootstrap>
Hardware is done when the
#link("bootstrap.pdf")[bootstrap acceptance criteria] can run. Hand off
with:

#figure(
  align(center)[#table(
    columns: (61.54%, 38.46%),
    align: (auto,auto,),
    table.header([Artifact], [Where],),
    table.hline(),
    [NetBox = physical reality (serials, MACs, cables
    `connected`)], [`netbox-sync.sh` export],
    [Firmware/BIOS baseline record], [Build sheet],
    [Rail/LLDP audit output], [Build sheet],
    [BMC creds in secrets store (env path
    documented)], [`docs/bootstrap.md` §5.1],
    [Ubuntu/Ironic/EOS images staged on seed], [`http://seed/images/`],
  )]
  , kind: table
  )

Then run #strong[docs/bootstrap.md] end-to-end: NetBox → seed →
Metal3/CAPI (3 CP + 8 workers) → Flux platform → smoke. The interactive
walkthrough of that flow is #link("../demo/README.pdf")[demo/].

#horizontalrule

= Acceptance checklist (hardware)
<acceptance-checklist-hardware>
- ☐ 4 racks populated per NetBox elevations; airflow correct; rPDUs A/B
  metered
- ☐ One-A-side power pull: zero device loss
- ☐ 169/169 cables labeled, in NetBox `connected`, LLDP-verified (rails
  exact)
- ☐ 12/12 switches target EOS; BGP Established; 30-min zero-error soak
- ☐ 15/15 servers Redfish-reachable; firmware pinned; SEL clean
- ☐ 64/64 GPUs pass `dcgmi diag -r 3`\; 30-min full-rack thermal burn
  within spec
- ☐ 8/8 rails \~400G perftest; 2-h fabric soak clean
- ☐ Handoff artifacts complete; bootstrap §5.1 prerequisites all true

#horizontalrule

= Troubleshooting
<troubleshooting>
#figure(
  align(center)[#table(
    columns: (28%, 48%, 24%),
    align: (auto,auto,auto,),
    table.header([Symptom], [Likely cause], [Action],),
    table.hline(),
    [BMC unreachable], [OOB cable/VLAN], [Check `show lldp neighbors` on
    7010TX; verify Cat6 label vs port],
    [Rail link down], [Wrong leaf/port or bad DAC], [LLDP audit; swap
    DAC from spares; re-check label `R{r}-W{n}`],
    [Leaf↔spine flapping], [AOC/optic DOM out of
    range], [`show interfaces transceiver`\; reseat/replace from
    spares],
    [GPU missing in POST], [Seating / power / firmware], [Reseat node
    power; check SEL; re-flash GPU firmware baseline],
    [NIC not 400G], [Wrong cable type or port config], [Confirm DAC 400G
    QSFP-DD; check interface speed/fec config],
    [Rack thermal alarm in burn], [Airflow mismatch or containment
    gap], [Verify F-R/R-F SKUs; check blanking panels; call facilities],
    [PFC pause storms in soak], [QoS profile misapplied], [Re-apply
    `docs/network.md` AI profile; verify ECN thresholds],
  )]
  , kind: table
  )

#horizontalrule

= References
<references>
#figure(
  align(center)[#table(
    columns: (50%, 50%),
    align: (auto,auto,),
    table.header([Doc], [Use],),
    table.hline(),
    [#link("../SPEC.pdf")[SPEC.md]], [Design authority (fabric, power,
    cooling, storage)],
    [#link("cabling.pdf")[docs/cabling.md] / `cabling.csv`], [169-cable
    tables + labels],
    [#link("netbox.pdf")[docs/netbox.md]], [SoT operations,
    day-0/day-2],
    [#link("bootstrap.pdf")[docs/bootstrap.md]], [Software bring-up
    after this guide],
    [#link("network.pdf")[docs/network.md]], [ZTP, underlay, RoCEv2
    lossless profile (§9 gate)],
    [`docs/facility.md` #emph[\(planned)]], [Elevations, floor, cooling
    detail],
    [#link("../demo/README.pdf")[demo/]], [Interactive walkthrough of
    the bring-up flow],
  )]
  , kind: table
  )

#horizontalrule

= Revision
<revision>
#figure(
  align(center)[#table(
    columns: 3,
    align: (auto,auto,auto,),
    table.header([Version], [Date], [Notes],),
    table.hline(),
    [0.1], [2026-07-18], [Initial hardware build guide],
  )]
  , kind: table
  )

