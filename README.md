# AIDataCenter

Specification and bootstrap stack for a **64× NVIDIA B200** research AI inference cluster.

## Contents

| Path | Description |
| ---- | ----------- |
| [SPEC.md](SPEC.md) | Full facility / fabric / storage / K8s design |
| [docs/](docs/) | Bootstrap, NetBox SoT, cabling guide |
| [bootstrap/](bootstrap/) | Seed host, Metal3/CAPI, Flux platform, NetBox |

## Highlights

- **4 racks:** GPU-1, GPU-2, BOOT, STOR  
- **Fabric:** Arista 7060DX5 rail-optimized 8×400G/node (RoCEv2)  
- **OOB:** Arista 7010TX-48  
- **Platform:** Kubernetes + NVIDIA GPU Operator + KServe + Ray  
- **Source of truth:** [NetBox](docs/netbox.md) for inventory, IPAM, and cabling  
- **GitOps:** Flux-managed platform apps (Harbor, Vault, observability, Redpanda, …)

## Quick start

```bash
# Design-time inventory + cabling (no hardware required)
bash bootstrap/scripts/netbox-sync.sh --offline

# Full bring-up: see docs/bootstrap.md and bootstrap/README.md
```

## License

Add a license before production use. Content is provided as-is for design and operations planning.
