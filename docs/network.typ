// GENERATED from docs/network.md — do not edit. Regenerate: python3 docs/md2pdf.py
#import "../docs/template.typ": *
#show: doc.with(title: "Network — ZTP, Underlay, and RoCEv2 Lossless Design", kicker: "AIDATACENTER — NETWORK / ZTP / ROCE", rev: "0.2 · 2026-07-19")

#strong[Status:] Draft \
#strong[Scope:] Day-0 switch bring-up (ZTP) for OOB / spine / rail-leaf
switches, fabric underlay, RoCEv2 lossless Ethernet profile \
#strong[Implements:] #link("../SPEC.pdf")[SPEC.md] §5 (network), §5.10
(OOB) · consumed by #link("build-guide.pdf")[docs/build-guide.md] §9 and
#link("bootstrap.pdf")[docs/bootstrap.md]

#quote(block: true)[
#strong[SoT rule:] device mgmt IPs, MACs, and cables come from NetBox
(`bootstrap/netbox/seed/site.yaml` pre-go-live). Switch configs are
#strong[rendered], never hand-written: `bootstrap/seed/ztp/render.py` →
one startup-config per switch serial.
]

#horizontalrule

= Switch inventory and management plan
<switch-inventory-and-management-plan>
#figure(
  align(center)[#table(
    columns: (13.33%, 14.44%, 6.67%, 17.78%, 18.89%, 12.22%, 16.67%),
    align: (auto,auto,auto,auto,auto,auto,auto,),
    table.header([Device], [Model], [Rack], [Ma1 IP (VLAN 20)], [Ma1
      MAC¹], [BGP ASN], [Loopback0],),
    table.hline(),
    [oob-sw1], [7010TX-48], [GPU-1], [10.20.0.11], [00:00:00:00:23:01], [---
    (MLAG/L2)], [---],
    [oob-sw2], [7010TX-48], [GPU-2], [10.20.0.12], [00:00:00:00:23:02], [---
    (MLAG/L2)], [---],
    [spine1], [7060DX5-64S], [BOOT], [10.20.0.13], [00:00:00:00:21:01], [65000], [10.30.0.1/32],
    [spine2], [7060DX5-64S], [BOOT], [10.20.0.14], [00:00:00:00:21:02], [65000], [10.30.0.2/32],
    [leaf-rail0--7], [7060DX5-32], [GPU-1/2], [10.20.0.41--48], [00:00:00:00:22:0#emph[r]], [65101--65108], [10.30.0.11--18/32],
  )]
  , kind: table
  )

¹ Placeholder MACs from the seed --- replaced with burned-in MACs at
receiving (build-guide §5); DHCP reservations and `render.py` output
regenerate from NetBox.

Gateways (VARP on the OOB MLAG pair): #strong[10.10.0.1] (VLAN 10 mgmt),
#strong[10.20.0.1] (VLAN 20 OOB). All infra services (DHCP/DNS/NTP/HTTP)
live on #strong[seed01 = 10.10.0.10].

#horizontalrule

= Day-0 dependency chain
<day-0-dependency-chain>
```
seed01 (hand-installed)                 ← the only manual install
   │ DHCP option 67 → http://10.10.0.10/ztp/ztp.py
   ├─► oob-sw1, oob-sw2   (zero-day bench ZTP, §3.2)   ← first switches
   ├─► spine1, spine2     (ZTP via OOB relay, §3.3)
   └─► leaf-rail0…7       (ZTP via OOB relay, §3.3)
```

#strong[The chicken-and-egg rule:] every switch except the seed is
ZTP'd; nothing is configured by hand except seed01 and emergency console
access.

#horizontalrule

= ZTP architecture
<ztp-architecture>
== Components
<components>
#figure(
  align(center)[#table(
    columns: (35.71%, 35.71%, 28.57%),
    align: (auto,auto,auto,),
    table.header([Piece], [Where], [Role],),
    table.hline(),
    [dnsmasq], [seed01 (`/etc/dnsmasq.d/ai-cluster*.conf`)], [DHCP + DNS
    for VLAN 10/20; option 67 for switches],
    [nginx], [seed01 (`/var/www/html/ztp/`)], [Serves `ztp.py`,
    `configs/<serial>`, `images/`],
    [`ztp.py`], [`bootstrap/seed/ztp/ztp.py` →
    `http://10.10.0.10/ztp/ztp.py`], [On-switch bootstrap: serial →
    config → reload],
    [`render.py`], [`bootstrap/seed/ztp/render.py`], [Renders 12
    startup-configs from `seed/site.yaml`],
    [`serialmap.yaml`], [`bootstrap/seed/ztp/serialmap.yaml`], [Serial →
    hostname (filled at staging)],
  )]
  , kind: table
  )

`render.py` output is derived from the same seed that drives NetBox,
cabling, and dnsmasq --- OOB access-port maps come from `all_cables()`,
so #strong[the config cannot disagree with the cabling guide].

Standard EOS ZTP mechanics used: a switch with no `startup-config`
broadcasts DHCPDISCOVER on Management1 #strong[and] on any front-panel
port with link; option 67 (bootfile) containing an `http://` URL is
downloaded and executed as a script; the script writes `startup-config`,
sets `/mnt/flash/zerotouch-config` `DISABLE=True`, and reloads.

== Zero-day: how the OOB switches come up (answer to the bootstrap question)
<zero-day-how-the-oob-switches-come-up-answer-to-the-bootstrap-question>
The OOB pair is the root of the management network, so it cannot depend
on any other switch. Procedure (also in build-guide §9.1):

+ #strong[seed01 first.] Installed by hand (autoinstall USB / BMC
  virtual media) on the bench; `00-seed-host.sh` brings up dnsmasq +
  nginx. seed01 needs exactly one Ethernet port.
+ #strong[Fill `serialmap.yaml`] with the two 7010TX serials (captured
  at receiving) and run `render.py` →
  `/var/www/html/ztp/configs/<serial>`.
+ #strong[Bench ZTP oob-sw1:] patch seed01 `eth0` → oob-sw1 any
  front-panel port (e.g.~`Ethernet48`), power on. With no
  startup-config, EOS ZTP DHCPs untagged on the front port; dnsmasq
  answers from the dynamic pool (10.10.0.200--250) and returns option 67
  via the #strong[catch-all] `dhcp-boot` line. `ztp.py` runs, learns its
  serial, pulls `configs/<serial>` (the real oob-sw1 config: MLAG,
  VLANs, SVIs, VARP, DHCP relay), writes it, disables ZTP, reloads.
+ #strong[Repeat for oob-sw2] (direct to seed01, or via an oob-sw1
  access port once sw1 is live).
+ #strong[Rack both], cable per `docs/cabling.md` §5 (access ports +
  MLAG peer-link `Ethernet49–50`), power, verify MLAG: `show mlag` →
  `state: active`, `peer: live`\; VARP gateways `.1` answer on both
  VLANs.
+ #strong[Fallback:] if ZTP fails twice, console in (9600 8N1, console
  server in BOOT) and paste the rendered config for that serial --- it
  is identical to what ZTP would have delivered.

Why bench-ZTP instead of manual console config: the OOB pair's config is
the most intricate in the design (MLAG + VARP + relay + port map);
delivering it through the same rendered pipeline as everything else
removes a whole class of day-0 typos. The bench step needs no
infrastructure beyond seed01 and one patch cable.

== Spines and rail leaves --- ZTP via OOB relay
<spines-and-rail-leaves-ztp-via-oob-relay>
Once the OOB pair is live:

```
spine/leaf Management1 ──cat6──► OOB access port (VLAN 20)
        │ DHCPDISCOVER
        ▼ relay: ip helper-address 10.10.0.10 (Vlan20 SVI, VARP 10.20.0.1)
   dnsmasq (reservation by Ma1 MAC → 10.20.0.13/14, .41–48, tag ztp)
        │ option 67 → http://10.10.0.10/ztp/ztp.py
        ▼
   ztp.py → configs/<serial> (underlay + RoCE profile) → reload
```

- Reservations are keyed by #strong[Ma1 MAC] (seed placeholders until
  staging; regenerated by `netbox-sync.sh` after MAC capture).
- Config identity is by #strong[serial] (not IP), so a swap/replacement
  unit just works once its serial is in `serialmap.yaml` (or NetBox
  post-go-live).
- #strong[Order matters:] spines before leaves is conventional but not
  required --- leaves simply retry until spines appear. Bring up spine1,
  spine2, then all 8 leaves; BGP comes up as pairs complete.

== Generated dnsmasq (relevant lines)
<generated-dnsmasq-relevant-lines>
```
dhcp-range=10.10.0.200,10.10.0.250,12h          # bench/ZTP dynamic pool (VLAN 10)
dhcp-range=10.20.0.0,static,12h                 # VLAN 20: reservations only (via relay)

dhcp-boot=tag:!ipxe,tag:efi64,ipxe.efi          # servers: UEFI → iPXE → OS
dhcp-boot=tag:ipxe,http://10.10.0.10/boot.ipxe
dhcp-boot=tag:ztp,http://10.10.0.10/ztp/ztp.py  # switches w/ Ma1 reservations
dhcp-boot=tag:!ztp,tag:!efi64,tag:!ipxe,http://10.10.0.10/ztp/ztp.py  # bench catch-all

# from generated/dhcp-hosts.conf (netbox-sync.sh):
dhcp-host=00:00:00:00:21:01,set:ztp,10.20.0.13,spine1,infinite
dhcp-host=00:00:00:00:22:03,set:ztp,10.20.0.44,leaf-rail3,infinite
dhcp-host=00:00:00:00:01:02,10.20.0.101,worker01-bmc,infinite
...
```

== `ztp.py` behavior contract
<ztp.py-behavior-contract>
#figure(
  align(center)[#table(
    columns: (15.38%, 23.08%, 61.54%),
    align: (auto,auto,auto,),
    table.header([Step], [Action], [Failure handling],),
    table.hline(),
    [1], [`show version` → serial], [exit non-zero, stays in ZTP,
    retries next boot],
    [2], [`GET configs/<serial>` (5× backoff)], [as above --- fix
    serialmap and power-cycle],
    [3], [Optional `!IMAGE:` marker → stage + sha512-verify EOS image,
    write `boot-config`], [abort on checksum mismatch],
    [4], [Write `/mnt/flash/startup-config`], [---],
    [5], [`zerotouch-config DISABLE=True`, reload], [lands on real
    config; ZTP never re-fires],
  )]
  , kind: table
  )

Log: `/mnt/flash/ztp.log` on the switch; seed-side hits in nginx access
log.

== Re-ZTP / recovery runbook
<re-ztp-recovery-runbook>
#figure(
  align(center)[#table(
    columns: (44.44%, 55.56%),
    align: (auto,auto,),
    table.header([Goal], [Steps],),
    table.hline(),
    [Re-provision a switch], [`write erase` → `reload` → ZTP runs again
    (config still in `configs/<serial>`)],
    [Skip ZTP once], [console: `zerotouch cancel`],
    [New/replacement unit], [add serial to `serialmap.yaml` (or NetBox),
    `render.py`, `netbox-sync.sh`\; power on],
    [Change config fleet-wide], [edit seed/templates → `render.py` →
    `config replace` via eAPI/SSH per switch (day-2: CloudVision or
    Ansible)],
    [seed01 down during ZTP storm], [switches retry (backoff in
    `ztp.py`); nothing bricks --- ZTP re-fires on next boot],
  )]
  , kind: table
  )

#horizontalrule

= OOB network design (7010TX-48 pair)
<oob-network-design-7010tx-48-pair>
Two 1G switches as an #strong[MLAG pair] across GPU-1/GPU-2 --- a single
OOB switch failure must not black-hole BMC access (SPEC §5.10).
#strong[No lossless QoS on OOB] --- it carries best-effort management
only.

#figure(
  align(center)[#table(
    columns: (53.85%, 46.15%),
    align: (auto,auto,),
    table.header([Element], [Design],),
    table.hline(),
    [Peer-link], [`Ethernet49–50` = Port-Channel1 (2× 25G SFP28 DAC),
    `trunk group mlagpeer`],
    [MLAG peer], [Vlan4094 `10.255.0.0/30` (.1 sw1, .2 sw2),
    `domain-id oob`],
    [VLAN 10 (mgmt)], [server `mgmt0` (OS/PXE); SVI .11/.12,
    #strong[VARP 10.10.0.1]],
    [VLAN 20 (oob)], [BMC + switch Ma1 (ZTP); SVI .11/.12, #strong[VARP
    10.20.0.1], `ip helper-address 10.10.0.10`],
    [Uplinks], [SFP28 51--52 reserved for site network/border (day-1:
    none)],
    [Control plane], [ACL `mgmt-plane`: only 10.10/10.20 + ICMP to
    switch CPU],
    [STP], [MSTP, sw1 root (4096) / sw2 backup (8192); none on VLAN
    4094],
  )]
  , kind: table
  )

Access-port map (rendered from cabling SoT --- `docs/cabling.md` §5):

#figure(
  align(center)[#table(
    columns: 3,
    align: (auto,auto,right,),
    table.header([oob-sw1 ports], [Use], [VLAN],),
    table.hline(),
    [Ethernet1--10], [BMC: cp01--03, util01--03, worker01--04], [20],
    [Ethernet11--21], [mgmt0: seed01, cp01--03, util01--03,
    worker01--04], [10],
    [Ethernet22--27], [Ma1: spine1, spine2, leaf-rail0--3], [20],
    [oob-sw2 ports], [Use], [VLAN],
    [Ethernet1--4], [BMC: worker05--08], [20],
    [Ethernet5--8], [mgmt0: worker05--08], [10],
    [Ethernet9--12], [Ma1: leaf-rail4--7], [20],
  )]
  , kind: table
  )

Headroom: 27/48 and 12/48 ports used --- STOR rack and site uplinks fit
without a third OOB switch (SPEC §5.10 "optional 3rd" not needed day-1).

Full rendered configs: `render.py` output for `SERIAL-OOB-SW1/2` (MLAG,
VARP, relay, ACL, complete port map).

#horizontalrule

= Fabric underlay
<fabric-underlay>
Day-1: #strong[L3 leaf-spine, eBGP numbered] underlay. The EVPN/VXLAN
overlay (vrf `storage` + vrf `edge`, VTEPs, border) is layered on top
--- design in #link("overlay.pdf")[docs/overlay.md]\; RoCE rail traffic
stays native in the underlay (never VXLAN-encapped). Spine ports 34--64
remain reserved.

== IP plan (from `10.30.0.0/16` container, seed IPAM)
<ip-plan-from-10.30.0.016-container-seed-ipam>
#figure(
  align(center)[#table(
    columns: (62.5%, 37.5%),
    align: (auto,auto,),
    table.header([Block], [Use],),
    table.hline(),
    [`10.30.0.0/24`], [Loopbacks: spines `.1/.2`, leaf-rail0--7
    `.11–.18`],
    [`10.30.0.0/19`], [p2p /31 pool: leaf-rail#emph[i] uses
    `10.30.{2i+1}.0/29` → spine1 (4× /31) and `10.30.{2i+2}.0/29` →
    spine2],
    [`10.30.64.0/19`], [Host rail subnets: rail #emph[i] =
    `10.30.{64+i}.0/24` (leaf `.1`, worker0N `.1N`)],
    [`10.40.0.0/16`], [Storage (routed ports on leaf-rail0/rail7, §7)],
  )]
  , kind: table
  )

Numbered /31s (not unnumbered) chosen deliberately: they are
NetBox-IPAM-native, ping/LLDP-auditable per link, and unambiguous in
ZTP-rendered configs --- at 64 links the address economy of unnumbered
buys nothing.

Example --- leaf-rail3: uplinks `Ethernet17–24` = `10.30.7.0/31`
(spine1), `10.30.8.0/31` (spine2), `10.30.7.2/31`, `10.30.8.2/31`,
`10.30.7.4/31`, `10.30.8.4/31`, `10.30.7.6/31`, `10.30.8.6/31`\; rail
VLAN 67 SVI `10.30.67.1/24`.

== eBGP plan
<ebgp-plan>
#figure(
  align(center)[#table(
    columns: (44.44%, 55.56%),
    align: (auto,auto,),
    table.header([Knob], [Value],),
    table.hline(),
    [ASN], [spines 65000; leaf-rail#emph[i] = 65101+#emph[i]],
    [Sessions], [32 per spine (8 leaves × 4), 8 per leaf (4 per spine)],
    [ECMP], [`maximum-paths 32`],
    [BFD], [on every p2p neighbor],
    [Advertised], [leaf: loopback /32 + rail /24; spine: loopback /32
    (no transit filtering needed at this scale)],
    [TTL/next-hop], [eBGP single-hop; no communities day-1],
  )]
  , kind: table
  )

Hosts are #emph[not] BGP speakers day-1: rail subnets are leaf SVIs (L2
access ports); worker NIC IPs (`10.30.{64+rail}.1N`) are assigned at OS
provisioning from NetBox data (Metal3/cloud-init --- bootstrap track).

== MTU
<mtu>
`9216` on every fabric port (leaf host + uplink, spine) and rail SVI;
host NICs 9214/9000 payload tuned with the GPU stack. Verified
end-to-end in burn-in (`ping -M do -s 9172` per rail).

#horizontalrule

= RoCEv2 lossless design
<rocev2-lossless-design>
MoE expert-parallel all-to-all is bursty and many-to-one (incast) per
rail; the design target is #strong[zero loss for the RoCE class] with
early ECN so DCQCN rarely lets PFC fire.

== Traffic classes
<traffic-classes>
#figure(
  align(center)[#table(
    columns: (11.63%, 9.3%, 30.23%, 32.56%, 16.28%),
    align: (auto,right,auto,auto,auto,),
    table.header([Class], [DSCP], [Traffic-class], [Queue
      behavior], [Used by],),
    table.hline(),
    [RoCE data], [#strong[26]], [#strong[3]], [#strong[PFC no-drop] +
    ECN (WRED mark)], [NCCL/EP (GPU rail NICs)],
    [CNP], [#strong[48]], [#strong[6]], [Strict priority
    (small)], [DCQCN congestion notifications],
    [Storage], [18], [1], [Weighted, lossy], [model FS / archive (§7)],
    [Default], [0], [0], [Best-effort], [everything else],
    [Network control], [---], [\(EOS
    default)], [protected], [BGP/BFD/LLDP],
  )]
  , kind: table
  )

Marking source of truth is the #strong[host] (NIC marks DSCP 26 on RoCE,
48 on CNP); switches run `qos trust dscp` on all fabric ports and map
per the table. VLAN CoS is irrelevant here (routed uplinks; rail access
ports carry one class).

== PFC
<pfc>
- `priority-flow-control priority 3 no-drop` on #strong[every] fabric
  port (leaf host + uplink, spine downlink) --- lossless must be
  symmetric or head-of-line blocking just moves.
- #strong[PFC watchdog] enabled globally (`polling-interval 0.4`,
  `action errdisable`): a stuck pause (misbehaving NIC/host) errdisables
  the port instead of tree-pausing the rail. Alerts to observability
  stack; port auto-recovers after host fix.
- Pause #emph[received] on TC0/1/6 classes is invalid --- only TC3
  participates.

== ECN (DCQCN marking)
<ecn-dcqcn-marking>
WRED-ECN on TC3, all fabric ports --- starting values, tuned with LANZ
during burn-in (§8):

#figure(
  align(center)[#table(
    columns: (22.22%, 27.78%, 50%),
    align: (auto,right,auto,),
    table.header([Knob], [Start], [Reasoning],),
    table.hline(),
    [min-threshold], [512 KB], [mark early: 400G × \~3 µs fabric RTT ≈
    150 KB BDP; well below PFC headroom],
    [max-threshold], [1536 KB], [≈ 3× min; queue beyond this ⇒ mark
    \~all ⇒ DCQCN clamps rate before PFC],
    [drop-probability], [100 (mark-only above max)], [RoCE class never
    tail-drops],
  )]
  , kind: table
  )

Goal: #strong[PFC frames ≈ 0 in steady state]\; ECN marks carry the
congestion signal. If PFC fires routinely, thresholds or host DCQCN
gains are wrong --- not "normal".

== Buffer / headroom math
<buffer-headroom-math>
Per-port PFC headroom ≈ link rate × (PFC reaction time) + 2× MTU:

```
400 Gbps × 5 µs (MAC + ~3 m DAC + ASIC pipeline) ≈ 250 KB  +  18 KB ≈ ~300 KB per port
leaf: 16 fabric ports × 300 KB ≈ 5 MB  ≪  57 MB shared (DX5-32)
spine: 32 ports × 300 KB ≈ 10 MB      ≪ 114 MB shared (DX5-64S)
```

MMU/headroom-pool commands are platform/release-specific (Tomahawk-class
on DX5) --- #strong[pin exact knobs during lab validation] against the
target EOS release; the rendered configs carry the queue/ECN/PFC intent
plus this budget. Worst-case check at burn-in: all 8 hosts blasting one
rail egress must not drop in TC3.

== ECMP and DLB
<ecmp-and-dlb>
- Static-hash ECMP entropy: `port-channel load-balance fields` include
  L3 src/dst + L4 ports (RoCE QP per-connection gives flow entropy).
- #strong[DLB (Dynamic Load Balancing)] on DX5 platforms where supported
  by the target EOS release: flowlet-based rebalancing for long-lived AI
  flows over the 8-way leaf→spine mesh; fall back to resilient ECMP if
  the release lacks it. Exact `load-balance policies` syntax pinned in
  lab validation (§8).

== Host side (day-2, GPU/Network Operator)
<host-side-day-2-gpunetwork-operator>
#figure(
  align(center)[#table(
    columns: (58.33%, 41.67%),
    align: (auto,auto,),
    table.header([Setting], [Value],),
    table.hline(),
    [RoCE mode], [v2, GID index per mlx (RoCEv2/IPv4)],
    [DCQCN], [enabled on all 8 rail NICs (ConnectX-7/BF3)],
    [NIC QoS], [trust DSCP egress; PFC on priority 3 only; RoCE DSCP 26,
    CNP DSCP 48],
    [NCCL], [`NCCL_IB_GID_INDEX` (RoCEv2), `NCCL_IB_TC=104` (DSCP 26 ≪
    2), rail HCA pinning per worker],
  )]
  , kind: table
  )

Applied via NVIDIA Network Operator / `mlnx_qos` + `mlxconfig` on
workers --- outside this doc's switch scope but listed because the
lossless contract is end-to-end: a host that marks nothing DSCP 26 gets
no lossless treatment.

== Explicitly #emph[not] lossless
<explicitly-not-lossless>
- #strong[OOB (7010TX-48):] no PFC/ECN anywhere (SPEC §5.10).
- #strong[Storage class (TC1):] lossy by design; storage retries, GPU
  collectives must not wait behind storage bursts.
- #strong[Storage VLAN/VRF segmentation] stays separate from the RoCE
  class queues (§7).

#horizontalrule

= Storage / services attachment (day-1)
<storage-services-attachment-day-1>
#figure(
  align(center)[#table(
    columns: (40%, 60%),
    align: (auto,auto,),
    table.header([Item], [Design],),
    table.hline(),
    [Ports], [leaf-rail0 `Ethernet25–28`, leaf-rail7 `Ethernet25–28`
    (routed, MTU 9216)],
    [Addressing], [/31 p2p per link from `10.40.0.0/24`\; storage nodes
    2× 400G each to both leaves (ECMP)],
    [QoS], [DSCP 18 → TC1 (§6.1); no PFC; separate from RoCE class],
    [Routes], [`10.40.0.0/16` lives in #strong[vrf storage] (EVPN
    type-5) --- no longer in the default VRF],
    [Isolation], [dedicated storage VRF via EVPN/VXLAN ---
    #strong[done], #link("overlay.pdf")[docs/overlay.md] §3],
  )]
  , kind: table
  )

Model-load bandwidth: 4× 400G ≈ 160 GB/s fabric-facing --- above the
SPEC §6.4 ≥ 40 GB/s hot-tier target with headroom.

#horizontalrule

= Verification and acceptance
<verification-and-acceptance>
== ZTP gates (per switch)
<ztp-gates-per-switch>
#figure(
  align(center)[#table(
    columns: (17.39%, 65.22%, 17.39%),
    align: (auto,auto,auto,),
    table.header([Gate], [Command / check], [Pass],),
    table.hline(),
    [ZTP done], [`show zerotouch`], [`disabled`, config present],
    [Identity], [`show hostname`, serial ↔ serialmap], [exact],
    [Image], [`show version`], [target EOS release],
    [Ma1], [`show interfaces Management1`], [reserved 10.20.0.x, ping
    seed01],
    [Time/DNS], [`show ntp status`, DNS resolve], [synced to
    10.10.0.10],
  )]
  , kind: table
  )

== Fabric gates
<fabric-gates>
#figure(
  align(center)[#table(
    columns: (26.67%, 46.67%, 26.67%),
    align: (auto,auto,auto,),
    table.header([Gate], [Command], [Pass],),
    table.hline(),
    [Links], [`show interfaces status`], [leaf: 8 host + 8 uplink
    connected; spine: 32 connected],
    [BGP], [`show bgp summary`], [all 32/8 sessions Established],
    [ECMP], [`show ip route 10.30.0.11/32` (from another
    leaf)], [8-way],
    [MTU], [`ping -M do -s 9172` across each /31], [64/64],
    [BFD], [`show bfd peers`], [all up],
  )]
  , kind: table
  )

== RoCE gates (burn-in, with hosts)
<roce-gates-burn-in-with-hosts>
#figure(
  align(center)[#table(
    columns: (28.57%, 42.86%, 28.57%),
    align: (auto,auto,auto,),
    table.header([Gate], [Method], [Pass],),
    table.hline(),
    [Line rate per rail], [`ib_write_bw` worker-pair per rail], [\~400G,
    retransmits ≈ 0],
    [Incast], [7→1 same-rail perftest], [no TC3 drops; PFC ≈ 0, ECN
    marks \> 0],
    [All-to-all], [`nccl-tests` `all_to_all` 8×8], [expected bus BW; no
    stalls],
    [Watchdog drill], [pause-flood one host port], [errdisable fires,
    rail survives],
    [Soak], [2 h all-rail load], [0 watchdog events, bounded ECN, 0
    CRC],
  )]
  , kind: table
  )

Counters watched: `show interfaces counters | include pause`,
`show qos interfaces Ethernet*`, LANZ queue-depth streams,
`show interfaces counters errors`.

#horizontalrule

= Telemetry to the ops stack
<telemetry-to-the-ops-stack>
#figure(
  align(center)[#table(
    columns: (40%, 40%, 20%),
    align: (auto,auto,auto,),
    table.header([Signal], [Source], [Use],),
    table.hline(),
    [PFC pause tx/rx per port], [EOS counters → Prometheus
    (eAPI/ONCHANGE)], [lossless pressure, storm early-warning],
    [ECN marks per queue], [EOS QoS counters], [DCQCN health (marks
    good, pauses bad)],
    [Queue depth], [LANZ streaming], [microburst/incast forensics],
    [BGP/BFD state], [EOS → alerts], [fabric reachability],
    [ZTP events], [nginx/dnsmasq logs on seed01 +
    `/mnt/flash/ztp.log`], [bring-up audit],
  )]
  , kind: table
  )

#horizontalrule

= What this doc does #emph[not] cover
<what-this-doc-does-not-cover>
- Host/NIC DCQCN and NCCL tuning beyond §6.6 (GPU platform track)
- EVPN/VXLAN overlay, VRFs, border/API ingress --- →
  #link("overlay.pdf")[docs/overlay.md]
- Site/campus uplink for the OOB pair (SFP28 51--52 reserved)
- Storage-product-specific networking (→ `docs/storage.md`, planned)

#horizontalrule

= References
<references>
#figure(
  align(center)[#table(
    columns: (76.92%, 23.08%),
    align: (auto,auto,),
    table.header([Doc / path], [Use],),
    table.hline(),
    [#link("../SPEC.pdf")[SPEC.md] §5, §5.10], [Fabric + OOB
    requirements],
    [#link("overlay.pdf")[docs/overlay.md]], [EVPN/VXLAN overlay on this
    underlay],
    [#link("cabling.pdf")[docs/cabling.md]], [169-cable tables
    incl.~OOB/Ma1/peer],
    [#link("build-guide.pdf")[docs/build-guide.md] §9], [Physical switch
    bring-up sequence],
    [`bootstrap/seed/ztp/`], [`ztp.py`, `render.py`,
    `serialmap.example.yaml`],
    [`bootstrap/seed/dnsmasq.conf.tmpl` +
    `bootstrap/seed/generated/dhcp-hosts.conf`], [DHCP/option-67 plan as
    deployed],
    [Arista EOS #emph[ZTP] and #emph[RoCE/AI networking] chapters
    (target release)], [Syntax validation gate before production],
  )]
  , kind: table
  )

#horizontalrule

= Revision History
<revision-history>
#figure(
  align(center)[#table(
    columns: (43.75%, 25%, 31.25%),
    align: (auto,auto,auto,),
    table.header([Version], [Date], [Notes],),
    table.hline(),
    [0.1], [2026-07-19], [Initial: ZTP day-0 (OOB bench ZTP → relay
    ZTP), numbered eBGP underlay, RoCEv2 lossless profile],
    [0.2], [2026-07-19], [Overlay delivered (`docs/overlay.md`): storage
    moved to vrf storage; host ports trunked (native rail VLAN + tagged
    50/200); border on spine Eth33],
  )]
  , kind: table
  )

