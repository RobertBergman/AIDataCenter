# AI Cluster Bootstrap Stack

BOOT-rack platform for the 64× B200 inference cluster ([SPEC.md](../SPEC.md) §2A, §7).

## Layers

| Phase | What | Where |
| ----- | ---- | ----- |
| **−1 — SoT** | **NetBox** DCIM/IPAM/cabling (seed Docker → later K8s) | `netbox/` |
| **0 — Seed** | DHCP, DNS, NTP, iPXE (leases from NetBox export) | `seed/` |
| **1 — Bare metal** | Metal3 + Cluster API → 3 CP + 8 GPU workers | `capi/` |
| **2 — GitOps root** | Flux installs platform from this repo | `platform/` |
| **3 — Platform** | NetBox HA, Registry, Vault, obs, Redpanda, GPU Operator | `platform/apps/` |

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

## Quick start (order of operations)

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

Full procedure: [docs/bootstrap.md](../docs/bootstrap.md) · NetBox: [docs/netbox.md](../docs/netbox.md) · Cabling: [docs/cabling.md](../docs/cabling.md).

## Inventory (generated)

**Do not edit** [inventory/cluster.yaml](inventory/cluster.yaml) — export from NetBox:

```bash
bash scripts/netbox-sync.sh          # live API
bash scripts/netbox-sync.sh --offline  # from netbox/seed/site.yaml
```

## Design choices

| Decision | Choice | Rationale |
| -------- | ------ | --------- |
| Source of truth | **NetBox** DCIM/IPAM/cables | Single ops DB for inventory, IPAM, cabling guide |
| Provisioning | **Metal3 + Cluster API** | Matches SPEC Metal3/MAAS path; pure K8s, no MAAS ISAM lock-in |
| OS (CP + utility) | **Ubuntu 24.04** (Ironic image) | Drivers, GPU Operator, enterprise familiarity |
| OS (GPU) | Ubuntu 24.04 + GPU Operator host driver | NVIDIA DCGM / cuda-compat path |
| GitOps | **Flux v2** | Pull-based, multi-tenancy later |
| Secrets | **Vault + External Secrets** | BOOT rack duty per SPEC |
| Registry | **Harbor** | Air-gapped / mirror for GPU images |
| Observability | kube-prometheus-stack + Loki + Alloy | SPEC §11 |
| Bus | **Redpanda** (3 replicas on BOOT/util) | Inference archive buffer SPEC §6.7 |

## Directory map

```
bootstrap/
  netbox/             # SoT: docker day-0, seed/site.yaml, import/export scripts
  inventory/          # GENERATED from NetBox (cluster.yaml, ipam.yaml)
  seed/               # pre-K8s host config (dnsmasq, matchbox, chrony)
  capi/               # Cluster API Cluster, KubeadmControlPlane, Metal3MachineTemplate
  platform/           # Flux kustomizations + HelmReleases (includes netbox HA)
  scripts/            # ordered operator scripts + netbox-sync.sh
```
