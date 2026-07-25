# Seed Node Bootstrap Lab

A Docker lab that proves the bootstrap story in `seed-node-stack.png`: **one hand-installed
seed node provisions an entire AI pod, and nothing else is ever configured by hand.**

Ten containers boot knowing nothing but their own MAC addresses — six SONiC switches and
four GPU compute nodes. They take a DHCP lease, follow option 67 to a ZTP descriptor,
discover who they are, download the golden config the seed rendered for them from NetBox,
and come up as a rail-optimised leaf/spine fabric running BGP.

```
                          SEED NODE (10.10.0.10)
   ┌──────────────────────────────────────────────────────────────┐
   │ OBSERVABILITY   syslog collector · Prometheus · Grafana       │
   │ CONTROL PLANE   NetBox (source of truth) · config generator   │
   │ CORE SERVICES   DNS · NTP                                     │
   │ PROVISIONING    DHCP · TFTP/iPXE · HTTP (configs + images)    │
   └──────────────────────────────┬───────────────────────────────┘
                                  │ OOB management 10.10.0.0/24
       ┌──────────────────────────┴──────────────────────────┐
       │                                                     │
   spine1  spine2          ← eBGP underlay, ECMP →           │
     │  ╲  ╱  │                                              │
     │   ╳    │      leaf1   leaf2   leaf3   leaf4           │
     │  ╱  ╲  │      rail0   rail1   rail2   rail3           │
     └────────┘        │       │       │       │
                       └───────┴───┬───┴───────┘
                                   │  NIC k of every node → leaf k
                       gpu01  gpu02  gpu03  gpu04
```

---

## Quick start

```powershell
./scripts/fetch-sonic-image.ps1   # once: pull the SONiC VS image (~210 MB)
./lab.ps1 up                      # render, boot, provision  (~6 min first run)
./lab.ps1 verify                  # prove it
```

Or build the fabric from FRR instead, and prove the data plane as well:

```powershell
./lab.ps1 up -Frr                 # no SONiC image needed
./lab.ps1 verify
```

## Two switch profiles

The seed, the source of truth, the cable plan, the ZTP flow and the compute nodes are
**identical** in both. Only what runs on the switches changes — which is the point: it
shows the provisioning pipeline is genuinely independent of the NOS underneath.

| | `sonic` (default) | `frr` (`-Frr`) |
|---|---|---|
| Switch | SONiC-VS: Redis CONFIG_DB, SAI, `syncd` | FRR on the Linux data plane |
| Config artifact | `config_db.json` + `frr.conf` | `fabric.json` + `frr.conf` |
| NOS realism | Real NOS internals | A Linux router |
| Lossless QoS | PFC / ECN / buffers verified | no equivalent — skipped |
| Host-to-host forwarding | **none** (no packet pipeline) | **real**, ~44 Gbit/s measured |
| Boot time | ~90 s/switch | ~20 s/switch |
| Image | 1.78 GB, manual fetch | 248 MB, from Docker Hub |
| Result | 135 pass / 0 fail / 1 skip | 134 pass / 0 fail / 1 skip |

Use `sonic` to prove the NOS config path; use `frr` to prove packets actually move.

| | |
|---|---|
| Seed | <http://localhost:8080> |
| NetBox | <http://localhost:18000> (admin/admin) |
| Grafana | <http://localhost:13000> |
| Prometheus | <http://localhost:19090> |

Other commands: `render`, `status`, `logs <device>`, `shell <device>`, `miscable`,
`repair`, `down`, `clean`.

Requires Docker Desktop, ~8 GB free RAM, and Python 3 on the host for `verify`.
Everything else runs in containers.

---

## What this lab does and does not prove

Being straight about this matters more than a green checkmark.

### Proven, end to end

- **Zero-touch provisioning.** Real DHCP (DISCOVER/OFFER/REQUEST/ACK) against dnsmasq,
  identity from a per-MAC reservation, option 67 pointing at a ZTP descriptor, config
  fetched over HTTP and verified against a SHA-256 the seed published. No device image
  contains any device-specific configuration.
- **Source of truth → device.** NetBox holds devices, interfaces, cables, addressing and
  ASNs. The generator renders `config_db.json` + `frr.conf` per switch and `node.json` per
  compute node. Rendering from NetBox and rendering from the YAML produce **byte-identical
  output** — verified.
- **SONiC actually accepts the config.** Ports, jumbo MTU, VLANs, L3 interfaces, loopbacks
  and QoS appear in CONFIG_DB/STATE_DB and are programmed onto interfaces. This is a real
  NOS with Redis CONFIG_DB and `syncd` talking SAI, not a mock.
- **BGP underlay converges.** All 12 eBGP sessions establish from seed-rendered config;
  every leaf learns every remote rail prefix with **ECMP over both spines**.
- **Cabling validation.** LLDP on all 48 cable endpoints is diffed against the cable plan.
  `./lab.ps1 miscable` crosses two rails on gpu01 and the check names the exact cable from
  both ends — the failure mode where nothing goes down and collectives quietly degrade.
- **Lossless QoS consistency.** PFC priority, ECN/WRED thresholds and the PFC watchdog are
  asserted byte-identical across all six switches.
- **Drift detection**, **observability** (syslog + Prometheus + Grafana), and the
  **TFTP/iPXE** leg of the seed.

### Proven on the `frr` profile — the data plane

- **Real forwarding.** Same-rail traffic is switched by the leaf's rail bridge in one hop;
  transit traffic (a compute node to a leaf loopback) is routed leaf → spine → leaf in
  three, with the path confirmed by traceroute rather than assumed.
- **Measured throughput**, not asserted: `iperf3` between compute nodes across the
  provisioned fabric, ~44 Gbit/s per rail. This is the slot where a real pre/post
  regression gate would run `ib_write_bw` or `nccl-tests` baselines.
- **Jumbo frames end to end**, including across a spine — 9000-byte payloads with DF set,
  so anything that silently fragments fails the check.
- **ECMP in the forwarding table**: two kernel next-hops per remote prefix, with L4
  multipath hashing on, because 3-tuple hashing collapses AI traffic's few elephant flows
  onto a single uplink.

### Not proven — and why

- **Host-to-host packet forwarding on the `sonic` profile.** SONiC-VS is a *control-plane*
  simulator. `libsaivs` maintains ASIC_DB state faithfully but implements no forwarding
  pipeline, so traffic that needs the ASIC to bridge or transit-route between front-panel
  ports is never forwarded. Traffic *terminating on a switch CPU* (point-to-point links,
  loopbacks, rail gateways, BGP) works and is tested. Routes showing `q` in
  `show ip route` are the same cause: zebra is waiting for an ASIC offload confirmation
  that never arrives. Run `-Frr` to prove forwarding.
- **Lossless behaviour under congestion.** On `sonic`, QoS is verified as *configured and
  consistent*, never as packet-level PFC/ECN behaviour — there is no ASIC buffer model to
  congest. On `frr` there is no PFC at all; the Linux data plane has no equivalent.
  Neither profile can prove lossless behaviour, and no container lab can.
- **PXE boot.** Containers do not PXE boot. The seed serves `boot.ipxe` over TFTP and the
  node agents fetch it to prove that path works; on real hardware it is where the install
  begins.

---

## How it works

### The provisioning sequence

```
device boots with no config
  └─ identifies its OOB port by MAC (02:aa:00:00:00:xx)
  └─ udhcpc → dnsmasq
       ← 10.10.0.31, option 67 = http://10.10.0.10:8080/ztp/ztp.json
  └─ GET ztp.json?mac=…
       ← { hostname: "leaf1", link_map: {...}, configs: [ {url, dest, sha256}, … ] }
  └─ applies link_map      ← names its interfaces per the cable plan
  └─ downloads configs, verifies each digest, installs them
  └─ merges the platform's CoPP defaults
  └─ starts SONiC          ← only now; ordering is load-bearing (see below)
  └─ applies frr.conf, starts LLDP, registers with the seed
```

A MAC that is not in the source of truth gets a 404 and increments an alarm counter. It
does not get a configuration.

### Layout

```
sot/            the source of truth, authored by hand
  fabric.yml      devices, roles, ASNs, loopbacks
  cabling.yml     the rail map — the file that matters
  ipam.yml        OOB, loopback, /31 and rail addressing
  qos.yml         PFC / ECN / scheduler intent
tools/          generators (containerised; no host Python needed)
  netbox_seed.py    YAML → NetBox
  netbox_source.py  NetBox → model
  gen_configs.py    model → golden configs
  gen_topology.py   cable plan → docker-compose.fabric.yml
  gen_seed.py       SoT → dnsmasq reservations, DNS, iPXE
seed/           the seed node's services
nodes/          device images + ZTP agents
  common/         shared ZTP library (DHCP, descriptor fetch, interface naming)
  switch/         sonic-vs profile
  frr/            frr profile
  gpu/            compute nodes (identical in both profiles)
scripts/        verify.py, inject-miscable.py, fetch-sonic-image.ps1
out/artifacts/  rendered golden configs (generated)
```

`docker-compose.fabric.yml` is **generated** from `sot/cabling.yml` — one Docker bridge per
cable, one service per device. Re-cabling the fabric means editing YAML and re-rendering.

---

## Things that were not obvious

Each of these silently broke the fabric while leaving it looking healthy. They are
documented here because they are the interesting part.

**`internal: true` on a Docker network drops the fabric's own traffic.** An internal
network makes Docker install isolation rules that discard IP traffic whose addresses fall
outside the bridge's own subnet. The bridges are addressed 172.30.x/24 purely to satisfy
the driver; the traffic that matters is the fabric's 10.x. ARP still crossed — it is not IP
— so neighbours resolved, interfaces were up, and **nothing else worked**.

**Assigning a MAC to a fabric link endpoint blackholes it.** Docker then pins a static FDB
entry and stops learning on that bridge port. A router sources every frame from one system
MAC across all its ports, so every frame becomes unknown unicast and is dropped. Only the
OOB port carries an assigned MAC, where the container MAC and the frame's source MAC are
the same thing.

**Linux bridges swallow LLDP.** It is addressed to `01:80:c2:00:00:0e`, inside the 802.1D
reserved range a bridge must consume rather than forward. Cabling validation is impossible
until `group_fwd_mask` bit 14 is set on every bridge — and Docker rebuilds the bridges on
every `down`, so `./lab.ps1 up` re-applies it each time.

**Docker Desktop enables `hairpin_mode` on veth ports, which is fatal to L2 forwarding.**
Hairpin reflects a frame back to the sender. A switch that bridges between ports therefore
receives its own flooded frames and floods them again — the FRR fabric hit a broadcast
storm of ~330 000 pps within seconds of coming up, which starved BGP until every session
dropped. Completely harmless for ordinary containers, so nothing warns you. Turned off on
the lab's bridges in the same post-`up` step as the LLDP fix.

**FRR's integrated config must be declared in `vtysh.conf`, not just in `frr.conf`.**
Without `/etc/frr/vtysh.conf`, each daemon looks for its own `/etc/frr/<daemon>.conf`,
finds nothing, and starts with an empty configuration. Everything works until `watchfrr`
restarts `bgpd` — at which point the router comes back with no BGP configuration at all,
no error, and an underlay that quietly stops converging.

**Re-rendering the artifacts broke the seed's HTTP server.** The generator used to
`rmtree` its output directory; that swaps the inode the seed containers are bind-mounted
on, leaving them mounted on the deleted one, and every artifact fetch 404s. It now clears
the directory's *contents* instead, so a re-render never requires restarting the seed.

**Compose `priority` does not determine interface names.** It orders network attachment,
but the OOB network still landed on `eth2`. Since sonic-vs binds container interface N to
`Ethernet(4*(N-1))`, a wrong order silently produces a switch cabled to the wrong things.
Each cable therefore gets its own /24, and the seed tells each device which subnet is which
interface — port layout is assigned by the source of truth, like everything else.

**SONiC derives its port list at startup.** `start.sh` filters `lanemap.ini` and
`port_config.ini` down to the `ethN` interfaces that exist *at that moment*. Every cable
must be attached and named before the NOS starts, which is why the agent holds the NOS back
until DHCP and the link map are done.

**No `bgpcfgd` in the VS image**, so CONFIG_DB BGP tables are never translated into FRR.
Hardware images do that translation; here the seed renders `frr.conf` directly. Both files
come from the same source of truth.

**Without CoPP, a switch answers ARP and nothing else.** The platform's control-plane
policing defaults ship with the NOS image, not the golden config. Absent them the ASIC
installs no IP2ME trap: neighbours resolve, and ping, BGP and management all silently fail.
The agent merges `copp_cfg.json` into `config_db.json` before startup.

**`libsaivs` can kill the virtual ASIC.** Removing a next-hop returns `SAI_STATUS_FAILURE`,
and orchagent responds by aborting `syncd` — so ordinary neighbour ageing can take a switch
down. The agent raises neighbour lifetimes to keep the emulator stable for a lab session;
it is a workaround for the simulator, not a fabric setting anyone should copy. `verify.py`
checks `syncd` liveness first so a crash is reported as a crash.

---

## Verifying

```powershell
./lab.ps1 verify           # 11 sections; profile-aware
./lab.ps1 verify -Quick    # skip reachability and throughput probes
```

A healthy lab reports 135/0/1 on `sonic` and 134/0/1 on `frr`. The suite reads the profile
out of the rendered manifest and runs the checks that profile can actually support —
CONFIG_DB and QoS on `sonic`, bridges and forwarding on `frr` — rather than reporting a
failure for something the platform was never able to do.

Exit code is non-zero on failure, so CI can gate on it; `out/verify-report.json` has the
structured result.

To watch the cabling check earn its keep:

```powershell
./lab.ps1 miscable    # cross gpu01's rail2 and rail3
./lab.ps1 verify      # section 9 names the exact cable, from both ends
./lab.ps1 repair
```

Allow ~2 minutes after either for LLDP's 120-second TTL to clear stale advertisements.

---

## Changing the fabric

Edit `sot/*.yml`, then:

```powershell
./lab.ps1 render      # re-seed NetBox and re-render golden configs
./lab.ps1 down; ./lab.ps1 up
```

Adding a fifth rail means adding a leaf to `fabric.yml`, its cables to `cabling.yml`, and a
rail to `ipam.yml`. The topology, the DHCP reservations, the DNS records, the device
configs and the verification expectations all follow — which is the whole point.
