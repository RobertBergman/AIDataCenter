#import "lib.typ": *

= The Host Is Part of the Network: NICs, Drivers, NUMA, and PCIe

In enterprise networking the demarcation is the switchport. In AI infrastructure the
network engineer's domain extends through the NIC firmware, the Linux RDMA stack, the PCIe
topology, and up to the GPU's doorstep — because a fabric-perfect packet that dies on a
mis-tuned host still stalls the job, and the ticket still says "network."

== The hardware and software stack

A GPU server (e.g., HGX class) pairs each GPU with a dedicated RDMA NIC — NVIDIA
ConnectX-7/ConnectX-8 (or BlueField DPUs, which add Arm cores and offloads on top of the
same ConnectX silicon). The Linux-side stack, top to bottom:

- Application / framework → NCCL → *verbs* (`libibverbs`, from `rdma-core`)
- Provider driver (`mlx5` kernel modules), NIC firmware
- *DOCA-OFED / MLNX_OFED* (NVIDIA's packaged stack) versus inbox/upstream `rdma-core` — version and firmware compatibility across driver, firmware, NCCL, and CUDA is a real operational matrix; "works on this kernel/firmware combo" is checked, not assumed.
- `nvidia-peermem` or kernel DMA-BUF for GPUDirect RDMA.

== The toolbox — commands and what each tells you

#table(
  columns: (1.05fr, 2fr),
  table.header([*Tool*], [*What you use it for*]),
  [`ibstat` / `ibstatus`], [Adapter state, port state (Active/Down), rate, LID (IB), link layer (IB vs Ethernet)],
  [`ibv_devinfo`], [Verbs-level device view: ports, MTU, GUIDs — confirms RDMA is actually usable, not just link-up],
  [`ibdiagnet`], [IB fabric-wide diagnostic sweep: topology, errors, speed mismatches (IB clusters)],
  [`mlxconfig`], [NIC firmware configuration: port mode (IB/ETH), SR-IOV enable and VF count, RoCE options, PCIe settings — changes persist across reboots and differ from runtime config],
  [`mlxlink`], [The layer-1 microscope on the NIC side: link state, speed, FEC mode, per-lane FEC/BER counters, eye margins, module DOM — your first stop for suspected marginal cable/optic],
  [`ethtool -S` / `-i` / `--show-fec`], [Driver/firmware versions, ring settings, and the crucial per-NIC counter set (below)],
  [`devlink` (health, params, port)], [Modern kernel interface for NIC health reporters, firmware params, eswitch mode],
  [`rdma` (from iproute2) / `rdma stat`], [RDMA device/link state and protocol counters without vendor tools],
  [`perftest` suite (`ib_write_bw`, `ib_read_bw`, `ib_send_lat`…)], [Raw RDMA bandwidth/latency between two hosts — isolates fabric+NIC from NCCL and the application; your baseline and bisection tool],
  [`nccl-tests` (`all_reduce_perf` …)], [End-to-end collective performance as the workload sees it — the acceptance test],
  [`nvidia-smi topo -m`], [GPU/NIC PCIe affinity matrix — the NUMA/GPUDirect placement truth table],
  [`lspci -tv`, `lstopo` (hwloc)], [PCIe tree and NUMA layout; verify link width/speed (`LnkSta`) — a Gen5 x16 NIC trained at x8 is a silent half-bandwidth straggler],
  [`numactl`, `taskset`], [Pin benchmarks and daemons to the NUMA node local to the NIC under test],
)

Counters worth knowing by name (from `ethtool -S` on mlx5): `rx_prio3_pause` /
`tx_prio3_pause` (PFC activity per priority), `np_cnp_sent` / `rp_cnp_handled` (DCQCN loop
health from receive and transmit side), `out_of_sequence`, `packet_seq_err`,
`local_ack_timeout_err` (loss/retransmission symptoms on RC QPs), `rx_discards_phy`
(host not draining fast enough). These NIC counters plus switch counters bracket any problem
between "fabric" and "host."

== NUMA locality and PCIe topology

A dual-socket GPU server is really *two computers sharing sheet metal*. Every high-speed
device hangs off a specific socket's PCIe root complex; crossing sockets means traversing the
inter-CPU link (UPI/xGMI) — added latency, contention, and bandwidth ceilings.

Rules of the road:

- *GPU and its NIC must share PCIe locality* — same root complex, ideally the same PCIe switch. `nvidia-smi topo -m` legend: PIX (same switch) and PXB (same root complex, through switches) are good for GPUDirect; PHB, NODE, and SYS mean the path crosses the root complex or sockets — expect degraded peer-to-peer.
- *PCIe bandwidth budget:* Gen5 x16 is ~63 GB/s raw — comfortably feeding a 400G NIC (50 GB/s); at 800G (ConnectX-8 class), PCIe Gen6 or wider host interfaces come into play. A slot mis-trained to x8, a riser problem, or a Gen4 negotiation silently halves this — check `LnkSta` versus `LnkCap` in `lspci -vv`.
- *ACS/IOMMU pitfalls:* PCIe Access Control Services on switches force peer-to-peer TLPs up through the root complex for isolation — killing GPUDirect P2P bandwidth. Platform tuning (disabling ACS where the trust model allows, correct IOMMU settings) is a standard build step; virtualized/multi-tenant designs need ATS-aware alternatives.
- *IRQ affinity:* steer NIC interrupt vectors to cores on the NIC-local NUMA node (`mlnx_tune` / `set_irq_affinity.sh` or manual `/proc/irq` maps). Completion processing on far-socket cores adds tail latency to every operation.
- *Housekeeping:* hugepages for pinned buffers/DPDK-style workloads, disabling deep C-states/frequency scaling on latency-critical cores, and keeping data-loading traffic (front-end NIC) off the rails.

== SR-IOV and multi-tenancy

*SR-IOV* carves one physical NIC into virtual functions (VFs) with hardware-level isolation —
the basis for giving containers/VMs direct RDMA access without a hypervisor in the data path.
Enabled in firmware via `mlxconfig` (`SRIOV_EN`, `NUM_OF_VFS`), consumed in Kubernetes through
the SR-IOV device plugin (Chapter 9). BlueField DPUs extend this model: the DPU owns the
network stack (OVN/OVS offload, storage emulation, isolation) and presents clean interfaces to
an untrusted host — increasingly common in multi-tenant AI clouds.

== A host-side triage playbook

A concrete sequence you can narrate in an interview when "one server is slow":

+ `nvidia-smi topo -m` — are GPU-NIC pairings PIX/PXB as designed?
+ `lspci -vv` (`LnkSta`) — every NIC and GPU trained at full width/generation?
+ `ethtool -i` / `ofed_info -s` / firmware — do driver/firmware/NCCL versions match the qualified matrix?
+ `mlxlink -d <dev> -m -c` — per-lane FEC and DOM on the suspect port: is layer 1 clean?
+ `ethtool -S` — pause counters exploding? `out_of_sequence`/retransmit symptoms? CNPs flowing?
+ `ib_write_bw` NIC-to-NIC pinned with `numactl` — raw RDMA at line rate? If yes, fabric+NIC are exonerated; look up-stack (NCCL config, CPU, dataloader).
+ `all_reduce_perf` at increasing scope (intra-node → same-rail pair → across pod) — find the boundary where bus bandwidth collapses; the boundary names the culprit.

#soundbite[
  "My demarc doesn't end at the switchport — it ends at GPU memory. When a job is slow I
  bisect with `perftest` before anything else: if `ib_write_bw` between the two hosts hits
  line rate, the fabric and NICs are innocent and it's NCCL, NUMA, or the application; if it
  doesn't, I have a two-node reproducer I can chase with `mlxlink`, FEC counters, and switch
  telemetry. And I always check the boring things first — PCIe width, GPU-NIC affinity,
  driver/firmware matrix — because half of 'network problems' in GPU clusters are a NIC
  trained at x8 or a pod scheduled across sockets."
]
