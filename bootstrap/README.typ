// GENERATED from bootstrap/README.md — do not edit. Regenerate: python3 docs/md2pdf.py
#import "../docs/template.typ": *
#show: doc.with(title: "AI Cluster Bootstrap Stack", kicker: "AIDATACENTER — BOOTSTRAP STACK", rev: "2026-07-18")

BOOT-rack platform for the 64× B200 inference cluster
(#link("../SPEC.pdf")[SPEC.md] §2A, §7).

= Layers
<layers>
#figure(
  align(center)[#table(
    columns: (35.71%, 28.57%, 35.71%),
    align: (auto,auto,auto,),
    table.header([Phase], [What], [Where],),
    table.hline(),
    [#strong[−1 --- SoT]], [#strong[NetBox] DCIM/IPAM/cabling (seed
    Docker → later K8s)], [`netbox/`],
    [#strong[0 --- Seed]], [DHCP, DNS, NTP, iPXE (leases from NetBox
    export)], [`seed/`],
    [#strong[1 --- Bare metal]], [Metal3 + Cluster API → 3 CP + 8 GPU
    workers], [`capi/`],
    [#strong[2 --- GitOps root]], [Flux installs platform from this
    repo], [`platform/`],
    [#strong[3 --- Platform]], [NetBox HA, Registry, Vault, obs,
    Redpanda, GPU Operator], [`platform/apps/`],
  )]
  , kind: table
  )

```
 BOOT rack
 ┌──────────────────────────────────────────────────────────┐
 │  seed01          cp01..cp03           hub / utility      │
 │  (dnsmasq,       (etcd + API)         (Harbor, Vault,    │
 │   matchbox,                           Flux source)       │
 │   ironic)                                                │
 │  spines 7060DX5-64S ×2                                   │
 └──────────────────────────────────────────────────────────┘
          │ mgmt + fabric
          ▼
 GPU-1 / GPU-2 workers (worker01..08 × 8 B200)
```

= Quick start (order of operations)
<quick-start-order-of-operations>
```bash
# NetBox SoT (seed Docker) — or offline from seed/site.yaml
cd netbox && cp env.example .env && docker compose up -d
export NETBOX_URL=http://127.0.0.1:8081
export NETBOX_TOKEN=$(bash scripts/create_token.sh)
pip install -r requirements.txt && python3 scripts/import_seed.py
bash ../scripts/netbox-sync.sh
# offline alternative: bash scripts/netbox-sync.sh --offline

# On seed host (Ubuntu 24.04 LTS, BOOT rack)
sudo bash scripts/00-seed-host.sh

# From operator workstation with kubeconfig to seed/management cluster
bash scripts/01-install-capi-metal3.sh
BMC_USERNAME=… BMC_PASSWORD=… bash scripts/02-apply-cluster.sh
bash scripts/03-install-flux.sh   # after CP is Ready
```

Full procedure: #link("../docs/bootstrap.pdf")[docs/bootstrap.md] ·
NetBox: #link("../docs/netbox.pdf")[docs/netbox.md] · Cabling:
#link("../docs/cabling.pdf")[docs/cabling.md].

= Inventory (generated)
<inventory-generated>
#strong[Do not edit] #link("inventory/cluster.yaml") --- export from
NetBox:

```bash
bash scripts/netbox-sync.sh          # live API
bash scripts/netbox-sync.sh --offline  # from netbox/seed/site.yaml
```

= Design choices
<design-choices>
#figure(
  align(center)[#table(
    columns: (34.78%, 26.09%, 39.13%),
    align: (auto,auto,auto,),
    table.header([Decision], [Choice], [Rationale],),
    table.hline(),
    [Source of truth], [#strong[NetBox] DCIM/IPAM/cables], [Single ops
    DB for inventory, IPAM, cabling guide],
    [Provisioning], [#strong[Metal3 + Cluster API]], [Matches SPEC
    Metal3/MAAS path; pure K8s, no MAAS ISAM lock-in],
    [OS (CP + utility)], [#strong[Ubuntu 24.04] (Ironic
    image)], [Drivers, GPU Operator, enterprise familiarity],
    [OS (GPU)], [Ubuntu 24.04 + GPU Operator host driver], [NVIDIA DCGM
    \/ cuda-compat path],
    [GitOps], [#strong[Flux v2]], [Pull-based, multi-tenancy later],
    [Secrets], [#strong[Vault + External Secrets]], [BOOT rack duty per
    SPEC],
    [Registry], [#strong[Harbor]], [Air-gapped / mirror for GPU images],
    [Observability], [kube-prometheus-stack + Loki + Alloy], [SPEC §11],
    [Bus], [#strong[Redpanda] (3 replicas on BOOT/util)], [Inference
    archive buffer SPEC §6.7],
  )]
  , kind: table
  )

= Directory map
<directory-map>
```
bootstrap/
  netbox/             # SoT: docker day-0, seed/site.yaml, import/export scripts
  inventory/          # GENERATED from NetBox (cluster.yaml, ipam.yaml)
  seed/               # pre-K8s host config (dnsmasq, matchbox, chrony)
  capi/               # Cluster API Cluster, KubeadmControlPlane, Metal3MachineTemplate
  platform/           # Flux kustomizations + HelmReleases (includes netbox HA)
  scripts/            # ordered operator scripts + netbox-sync.sh
```

