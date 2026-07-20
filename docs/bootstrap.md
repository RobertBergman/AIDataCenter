# Bootstrap Stack — BOOT Rack & Platform Bring-Up

Companion to [SPEC.md](../SPEC.md) §2A (BOOT rack), §7 (Kubernetes), §6.7 (archive bus), §11 (observability).

**Code:** [bootstrap/](../bootstrap/) · **Interactive walkthrough:** [demo/](../demo/README.md) (browser simulator of this exact process)

---

## 1. Scope

| In scope (BOOT day-1) | Out of scope (later docs) |
| --------------------- | ------------------------- |
| **NetBox** DCIM/IPAM/cabling SoT | Rail RoCE QoS detail → `docs/network.md` |
| Seed host DHCP/DNS/NTP/iPXE (from NetBox) | Hot FS CSI product choice → `docs/storage.md` |
| Metal3 + CAPI bare-metal | Full BOM SKUs → `docs/bom.md` |
| 3-node K8s control plane | Facility elevations → `docs/facility.md` |
| Flux GitOps root | |
| Harbor, Vault, ESO, **NetBox HA** | |
| Prometheus / Grafana / Loki / Alloy | |
| Redpanda inference bus | |
| NVIDIA GPU Operator + Network Operator | |
| KServe (RawDeployment) + KubeRay operator | |

---

## 2. Physical placement (BOOT)

| RU role | Qty | Notes |
| ------- | --: | ----- |
| seed01 (bootstrap utility) | 1 | First boot; may later become util or stay out-of-band |
| Control plane cp01–cp03 | 3 | 32c / 256 GB / NVMe (SPEC §7.1) |
| Utility util01–03 | 3 | Harbor etcd/DB, Vault raft, Redpanda, Loki backends if not on STOR |
| Spines 7060DX5-64S | 2 | Prefer BOOT (SPEC §2A) |
| Console / jump | 1 | |

GPU workers **never** share BOOT power domain.

---

## 3. Logical architecture

```
 Phase −1              Phase 0                 Phase 1                Phase 2–3
 ┌──────────┐        ┌────────────┐        ┌──────────────────┐   ┌─────────────────┐
 │ NetBox   │───────►│ seed01     │───────►│ Metal3 + CAPI    │──►│ Flux platform/* │
 │ DCIM/IPAM│ export │ dnsmasq    │ Redfish│ BareMetalHost    │   │ + NetBox HA     │
 │ cabling  │ inv    │ chrony/iPXE│        │ cp×3 + gpu×8     │   │ Harbor/Vault/…  │
 └──────────┘        └────────────┘        └──────────────────┘   └─────────────────┘
```

See [docs/netbox.md](netbox.md) and [docs/cabling.md](cabling.md).
**Management cluster:** `clusterctl` runs against a small k3s (or existing) on seed01. Workload cluster `ai-cluster` is the production plane; move CAPI management to a dedicated util node after day-1 if desired.

---

## 4. Addressing (defaults)

**IPAM lives in NetBox.** Generated snapshot: `bootstrap/inventory/ipam.yaml`.  
Device inventory snapshot: `bootstrap/inventory/cluster.yaml` (**GENERATED** — `bash bootstrap/scripts/netbox-sync.sh`).

| Plane | CIDR | Example |
| ----- | ---- | ------- |
| Mgmt | 10.10.0.0/24 | seed 10.10.0.10, API VIP 10.10.0.20 |
| OOB/BMC | 10.20.0.0/24 | via 7010TX-48 |
| Pod | 10.244.0.0/16 | |
| Service | 10.96.0.0/12 | |

Domain default: `ai.local` (replace with enterprise DNS).
---

## 5. Procedure

### 5.1 Prerequisites

- Ubuntu 24.04 on seed01, dual-homed to mgmt + reachability to OOB
- Operator workstation: `kubectl`, `clusterctl`, `flux`, `yq`, `jq`
- BMC Redfish on all servers; credentials via env (`BMC_USERNAME`, `BMC_PASSWORD`)
- Ubuntu 24.04 cloud image + Ironic IPA assets under `http://seed/images/`
- Git remote for this monorepo (update `GitRepository` URL)

### 5.2 Commands

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

### 5.3 Flux reconcile order

1. `platform-core` — cert-manager, node policy  
2. `platform-security` — Vault HA + External Secrets  
3. `platform-netbox` — production NetBox (DCIM/IPAM SoT)  
4. `platform-registry` — Harbor  
5. `platform-observability` — kube-prometheus-stack, Loki, Alloy  
6. `platform-bus` — Redpanda + inference topics  
7. `platform-gpu` — GPU Operator, Network Operator, RuntimeClass  
8. `platform-serving` — KServe, KubeRay, `models-rwx` PVC stub  

---

## 6. GPU path notes

- Worker Machines taint `nvidia.com/gpu=true:NoSchedule` until GPU Operator labels capacity.
- Network Operator deploys OFED + RDMA device plugin; **per-rail** `SriovNetworkNodePolicy` is site-specific (8× ConnectX-7/BF3) — finalize in `docs/network.md`.
- NCCL defaults ConfigMap in `platform/apps/gpu` — set `NCCL_IB_HCA` after device names stabilize.
- Do **not** bake multi-TB weights into images; mount `models-rwx` (SPEC §6.6).

---

## 7. Security baseline

| Control | Implementation |
| ------- | -------------- |
| Secrets | Vault raft HA; apps via External Secrets |
| Registry | Harbor + TLS; mirror NGC/vLLM images |
| Bootstrap secrets | BMC creds only in env → generated Secret (not git) |
| API | Control plane audit logs on; cert-manager issuers |
| Tenancy later | Gatekeeper/Kyverno + namespaces per team |

Rotate `harborAdminPassword` / Grafana admin on first login.

---

## 8. Inference archive integration

Redpanda topics (`inference.records`, DLQ, tombstones) buffer async capture before Parquet → object lake (SPEC §6.7). Compactor Deployments join when STOR S3 endpoint exists.

---

## 9. Acceptance criteria

- [ ] seed DHCP/DNS answers for all inventory hosts  
- [ ] NetBox export = live inventory; cabling 64+64+BMC  
- [ ] 3 CP nodes Ready; API VIP serves `6443`  
- [ ] 8 GPU workers Ready; `nvidia.com/gpu` Capacity = 8 each (64 total)  
- [ ] DCGM exporter scraped by Prometheus  
- [ ] Harbor push/pull from GPU node  
- [ ] Vault unsealed / raft peers = 3  
- [ ] Redpanda Kafka API reachable from inference namespace  
- [ ] Example InferenceService applies (weights optional for dry-run)  

---

## 10. Failure / recovery

| Event | Action |
| ----- | ------ |
| seed01 loss | Static leases + images should be mirrored to util01; rebuild from scripts |
| Single CP loss | etcd quorum remains; replace BareMetalHost |
| Flux drift | `flux reconcile ks platform-gpu --with-source` |
| GPU driver break | GPU Operator operands reconcile; drain one rack leaf pair at a time |

---

## 11. Next documents

0. [docs/build-guide.md](build-guide.md) — **physical build first** (rack, power, cable, switch/server bring-up, burn-in)
1. `docs/network.md` — EOS RoCE, EVPN, rail SR-IOV (consume NetBox IPAM)  
2. `docs/storage.md` — CSI for `models-rwx` + RGW lake  
3. `docs/k8s.md` — day-2 ops, upgrades, multi-tenancy  
4. `docs/bom.md` — exact BOOT server SKUs  

---

## Revision

| Version | Date | Notes |
| ------- | ---- | ----- |
| 0.1 | 2026-07-18 | Initial bootstrap stack |
