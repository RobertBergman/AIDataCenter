/**
 * Fabric construction: how many switches, where they live, and every logical
 * link between them.
 *
 * Ports are budgeted before anything is cabled. For a leaf with P front-panel
 * ports at oversubscription `os`, we take the largest even downlink count d
 * such that d + ceil(d/os) ≤ P -- so a 32-port leaf at 1:1 is 16 down / 16 up,
 * and at 4:1 it is 24 down / 6 up. Anything that does not fit is a hard error
 * from validate.js, never a silently truncated cable list.
 *
 * The three architectures differ only in *where the leaf sits*, but that single
 * choice is what decides whether host cables are 2 m of DAC or 25 m of AOC.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  /** Largest even downlink count that leaves room for its own uplinks. */
  function portSplit(ports, os) {
    for (let d = ports % 2 === 0 ? ports : ports - 1; d >= 2; d -= 2) {
      const up = Math.max(1, Math.ceil(d / os));
      if (d + up <= ports) return { down: d, up };
    }
    return { down: 2, up: 1 };
  }

  /**
   * Spine count that absorbs the uplink volume *and* divides evenly into the
   * uplinks each leaf actually has.
   *
   * The hard ceiling is `uplinksPerLeaf`: a leaf cannot stripe across more
   * spines than it has uplink ports. When the uplink volume would need more
   * spines than that, no single spine layer of this SKU can serve the pod --
   * we return the largest legal fan-out and let validation report the spine
   * port overflow, which tells the user to add a tier, add pods, or fit a
   * bigger spine. Silently handing out uplink ports the leaf does not have
   * would cable a 32-port leaf 40 times.
   */
  function chooseSpineCount(uplinksPerLeaf, totalUplinks, spinePorts) {
    const need = Math.max(2, Math.ceil(totalUplinks / Math.max(1, spinePorts)));
    for (let s = need; s <= uplinksPerLeaf; s++) {
      if (uplinksPerLeaf % s === 0) return s;
    }
    for (let s = uplinksPerLeaf; s >= 2; s--) {
      if (uplinksPerLeaf % s === 0) return s;
    }
    return Math.max(2, uplinksPerLeaf);
  }

  function plan(ctx) {
    const { design, racks } = ctx;
    const C = DCP.Catalog;
    const F = design.fabric;
    const leafSpec = C.SWITCHES[F.leaf_model];
    const spineSpec = C.SWITCHES[F.spine_model];
    const superSpec = C.SWITCHES[F.super_model];
    const oobSpec = C.SWITCHES[F.oob_model];

    const split = portSplit(leafSpec.ports, F.oversubscription);

    /**
     * A host link negotiates down to the slower end.
     *
     * An 800G ConnectX-8 plugged into a 400G leaf port is a 400G link, and it
     * must be priced, reach-checked and drawn as one. Taking the NIC's word for
     * it -- which is what this did -- meant a design that mixed a current NIC
     * with a previous-generation leaf reported a fabric it does not have, and
     * bought 800G optics to run at half speed.
     *
     * The mismatch is worth surfacing rather than silently absorbing: it is
     * usually a procurement error, not a decision.
     */
    let clampedHosts = 0;
    const hostLinkSpeed = (host) => {
      if (host.nic_speed > leafSpec.speed) clampedHosts++;
      return Math.min(host.nic_speed, leafSpec.speed);
    };

    const switches = [];
    const links = [];
    const notes = [];
    const byRack = new Map(racks.map((r) => [r.id, []]));

    const networkRacks = racks.filter((r) => C.RACK_LAYOUTS[r.layout].hosts_spines);
    const mgmtRacks = racks.filter((r) => C.RACK_LAYOUTS[r.layout].role === "mgmt");
    const homeForNetwork = (i) => {
      if (networkRacks.length) return networkRacks[i % networkRacks.length];
      if (mgmtRacks.length) return mgmtRacks[i % mgmtRacks.length];
      notes.push("no network or mgmt rack in the design — spines have nowhere to live");
      return racks[0];
    };

    const addSwitch = (s) => {
      switches.push(s);
      if (byRack.has(s.rackId)) byRack.get(s.rackId).push(s);
      return s;
    };

    // Servers that actually take fabric ports, in a stable order.
    const fabricHosts = [];
    for (const rack of racks) {
      for (const dev of rack.servers) {
        if (dev.nics > 0) fabricHosts.push({ ...dev, rackId: rack.id, rackName: rack.name });
      }
    }
    const gpuHosts = fabricHosts.filter((h) => h.class === "gpu");
    const rails = gpuHosts.length ? gpuHosts[0].nics : 0;

    /* ================================================== leaf construction == */
    const leaves = [];
    const hostPortCursor = new Map(); // leafId → next free downlink index

    /**
     * Take the next downlink port on `preferred`, spilling to the next leaf in
     * the list that still has room. Downlink ports stop at split.down -- the
     * ports above that belong to the uplinks and must never be handed out here.
     */
    const allocDown = (list, preferredIdx) => {
      for (let i = 0; i < list.length; i++) {
        const leaf = list[(preferredIdx + i) % list.length];
        const port = hostPortCursor.get(leaf.id);
        if (port <= leaf.downlinks) {
          hostPortCursor.set(leaf.id, port + 1);
          return { leaf, port };
        }
      }
      notes.push(`no free downlink port for a host on ${list[0] ? list[0].id : "?"} — add leaves or lower oversubscription`);
      return null;
    };

    const newLeaf = (name, rackId, meta) => {
      const sw = addSwitch({
        id: name, name, kind: "switch", role: "leaf", sku: F.leaf_model,
        model: leafSpec.model, ru: leafSpec.ru, kw: leafSpec.kw, weight_kg: leafSpec.weight_kg,
        ports: leafSpec.ports, downlinks: split.down, uplinks: split.up, rackId, ...meta,
      });
      leaves.push(sw);
      hostPortCursor.set(name, 1);
      return sw;
    };

    if (F.arch === "rail-optimized") {
      // One leaf per rail (more if a rail outgrows a single switch). NIC k of
      // every node lands on the rail-k leaf: rail identity is a correctness
      // constraint, so a host's NIC index picks the leaf, not proximity.
      const perRail = Math.max(1, Math.ceil(gpuHosts.length / split.down));
      for (let r = 0; r < rails; r++) {
        for (let k = 0; k < perRail; k++) {
          const name = perRail === 1 ? `leaf-rail${r}` : `leaf-rail${r}-${k + 1}`;
          // Tag stays `0` when a rail has one leaf, so labels keep the familiar
          // L0S1-U1 form and only grow a group suffix when a rail needs to split.
          const tag = perRail === 1 ? `${r}` : `${r}g${k + 1}`;
          newLeaf(name, homeForNetwork(r * perRail + k).id, { rail: r, group: k, tag });
        }
      }
      gpuHosts.forEach((host, hostIdx) => {
        const group = Math.floor(hostIdx / split.down);
        for (let r = 0; r < host.nics; r++) {
          const railLeaves = leaves.filter((l) => l.rail === r);
          const alloc = allocDown(railLeaves, Math.min(group, railLeaves.length - 1));
          if (!alloc) continue;
          links.push({
            label: `R${r}-${host.name}`,
            class: "fabric", rail: r, speed: hostLinkSpeed(host),
            a: { device: host.name, port: `rail${r}`, rack: host.rackName },
            b: { device: alloc.leaf.id, port: `Ethernet${alloc.port}`, rack: rackNameOf(racks, alloc.leaf.rackId) },
            from_key: `rack:${host.rackId}`, to_key: `rack:${alloc.leaf.rackId}`,
          });
        }
      });

      // Storage and management hosts get their own leaf group rather than
      // stealing rail ports -- a rail leaf's downlinks belong to the rails.
      const utility = fabricHosts.filter((h) => h.class !== "gpu");
      if (utility.length) {
        const need = DCP.Util.sum(utility, (h) => h.nics);
        const count = Math.max(2, Math.ceil(need / split.down));
        const utilLeaves = [];
        for (let k = 0; k < count; k++) {
          utilLeaves.push(newLeaf(`leaf-util${k + 1}`, homeForNetwork(rails + k).id, { utility: true, tag: `u${k + 1}` }));
        }
        utility.forEach((host, hostIdx) => {
          for (let n = 0; n < host.nics; n++) {
            // Consecutive index keeps a host's two NICs on different leaves.
            const alloc = allocDown(utilLeaves, (hostIdx * host.nics + n) % count);
            if (!alloc) continue;
            links.push({
              label: `H${n}-${host.name}`,
              class: "fabric", rail: n, speed: hostLinkSpeed(host),
              a: { device: host.name, port: `net${n}`, rack: host.rackName },
              b: { device: alloc.leaf.id, port: `Ethernet${alloc.port}`, rack: rackNameOf(racks, alloc.leaf.rackId) },
              from_key: `rack:${host.rackId}`, to_key: `rack:${alloc.leaf.rackId}`,
            });
          }
        });
      }
    } else if (F.arch === "tor") {
      // A leaf pair inside every compute rack: host cables never leave the rack.
      // Two downlink ports per leaf are reserved for the MLAG peer-link, so the
      // usable downlink budget is split.down − 2.
      for (const rack of racks) {
        const hosts = rack.servers.filter((s) => s.nics > 0);
        if (hosts.length === 0) continue;
        const usableDown = Math.max(1, split.down - 2);
        const downNeeded = DCP.Util.sum(hosts, (h) => h.nics);
        let count = Math.max(2, Math.ceil(downNeeded / usableDown));
        if (count % 2 === 1) count++; // keep MLAG pairs even
        const rackLeaves = [];
        for (let k = 0; k < count; k++) {
          rackLeaves.push(newLeaf(`${rack.name.toLowerCase()}-tor${k + 1}`, rack.id,
            { tor_of: rack.id, pair: Math.floor(k / 2), tag: `${rack.name}t${k + 1}` }));
        }
        // Peer-links first so the reserved ports are genuinely reserved.
        for (let p = 0; p * 2 + 1 < rackLeaves.length; p++) {
          const [x, y] = [rackLeaves[p * 2], rackLeaves[p * 2 + 1]];
          for (let n = 1; n <= 2; n++) {
            const px = allocDown([x], 0);
            const py = allocDown([y], 0);
            if (!px || !py) break;
            links.push({
              label: `PEER-${x.id}-${n}`,
              class: "fabric", speed: leafSpec.speed,
              a: { device: x.id, port: `Ethernet${px.port}`, rack: rack.name },
              b: { device: y.id, port: `Ethernet${py.port}`, rack: rack.name },
              from_key: `rack:${rack.id}`, to_key: `rack:${rack.id}`, in_rack: true,
            });
          }
        }
        hosts.forEach((host) => {
          for (let n = 0; n < host.nics; n++) {
            const alloc = allocDown(rackLeaves, n % rackLeaves.length);
            if (!alloc) continue;
            links.push({
              label: `H${n}-${host.name}`,
              class: "fabric", rail: n, speed: hostLinkSpeed(host),
              a: { device: host.name, port: `rail${n}`, rack: rack.name },
              b: { device: alloc.leaf.id, port: `Ethernet${alloc.port}`, rack: rack.name },
              from_key: `rack:${rack.id}`, to_key: `rack:${rack.id}`, in_rack: true,
            });
          }
        });
      }
    } else {
      // End-of-row: one leaf group per row, homed in that row's network rack.
      const rows = DCP.Util.groupBy(racks, (r) => r.row ?? 0);
      for (const [rowIdx, rowRacks] of rows) {
        const hosts = rowRacks.flatMap((r) => r.servers.filter((s) => s.nics > 0).map((s) => ({ ...s, rackId: r.id, rackName: r.name })));
        if (!hosts.length) continue;
        const downNeeded = DCP.Util.sum(hosts, (h) => h.nics);
        let count = Math.max(2, Math.ceil(downNeeded / split.down));
        if (count % 2 === 1) count++;
        const homeRack = rowRacks.find((r) => C.RACK_LAYOUTS[r.layout].hosts_spines) || homeForNetwork(rowIdx);
        const rowLeaves = [];
        for (let k = 0; k < count; k++) {
          rowLeaves.push(newLeaf(`leaf-row${rowIdx}-${k + 1}`, homeRack.id, { row: rowIdx, tag: `r${rowIdx}n${k + 1}` }));
        }
        hosts.forEach((host, hostIdx) => {
          for (let n = 0; n < host.nics; n++) {
            const alloc = allocDown(rowLeaves, (hostIdx * host.nics + n) % rowLeaves.length);
            if (!alloc) continue;
            links.push({
              label: `H${n}-${host.name}`,
              class: "fabric", rail: n, speed: hostLinkSpeed(host),
              a: { device: host.name, port: `rail${n}`, rack: host.rackName },
              b: { device: alloc.leaf.id, port: `Ethernet${alloc.port}`, rack: homeRack.name },
              from_key: `rack:${host.rackId}`, to_key: `rack:${homeRack.id}`,
            });
          }
        });
      }
    }

    /* ======================================================= spine tier === */
    const totalUplinks = leaves.length * split.up;
    const spines = [];
    const supers = [];

    // In a three-tier fabric a spine is not all downlinks: it has to keep ports
    // for its own uplinks to the super-spine. Budget those first, or the spine
    // ends up cabled past its front panel.
    const spineUp = F.tiers === 3 ? Math.max(2, Math.floor(spineSpec.ports * 0.25)) : 0;
    const spineDown = spineSpec.ports - spineUp;

    if (leaves.length) {
      const pods = F.tiers === 3 ? groupIntoPods(leaves, F.pod_racks) : [leaves];

      pods.forEach((podLeaves, podIdx) => {
        const podUplinks = podLeaves.length * split.up;
        const spineCount = chooseSpineCount(split.up, podUplinks, spineDown);
        const linksPerSpine = Math.max(1, Math.floor(split.up / spineCount));
        const podSpines = [];

        for (let s = 0; s < spineCount; s++) {
          const name = pods.length > 1 ? `spine${podIdx + 1}-${s + 1}` : `spine${s + 1}`;
          const sw = addSwitch({
            id: name, name, kind: "switch", role: "spine", sku: F.spine_model,
            model: spineSpec.model, ru: spineSpec.ru, kw: spineSpec.kw, weight_kg: spineSpec.weight_kg,
            ports: spineSpec.ports, rackId: homeForNetwork(podIdx * spineCount + s).id, pod: podIdx,
          });
          podSpines.push(sw);
          spines.push(sw);
        }

        const spineCursor = new Map(podSpines.map((s) => [s.id, 1]));
        podLeaves.forEach((leaf, li) => {
          let uplink = 1;
          podSpines.forEach((spine, si) => {
            for (let k = 0; k < linksPerSpine; k++) {
              const sPort = spineCursor.get(spine.id);
              spineCursor.set(spine.id, sPort + 1);
              const leafPort = split.down + uplink;
              links.push({
                label: `L${leaf.tag !== undefined ? leaf.tag : li}S${si + 1}-U${uplink}`,
                // A link runs at the slower of the two ports it lands on. This
                // used to be hardcoded to 400, which was right only for as long
                // as every switch in the catalog was a 400G switch -- put an
                // 800G leaf and an 800G spine either side of it and the entire
                // fabric backbone was still being priced, sized and reach-checked
                // as 400G.
                class: "fabric", speed: Math.min(leafSpec.speed, spineSpec.speed),
                tier: "leaf-spine",
                a: { device: leaf.id, port: `Ethernet${leafPort}`, rack: rackNameOf(racks, leaf.rackId) },
                b: { device: spine.id, port: `Ethernet${sPort}`, rack: rackNameOf(racks, spine.rackId) },
                from_key: `rack:${leaf.rackId}`, to_key: `rack:${spine.rackId}`,
                trunk_group: `T-${spine.id}`,
              });
              uplink++;
            }
          });
        });
      });

      // Super-spine across pods.
      if (F.tiers === 3 && spines.length) {
        const perSpineUp = spineUp;
        const superCount = chooseSpineCount(perSpineUp, spines.length * perSpineUp, superSpec.ports);
        const perSuper = Math.max(1, Math.floor(perSpineUp / superCount));
        for (let s = 0; s < superCount; s++) {
          supers.push(addSwitch({
            id: `super${s + 1}`, name: `super${s + 1}`, kind: "switch", role: "super", sku: F.super_model,
            model: superSpec.model, ru: superSpec.ru, kw: superSpec.kw, weight_kg: superSpec.weight_kg,
            ports: superSpec.ports, rackId: homeForNetwork(s).id,
          }));
        }
        const superCursor = new Map(supers.map((s) => [s.id, 1]));
        spines.forEach((spine) => {
          let up = 1;
          supers.forEach((sup, si) => {
            for (let k = 0; k < perSuper; k++) {
              const sPort = superCursor.get(sup.id);
              superCursor.set(sup.id, sPort + 1);
              links.push({
                label: `S${spine.name}X${si + 1}-U${up}`,
                class: "fabric", speed: Math.min(spineSpec.speed, superSpec.speed),
                tier: "spine-super",
                a: { device: spine.id, port: `Ethernet${spineDown + up}`, rack: rackNameOf(racks, spine.rackId) },
                b: { device: sup.id, port: `Ethernet${sPort}`, rack: rackNameOf(racks, sup.rackId) },
                from_key: `rack:${spine.rackId}`, to_key: `rack:${sup.rackId}`,
                trunk_group: `T-${sup.id}`,
              });
              up++;
            }
          });
        });
      }
    }

    /* ========================================================= OOB plane == */
    // One OOB switch per rack is the common case, but a rack packed with rail
    // leaves can need more BMC/mgmt0/Management1 ports than a 48-port switch
    // has. Size the OOB stack from the actual port demand instead of assuming
    // one fits -- otherwise access ports run into the uplink cages.
    const oobSwitches = [];
    if (F.emit_oob) {
      const oobMgmtRack = racks.find((r) => C.RACK_LAYOUTS[r.layout].role === "mgmt") || racks[0];
      for (const rack of racks) {
        const racked = (byRack.get(rack.id) || []).filter((s) => s.role !== "oob");
        const serverPorts = rack.servers.filter((s) => !(s.busbar_powered && s.class === "nvlink")).length * 2;
        let need = serverPorts + racked.length;
        // The mgmt rack terminates every other rack's OOB uplinks; the others
        // spend two of their own ports sending them.
        need += rack.id === oobMgmtRack.id ? 2 * Math.max(0, racks.length - 1) : 2;
        const count = Math.max(1, Math.ceil(need / oobSpec.ports));

        for (let k = 0; k < count; k++) {
          const base = rack.name.toLowerCase();
          const name = count === 1 ? `oob-${base}` : `oob-${base}-${k + 1}`;
          oobSwitches.push(addSwitch({
            id: name, name, kind: "switch", role: "oob", sku: F.oob_model, model: oobSpec.model,
            ru: oobSpec.ru, kw: oobSpec.kw, weight_kg: oobSpec.weight_kg,
            ports: oobSpec.ports, rackId: rack.id,
          }));
        }
      }
    }

    if (clampedHosts > 0) {
      notes.push(`${clampedHosts} host link(s) negotiate down to ${leafSpec.speed}G — ` +
        `the NIC is faster than the ${leafSpec.model} port it lands on, so the extra ` +
        `NIC bandwidth is bought and not used`);
    }

    return {
      switches, links, leaves, spines, supers, oobSwitches, byRack, notes,
      split, rails,
      arch: F.arch,
      oversubscription: F.oversubscription,
      totals: {
        leaves: leaves.length,
        spines: spines.length,
        supers: supers.length,
        oob: oobSwitches.length,
        leaf_downlinks: split.down,
        leaf_uplinks: split.up,
        total_uplinks: totalUplinks,
        fabric_links: links.length,
      },
    };
  }

  /** OOB/mgmt cabling. Split out because it needs the final per-rack device list. */
  function cableOob(ctx, fabric) {
    const { racks, design } = ctx;
    if (!design.fabric.emit_oob) return [];
    const C = DCP.Catalog;
    const oobSpec = C.SWITCHES[design.fabric.oob_model];
    const links = [];

    const mgmtRack = racks.find((r) => C.RACK_LAYOUTS[r.layout].role === "mgmt") || racks[0];

    /**
     * Port allocator over a rack's OOB stack: fill a switch, then spill to the
     * next one. Access ports never run past the front panel into the uplink
     * cages, which is what used to collide with the aggregation uplinks.
     */
    const allocators = new Map();
    const allocatorFor = (rackId) => {
      if (!allocators.has(rackId)) {
        const stack = fabric.oobSwitches.filter((s) => s.rackId === rackId);
        const cursor = { idx: 0, port: 1 };
        allocators.set(rackId, () => {
          while (cursor.idx < stack.length && cursor.port > oobSpec.ports) {
            cursor.idx++;
            cursor.port = 1;
          }
          if (cursor.idx >= stack.length) return null; // validate.js reports the shortfall
          const sw = stack[cursor.idx];
          sw.ports_used = (sw.ports_used || 0) + 1;
          return { sw, port: cursor.port++ };
        });
      }
      return allocators.get(rackId);
    };

    for (const rack of racks) {
      const take = allocatorFor(rack.id);

      for (const dev of rack.devices) {
        if (dev.role === "oob") continue; // the OOB switch does not cable to itself
        if (dev.busbar_powered && dev.kind === "server" && dev.class === "nvlink") continue;

        if (dev.kind === "switch") {
          const a = take();
          if (!a) break;
          links.push({
            label: `MA1-${dev.name}`, class: "mgmt", speed: 1,
            a: { device: dev.name, port: "Management1", rack: rack.name },
            b: { device: a.sw.name, port: `Ethernet${a.port}`, rack: rack.name },
            from_key: `rack:${rack.id}`, to_key: `rack:${rack.id}`, in_rack: true,
          });
        } else {
          const bmc = take();
          const mgmt = take();
          if (!bmc || !mgmt) break;
          links.push({
            label: `OOB-${dev.name}`, class: "oob", speed: 1,
            a: { device: dev.name, port: "bmc", rack: rack.name },
            b: { device: bmc.sw.name, port: `Ethernet${bmc.port}`, rack: rack.name },
            from_key: `rack:${rack.id}`, to_key: `rack:${rack.id}`, in_rack: true,
          });
          links.push({
            label: `MGMT-${dev.name}`, class: "mgmt", speed: 1,
            a: { device: dev.name, port: "mgmt0", rack: rack.name },
            b: { device: mgmt.sw.name, port: `Ethernet${mgmt.port}`, rack: rack.name },
            from_key: `rack:${rack.id}`, to_key: `rack:${rack.id}`, in_rack: true,
          });
        }
      }
    }

    // OOB uplinks: every rack's stack homes into the mgmt rack's stack. These
    // land on real access ports there, so the aggregation's capacity is
    // accounted for like any other switch.
    const takeAgg = allocatorFor(mgmtRack.id);
    for (const rack of racks) {
      if (rack.id === mgmtRack.id) continue;
      for (const oob of fabric.oobSwitches.filter((s) => s.rackId === rack.id)) {
        for (let u = 1; u <= 2; u++) {
          const agg = takeAgg();
          if (!agg) break;
          links.push({
            label: `OOBU-${oob.name}-${u}`, class: "oob", speed: 25,
            a: { device: oob.name, port: `Ethernet${oobSpec.ports + u}`, rack: rack.name },
            b: { device: agg.sw.name, port: `Ethernet${agg.port}`, rack: mgmtRack.name },
            from_key: `rack:${rack.id}`, to_key: `rack:${mgmtRack.id}`,
          });
        }
      }
    }
    return links;
  }

  function groupIntoPods(leaves, podSize) {
    const pods = [];
    const size = Math.max(1, podSize);
    for (let i = 0; i < leaves.length; i += size) pods.push(leaves.slice(i, i + size));
    return pods.length ? pods : [leaves];
  }

  function rackNameOf(racks, id) {
    const r = racks.find((x) => x.id === id);
    return r ? r.name : "?";
  }

  DCP.Fabric = { plan, cableOob, portSplit, chooseSpineCount };
})(typeof globalThis !== "undefined" ? globalThis : this);
