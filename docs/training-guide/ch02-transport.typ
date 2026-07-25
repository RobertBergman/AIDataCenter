#import "lib.typ": *

= RDMA, InfiniBand, and RoCEv2: The Transport Layer of AI

== Why TCP thinking does not apply

Classic TCP/IP networking pays three taxes that AI workloads cannot afford: the kernel
(system calls, context switches, interrupt handling), memory copies (user buffer to kernel
socket buffer to NIC), and CPU cycles spent shuffling bytes instead of computing. At 400 or
800 Gb/s per GPU-attached NIC, a software network stack cannot keep up, and every CPU cycle
spent on networking is stolen from data loading and preprocessing.

*RDMA (Remote Direct Memory Access)* eliminates all three taxes. The NIC hardware moves data
directly between application memory on two servers — no kernel involvement in the data path,
no intermediate copies, no per-packet CPU work. The application posts a work request; the NIC
executes the transfer and signals completion.

#keyidea[
  RDMA is *hardware-offloaded, zero-copy, kernel-bypass* networking. The NIC is a DMA engine
  with a network port. Consequently, much of "the network stack" now lives in NIC firmware and
  switch buffer behavior — which is why AI network engineers must own the NIC and host stack,
  not just the switches.
]

== RDMA verbs and queue pairs

RDMA is programmed through the *verbs* API (provided by `rdma-core` / `libibverbs`). The
concepts appear constantly in troubleshooting and interviews:

- *Queue Pair (QP)* — the RDMA equivalent of a socket: a Send Queue and a Receive Queue in NIC-managed memory. Applications post *Work Requests* (WRs) to a QP; the NIC executes them asynchronously.
- *Completion Queue (CQ)* — where the NIC reports finished work. Polling the CQ replaces interrupts for latency-critical paths.
- *Memory Registration (MR)* — before the NIC may touch a buffer, the buffer is registered: pinned in physical memory and given local/remote keys (`lkey`/`rkey`). Registration is expensive, so applications register large regions once and reuse them.
- *Protection Domain (PD)* — a container that scopes which QPs may use which MRs.

Operations come in two flavors:

- *Two-sided (SEND/RECV)* — the receiver must pre-post a receive buffer; both sides' CPUs are minimally involved. Semantically like message passing.
- *One-sided (RDMA WRITE / RDMA READ / ATOMIC)* — the initiator reads or writes the remote host's registered memory directly. The remote CPU is *not involved at all*. This is what makes RDMA feel fundamentally different from sockets: memory access semantics over a network.

QP transport types matter operationally:

- *RC (Reliable Connection)* — connected, ordered, acknowledged, hardware retransmission. What NCCL and most training traffic uses today. Go-back-N retransmission on loss is why loss is so expensive (Chapter 3).
- *UC (Unreliable Connection)* and *UD (Unreliable Datagram)* — niche; UD underpins connection management and some HPC patterns.
- *DC (Dynamically Connected)* — an NVIDIA/Mellanox extension that reduces QP memory footprint at very large scale.

#gotcha[
  RC transport traditionally uses *go-back-N*: a single lost packet forces retransmission of
  the entire window from that point. One drop can cost megabytes of retransmitted data and a
  latency spike measured in milliseconds — an eternity for a synchronized collective. This is
  the root reason AI Ethernet fabrics are engineered lossless (PFC/ECN) and why newer stacks
  (ConnectX selective repeat, Ultra Ethernet Transport) move to selective retransmission.
]

== InfiniBand: the native RDMA fabric

InfiniBand (IB) is a complete, purpose-built stack — physical layer through transport — where
RDMA is native, and losslessness is a design property rather than a configuration exercise.

Key architectural facts a senior candidate should command:

- *Credit-based flow control.* An IB transmitter may only send when the receiver has advertised buffer credits, per *virtual lane (VL)*. Loss from congestion is architecturally impossible — no PFC tuning required. This is IB's single biggest operational advantage.
- *Subnet Manager (SM).* A centralized controller (OpenSM, or NVIDIA UFM in production) discovers the topology, assigns *LIDs* (local identifiers), computes routing tables for every switch, and monitors the fabric. Switches themselves are simple and fast. Contrast with Ethernet's fully distributed control plane — the SM is both a strength (global optimization) and an operational discipline (SM redundancy, planned failover).
- *Adaptive routing.* Because the SM sees the whole fabric, IB switches can spray traffic across multiple equal paths and route around congestion per-packet, with the destination NIC handling reordering.
- *SHARP (Scalable Hierarchical Aggregation and Reduction Protocol).* In-network computing: the switches themselves perform the reduction arithmetic of all-reduce, so gradient data is combined *in the fabric* rather than ping-ponged between GPUs. Cuts collective traffic volume roughly in half and reduces latency at scale.
- *Current generation.* NVIDIA Quantum-X800 switching provides 800 Gb/s ports with adaptive routing, telemetry-based congestion control, and SHARP v4 — paired with ConnectX-8 adapters.

== RoCEv2: RDMA over converged Ethernet

*RoCEv2* takes the InfiniBand transport layer (the same IB Base Transport Header, the same
verbs semantics) and encapsulates it in *UDP/IP over Ethernet*, destination UDP port 4791.
Because it is routable IP, it runs over a standard L3 Clos fabric — your BGP skills apply
directly to the underlay.

What RoCEv2 inherits and what it must borrow:

- It inherits IB's transport semantics — including RC's intolerance of loss.
- It does *not* inherit IB's credit-based link layer. Ethernet drops on congestion by default. Therefore the Ethernet fabric must be *made* lossless (or nearly so) using PFC and ECN/DCQCN — the subject of Chapter 3, and the heart of this job.
- Entropy for load balancing comes from the *UDP source port*, which the NIC varies per QP/flow — important later when we discuss ECMP.

The industry positioning to be fluent in: NVIDIA's Spectrum-X Ethernet platform is RoCE
between GPU servers with NIC/switch co-engineered adaptive routing and congestion control;
Arista/Broadcom publish AI deployment guides framing RoCE as hardware-offloaded RDMA over
Ethernet on standard merchant silicon; and the Ultra Ethernet Consortium is standardizing the
next-generation transport (Chapter 10). Ethernet won the volume argument; IB still holds the
turnkey-performance argument. A senior engineer can argue both sides (see the interview
chapter).

== GPUDirect RDMA: taking the CPU out of the picture

Without GPUDirect, moving GPU data between servers means: GPU memory to host RAM (bounce
buffer), host RAM to NIC, then the reverse on the far side — burning PCIe bandwidth, CPU, and
latency twice.

*GPUDirect RDMA* lets the NIC DMA directly into and out of *GPU HBM* across PCIe, with the
CPU and host memory completely out of the data path. The NIC and GPU exchange data
peer-to-peer, ideally under the same PCIe switch. Requirements you will be expected to know:

- NVIDIA GPU + RDMA-capable NIC (ConnectX-class) with compatible driver stack (`nvidia-peermem` or DMA-BUF on modern kernels).
- Sane *PCIe topology*: NIC and GPU on the same root complex or, ideally, same PCIe switch. `nvidia-smi topo -m` shows the relationship (PIX/PXB good; PHB/SYS bad).
- *ACS (Access Control Services)* on intermediate PCIe switches must permit peer-to-peer, or traffic silently detours through the root complex and performance collapses (a classic field issue — Chapter 7).

Related family members worth name-dropping accurately: *GPUDirect Storage* (NVMe/storage DMA
direct to GPU) and *GDRCopy* (low-latency CPU-mapped GPU memory access).

#soundbite[
  "RoCEv2 is literally the InfiniBand transport in a UDP/IP envelope — same verbs, same queue
  pairs, same reliable-connection semantics, and the same intolerance of packet loss. The
  difference is that InfiniBand gets losslessness from credit-based flow control by design,
  while with RoCE *I* have to engineer losslessness on Ethernet with PFC and ECN, and then
  monitor that it stays engineered. That is the core of the AI network engineer's job on an
  Ethernet fabric."
]

== Minimum vocabulary check

Before moving on, you should be able to define from memory: verbs, QP, WQE, CQ, MR,
`lkey`/`rkey`, RC vs UD, one-sided vs two-sided, go-back-N, VL, LID, SM, SHARP, BTH, UDP 4791,
GPUDirect RDMA, and peer-to-peer PCIe. These terms *will* come up in a technical screen.
