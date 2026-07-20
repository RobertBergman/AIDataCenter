# AIDataCenter

Specification and bootstrap stack for a **64× NVIDIA B200** research AI inference cluster.

## Contents

| Path | Description |
| ---- | ----------- |
| [SPEC.md](SPEC.md) | Full facility / fabric / storage / K8s design |
| [docs/](docs/) | Build guide, network (ZTP/RoCE), overlay (EVPN/VXLAN), serving (Kimi K2 + API), bootstrap, NetBox SoT, cabling guide |
| [bootstrap/](bootstrap/) | Seed host, Metal3/CAPI, Flux platform, NetBox |
| [demo/](demo/) | Interactive live bring-up simulator (browser) |

## Highlights

- **4 racks:** GPU-1, GPU-2, BOOT, STOR  
- **Fabric:** Arista 7060DX5 rail-optimized 8×400G/node (RoCEv2)  
- **OOB:** Arista 7010TX-48  
- **Platform:** Kubernetes + NVIDIA GPU Operator + KServe + Ray  
- **Serving:** Kimi K2 Thinking (TP=8 × replicas) behind Envoy gateway + inference scheduler ([docs/serving.md](docs/serving.md))  
- **Overlay:** EVPN/VXLAN — vrf `storage` + vrf `edge` for API ingress ([docs/overlay.md](docs/overlay.md))  
- **Source of truth:** [NetBox](docs/netbox.md) for inventory, IPAM, and cabling  
- **GitOps:** Flux-managed platform apps (Harbor, Vault, observability, Redpanda, …)

## Quick start

```bash
# Interactive demo (simulated bootstrap → switches → GPU cluster)
python3 -m http.server 8765 --directory demo
# open http://127.0.0.1:8765

# Design-time inventory + cabling (no hardware required)
bash bootstrap/scripts/netbox-sync.sh --offline

# Physical build: docs/build-guide.md → then docs/bootstrap.md + bootstrap/README.md
```

## Documentation (PDF)

Every Markdown doc has a Typst twin + compiled PDF next to it (e.g. `docs/build-guide.typ` → `docs/build-guide.pdf`, `README.pdf`).
Regenerate all after editing any `.md` source:

```bash
pip install pypandoc-binary   # plus typst CLI on PATH
python3 docs/md2pdf.py        # or: python3 docs/md2pdf.py docs/build-guide.md
```

Styling is shared via [docs/template.typ](docs/template.typ); generated `.typ` files are overwritten on each run — edit the `.md` or the template, not the generated output.

## License

Add a license before production use. Content is provided as-is for design and operations planning.
