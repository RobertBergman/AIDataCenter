// GENERATED from docs/bootstrap.md — do not edit. Regenerate: python3 docs/md2pdf.py
#import "../docs/template.typ": *
#show: doc.with(title: "Bootstrap Stack — BOOT Rack & Platform Bring-Up", kicker: "AIDATACENTER — BOOTSTRAP STACK", rev: "0.1 · 2026-07-18")

Companion to #link("../SPEC.pdf")[SPEC.md] §2A (BOOT rack), §7
(Kubernetes), §6.7 (archive bus), §11 (observability).

#strong[Code:] #link("../bootstrap/")[bootstrap/] · #strong[Interactive
walkthrough:] #link("../demo/README.pdf")[demo/] (browser simulator of
this exact process)

#horizontalrule

= Scope
<scope>
#figure(
  align(center)[#table(
    columns: (45.65%, 54.35%),
    align: (auto,auto,),
    table.header([In scope (BOOT day-1)], [Out of scope (later docs)],),
    table.hline(),
    [#strong[NetBox] DCIM/IPAM/cabling SoT], [Rail RoCE QoS detail →
    `docs/network.md`],
    [Seed host DHCP/DNS/NTP/iPXE (from NetBox)], [Hot FS CSI product
    choice → `docs/storage.md`],
    [Metal3 + CAPI bare-metal], [Full BOM SKUs → `docs/bom.md`],
    [3-node K8s control plane], [Facility elevations →
    `docs/facility.md`],
    [Flux GitOps root], [],
    [Harbor, Vault, ESO, #strong[NetBox HA]], [],
    [Prometheus / Grafana / Loki / Alloy], [],
    [Redpanda inference bus], [],
    [NVIDIA GPU Operator + Network Operator], [],
    [KServe (RawDeployment) + KubeRay operator], [],
  )]
  , kind: table
  )

#horizontalrule

= Physical placement (BOOT)
<physical-placement-boot>
#figure(
  align(center)[#table(
    columns: (46.67%, 20%, 33.33%),
    align: (auto,right,auto,),
    table.header([RU role], [Qty], [Notes],),
    table.hline(),
    [seed01 (bootstrap utility)], [1], [First boot; may later become
    util or stay out-of-band],
    [Control plane cp01--cp03], [3], [32c / 256 GB / NVMe (SPEC §7.1)],
    [Utility util01--03], [3], [Harbor etcd/DB, Vault raft, Redpanda,
    Loki backends if not on STOR],
    [Spines 7060DX5-64S], [2], [Prefer BOOT (SPEC §2A)],
    [Console / jump], [1], [],
  )]
  , kind: table
  )

GPU workers #strong[never] share BOOT power domain.

#horizontalrule

= Logical architecture
<logical-architecture>
```
 Phase −1              Phase 0                 Phase 1                Phase 2–3
 ┌──────────┐        ┌────────────┐        ┌──────────────────┐   ┌─────────────────┐
 │ NetBox   │───────►│ seed01     │───────►│ Metal3 + CAPI    │──►│ Flux platform/* │
 │ DCIM/IPAM│ export │ dnsmasq    │ Redfish│ BareMetalHost    │   │ + NetBox HA     │
 │ cabling  │ inv    │ chrony/iPXE│        │ cp×3 + gpu×8     │   │ Harbor/Vault/…  │
 └──────────┘        └────────────┘        └──────────────────┘   └─────────────────┘
```

See #link("netbox.pdf")[docs/netbox.md] and
#link("cabling.pdf")[docs/cabling.md]. #strong[Management cluster:]
`clusterctl` runs against a small k3s (or existing) on seed01. Workload
cluster `ai-cluster` is the production plane; move CAPI management to a
dedicated util node after day-1 if desired.

#horizontalrule

= Addressing (defaults)
<addressing-defaults>
#strong[IPAM lives in NetBox.] Generated snapshot:
`bootstrap/inventory/ipam.yaml`. \
Device inventory snapshot: `bootstrap/inventory/cluster.yaml`
(#strong[GENERATED] --- `bash bootstrap/scripts/netbox-sync.sh`).

#figure(
  align(center)[#table(
    columns: 3,
    align: (auto,auto,auto,),
    table.header([Plane], [CIDR], [Example],),
    table.hline(),
    [Mgmt], [10.10.0.0/24], [seed 10.10.0.10, API VIP 10.10.0.20],
    [OOB/BMC], [10.20.0.0/24], [via 7010TX-48],
    [Pod], [10.244.0.0/16], [],
    [Service], [10.96.0.0/12], [],
  )]
  , kind: table
  )

== Domain default: `ai.local` (replace with enterprise DNS).
<domain-default-ai.local-replace-with-enterprise-dns.>
= Procedure
<procedure>
== Prerequisites
<prerequisites>
- Ubuntu 24.04 on seed01, dual-homed to mgmt + reachability to OOB
- Operator workstation: `kubectl`, `clusterctl`, `flux`, `yq`, `jq`
- BMC Redfish on all servers; credentials via env (`BMC_USERNAME`,
  `BMC_PASSWORD`)
- Ubuntu 24.04 cloud image + Ironic IPA assets under
  `http://seed/images/`
- Git remote for this monorepo (update `GitRepository` URL)

== Commands
<commands>
```bash
# seed01 — NetBox SoT first
cd bootstrap/netbox && docker compose up -d
export NETBOX_URL=http://127.0.0.1:8081
export NETBOX_TOKEN=$(bash scripts/create_token.sh)
python3 scripts/import_seed.py
bash ../scripts/netbox-sync.sh

cd ..
sudo bash scripts/00-seed-host.sh

# install k3s on seed for CAPI mgmt (example)
curl -sfL https://get.k3s.io | sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

bash scripts/01-install-capi-metal3.sh
export BMC_USERNAME=... BMC_PASSWORD=...
bash scripts/02-apply-cluster.sh

# wait Ready
clusterctl describe cluster ai-cluster -n metal3
clusterctl get kubeconfig ai-cluster -n metal3 > ../kubeconfig-ai-cluster
export KUBECONFIG=$PWD/../kubeconfig-ai-cluster

# CNI: install Cilium or Calico before Nodes Ready if not in Machine bootstrap
# e.g. cilium install

GIT_URL=https://git.example.com/org/super.git bash scripts/03-install-flux.sh
bash scripts/04-smoke.sh
```

== Flux reconcile order
<flux-reconcile-order>
+ `platform-core` --- cert-manager, node policy \
+ `platform-security` --- Vault HA + External Secrets \
+ `platform-netbox` --- production NetBox (DCIM/IPAM SoT) \
+ `platform-registry` --- Harbor \
+ `platform-observability` --- kube-prometheus-stack, Loki, Alloy \
+ `platform-bus` --- Redpanda + inference topics \
+ `platform-gpu` --- GPU Operator, Network Operator, RuntimeClass \
+ `platform-serving` --- KServe, KubeRay, `models-rwx` PVC stub

#horizontalrule

= GPU path notes
<gpu-path-notes>
- Worker Machines taint `nvidia.com/gpu=true:NoSchedule` until GPU
  Operator labels capacity.
- Network Operator deploys OFED + RDMA device plugin; #strong[per-rail]
  `SriovNetworkNodePolicy` is site-specific (8× ConnectX-7/BF3) ---
  finalize in `docs/network.md`.
- NCCL defaults ConfigMap in `platform/apps/gpu` --- set `NCCL_IB_HCA`
  after device names stabilize.
- Do #strong[not] bake multi-TB weights into images; mount `models-rwx`
  (SPEC §6.6).

#horizontalrule

= Security baseline
<security-baseline>
#figure(
  align(center)[#table(
    columns: (33.33%, 66.67%),
    align: (auto,auto,),
    table.header([Control], [Implementation],),
    table.hline(),
    [Secrets], [Vault raft HA; apps via External Secrets],
    [Registry], [Harbor + TLS; mirror NGC/vLLM images],
    [Bootstrap secrets], [BMC creds only in env → generated Secret (not
    git)],
    [API], [Control plane audit logs on; cert-manager issuers],
    [Tenancy later], [Gatekeeper/Kyverno + namespaces per team],
  )]
  , kind: table
  )

Rotate `harborAdminPassword` / Grafana admin on first login.

#horizontalrule

= Inference archive integration
<inference-archive-integration>
Redpanda topics (`inference.records`, DLQ, tombstones) buffer async
capture before Parquet → object lake (SPEC §6.7). Compactor Deployments
join when STOR S3 endpoint exists.

#horizontalrule

= Acceptance criteria
<acceptance-criteria>
- ☐ seed DHCP/DNS answers for all inventory hosts \
- ☐ NetBox export = live inventory; cabling 64+64+BMC \
- ☐ 3 CP nodes Ready; API VIP serves `6443` \
- ☐ 8 GPU workers Ready; `nvidia.com/gpu` Capacity = 8 each (64 total) \
- ☐ DCGM exporter scraped by Prometheus \
- ☐ Harbor push/pull from GPU node \
- ☐ Vault unsealed / raft peers = 3 \
- ☐ Redpanda Kafka API reachable from inference namespace \
- ☐ Example InferenceService applies (weights optional for dry-run)

#horizontalrule

= Failure / recovery
<failure-recovery>
#figure(
  align(center)[#table(
    columns: (45.45%, 54.55%),
    align: (auto,auto,),
    table.header([Event], [Action],),
    table.hline(),
    [seed01 loss], [Static leases + images should be mirrored to util01;
    rebuild from scripts],
    [Single CP loss], [etcd quorum remains; replace BareMetalHost],
    [Flux drift], [`flux reconcile ks platform-gpu --with-source`],
    [GPU driver break], [GPU Operator operands reconcile; drain one rack
    leaf pair at a time],
  )]
  , kind: table
  )

#horizontalrule

= Next documents
<next-documents>
#block[
#set enum(numbering: "1.", start: 0)
+ #link("build-guide.pdf")[docs/build-guide.md] --- #strong[physical
  build first] (rack, power, cable, switch/server bring-up, burn-in)
+ `docs/network.md` --- EOS RoCE, EVPN, rail SR-IOV (consume NetBox
  IPAM) \
+ `docs/storage.md` --- CSI for `models-rwx` + RGW lake \
+ `docs/k8s.md` --- day-2 ops, upgrades, multi-tenancy \
+ `docs/bom.md` --- exact BOOT server SKUs
]

#horizontalrule

= Revision
<revision>
#figure(
  align(center)[#table(
    columns: 3,
    align: (auto,auto,auto,),
    table.header([Version], [Date], [Notes],),
    table.hline(),
    [0.1], [2026-07-18], [Initial bootstrap stack],
  )]
  , kind: table
  )

