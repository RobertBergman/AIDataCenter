// GENERATED from README.md — do not edit. Regenerate: python3 docs/md2pdf.py
#import "docs/template.typ": *
#show: doc.with(title: "AIDataCenter", kicker: "AIDATACENTER — OVERVIEW", rev: "2026-07-18")

Specification and bootstrap stack for a #strong[64× NVIDIA B200]
research AI inference cluster.

= Contents
<contents>
#figure(
  align(center)[#table(
    columns: (26.67%, 73.33%),
    align: (auto,auto,),
    table.header([Path], [Description],),
    table.hline(),
    [#link("SPEC.pdf")[SPEC.md]], [Full facility / fabric / storage /
    K8s design],
    [#link("docs/")], [Build guide, network (ZTP/RoCE), overlay
    (EVPN/VXLAN), serving (Kimi K2 + API), bootstrap, NetBox SoT,
    cabling guide],
    [#link("bootstrap/")], [Seed host, Metal3/CAPI, Flux platform,
    NetBox],
    [#link("demo/")], [Interactive live bring-up simulator (browser)],
  )]
  , kind: table
  )

= Highlights
<highlights>
- #strong[4 racks:] GPU-1, GPU-2, BOOT, STOR \
- #strong[Fabric:] Arista 7060DX5 rail-optimized 8×400G/node (RoCEv2) \
- #strong[OOB:] Arista 7010TX-48 \
- #strong[Platform:] Kubernetes + NVIDIA GPU Operator + KServe + Ray \
- #strong[Serving:] Kimi K2 Thinking (TP=8 × replicas) behind Envoy
  gateway + inference scheduler
  (#link("docs/serving.pdf")[docs/serving.md]) \
- #strong[Overlay:] EVPN/VXLAN --- vrf `storage` + vrf `edge` for API
  ingress (#link("docs/overlay.pdf")[docs/overlay.md]) \
- #strong[Source of truth:] #link("docs/netbox.pdf")[NetBox] for
  inventory, IPAM, and cabling \
- #strong[GitOps:] Flux-managed platform apps (Harbor, Vault,
  observability, Redpanda, …)

= Quick start
<quick-start>
```bash
# Interactive demo (simulated bootstrap → switches → GPU cluster)
python3 -m http.server 8765 --directory demo
# open http://127.0.0.1:8765

# Design-time inventory + cabling (no hardware required)
bash bootstrap/scripts/netbox-sync.sh --offline

# Physical build: docs/build-guide.md → then docs/bootstrap.md + bootstrap/README.md
```

= Documentation (PDF)
<documentation-pdf>
Every Markdown doc has a Typst twin + compiled PDF next to it
(e.g.~`docs/build-guide.typ` → `docs/build-guide.pdf`, `README.pdf`).
Regenerate all after editing any `.md` source:

```bash
pip install pypandoc-binary   # plus typst CLI on PATH
python3 docs/md2pdf.py        # or: python3 docs/md2pdf.py docs/build-guide.md
```

Styling is shared via #link("docs/template.typ")\; generated `.typ`
files are overwritten on each run --- edit the `.md` or the template,
not the generated output.

= License
<license>
Add a license before production use. Content is provided as-is for
design and operations planning.

