/**
 * The power chain, end to end:
 *
 *   utility entrance ─▶ UPS ─▶ RPP or overhead busway ─▶ rack PDU ─▶ PSU cords
 *        (A / B)       (A/B)         (A/B)                (A/B)
 *
 * Two rules shape every number here:
 *
 *  1. Dual-corded IT means each side must survive alone. A and B normally share
 *     the load roughly 50/50, but each is sized for 100% -- otherwise losing a
 *     feed drops the hall. So UPS, RPP and rack-PDU capacity are all sized
 *     against full rack load per side, not half.
 *
 *  2. Continuous load is derated (NEC 80%). A 60 A rack PDU is a 34.5 kW rack
 *     PDU, and a 100 kW NVL72 rack therefore needs three of them per side.
 *
 * Power is placed and routed on its own pathway tier, physically separated from
 * the data trays, and the B feed is deliberately routed to share as few tray
 * segments with A as the room allows.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  const SQRT3 = Math.sqrt(3);
  const kvaOf = (amps, volts, phases) => (phases === 3 ? volts * amps * SQRT3 : volts * amps) / 1000;

  function plan(ctx) {
    const { design, floor, racks, cooling } = ctx;
    const C = DCP.Catalog;
    const P = design.power;
    const derate = P.breaker_derate;

    const feeds = P.entrances >= 2 ? ["A", "B"] : ["A"];
    const itLoadKw = DCP.Util.sum(racks, (r) => r.kw);
    const mechKw = cooling ? cooling.mechanical_kw : 0;
    const facilityKw = itLoadKw * P.pue_target;

    const notes = [];
    const runs = [];

    /* ------------------------------------------------------ rack PDUs ---- */
    const pduSpec = C.RACK_PDU[P.rack_pdu_model];
    const pduKva = kvaOf(pduSpec.amps, pduSpec.volts, pduSpec.phases);
    const pduUsableKw = pduKva * derate;
    const rackPdus = [];

    for (const rack of racks) {
      // Each side alone must carry the whole rack.
      const perSide = Math.max(1, Math.ceil(rack.kw / pduUsableKw));
      for (const feed of feeds) {
        for (let k = 1; k <= perSide; k++) {
          rackPdus.push({
            id: `pdu-${rack.name}-${feed}${k}`,
            name: `PDU-${rack.name}-${feed}${k}`,
            rack: rack.name,
            rack_id: rack.id,
            feed,
            index: k,
            model: P.rack_pdu_model,
            mount: `0U ${feed === "A" ? "left" : "right"} rail`,
            amps: pduSpec.amps,
            volts: pduSpec.volts,
            phases: pduSpec.phases,
            kva: DCP.Util.round(pduKva, 1),
            usable_kw: DCP.Util.round(pduUsableKw, 1),
            load_kw: DCP.Util.round(rack.kw / perSide, 2),
            outlets: pduSpec.outlets,
          });
        }
      }
      rack.pdus_per_side = perSide;
    }

    /* ------------------------------------------------------------ UPS ---- */
    const upsSpec = C.UPS[P.ups_model];
    const upsKw = upsSpec.kva * upsSpec.pf;
    // Mechanical plant normally rides the generator, not the UPS.
    const upsLoadPerFeed = itLoadKw;
    const nModules = Math.max(1, Math.ceil(upsLoadPerFeed / upsKw));
    const modulesPerFeed =
      P.ups_redundancy === "2N" ? nModules * 2 : P.ups_redundancy === "N+1" ? nModules + 1 : nModules;

    const ups = [];
    const elec = floor.zones.electrical;
    const upsTotal = modulesPerFeed * feeds.length;
    let upsIdx = 0;
    for (const feed of feeds) {
      for (let k = 1; k <= modulesPerFeed; k++) {
        upsIdx++;
        ups.push({
          id: `ups-${feed}${k}`,
          name: `UPS-${feed}${k}`,
          feed,
          model: P.ups_model,
          kva: upsSpec.kva,
          usable_kw: DCP.Util.round(upsKw, 1),
          x: DCP.Util.round((elec.x0 + elec.x1) / 2, 2),
          y: DCP.Util.round((upsIdx / (upsTotal + 1)) * design.room.depth_m, 2),
          w_m: upsSpec.w_m,
          d_m: upsSpec.d_m,
          weight_kg: upsSpec.weight_kg,
          spare: P.ups_redundancy === "N+1" && k === modulesPerFeed,
        });
      }
    }

    /* ------------------------------------------------------ entrances ---- */
    const entrances = [];
    for (let i = 0; i < P.entrances; i++) {
      const feed = feeds[i] || feeds[i % feeds.length];
      entrances.push({
        id: `entrance-${feed}`,
        name: `SVC-${feed}`,
        feed,
        side: P.entrance_side,
        capacity_kw: P.entrance_kw,
        volts: P.volts,
        phases: P.phases,
        // Service lands on the wall behind the electrical zone.
        x: 0,
        y: DCP.Util.round(((i + 1) / (P.entrances + 1)) * design.room.depth_m, 2),
      });
    }

    /* --------------------------------------------------- distribution ---- */
    const distribution = [];
    const busway = P.distribution === "busway";

    if (busway) {
      const bwSpec = C.BUSWAY[P.busway_model];
      const bwKw = kvaOf(bwSpec.amps, bwSpec.volts, bwSpec.phases) * derate;
      const rows = DCP.Util.groupBy(racks, (r) => r.row);
      for (const [rowIdx, rowRacks] of rows) {
        const rowKw = DCP.Util.sum(rowRacks, (r) => r.kw);
        const runsNeeded = Math.max(1, Math.ceil(rowKw / bwKw));
        for (const feed of feeds) {
          for (let k = 1; k <= runsNeeded; k++) {
            distribution.push({
              id: `bw-r${rowIdx}-${feed}${k}`,
              name: `BUSWAY-R${rowIdx}-${feed}${k}`,
              kind: "busway",
              feed,
              model: P.busway_model,
              row: rowIdx,
              capacity_kw: DCP.Util.round(bwKw, 1),
              load_kw: DCP.Util.round(rowKw / runsNeeded, 1),
              // Overhead, above the row it serves -- no floor footprint.
              x: DCP.Util.round(DCP.Util.sum(rowRacks, (r) => r.x) / rowRacks.length, 2),
              y: rowRacks[0].y,
              x0: Math.min(...rowRacks.map((r) => r.x)),
              x1: Math.max(...rowRacks.map((r) => r.x)),
              height_m: design.room.power_tray_height_m,
              serves: rowRacks.map((r) => r.id),
            });
          }
        }
      }
    } else {
      const rppSpec = C.RPP[P.rpp_model];
      const rppKw = kvaOf(rppSpec.amps, rppSpec.volts, rppSpec.phases) * derate;
      // 0.9 leaves headroom for greedy nearest-first packing: without it the
      // last panel ends up a hair over its derated rating.
      const perFeed = Math.max(1, Math.ceil(itLoadKw / (rppKw * 0.9)));
      const zone = floor.zones.distribution;
      let idx = 0;
      for (const feed of feeds) {
        for (let k = 1; k <= perFeed; k++) {
          idx++;
          distribution.push({
            id: `rpp-${feed}${k}`,
            name: `RPP-${feed}${k}`,
            kind: "rpp",
            feed,
            model: P.rpp_model,
            capacity_kw: DCP.Util.round(rppKw, 1),
            load_kw: 0,
            poles: rppSpec.poles,
            poles_used: 0,
            x: zone ? DCP.Util.round((zone.x0 + zone.x1) / 2, 2) : design.room.width_m - design.room.perimeter_m,
            y: DCP.Util.round((idx / (perFeed * feeds.length + 1)) * design.room.depth_m, 2),
            w_m: rppSpec.w_m,
            d_m: rppSpec.d_m,
            weight_kg: rppSpec.weight_kg,
            serves: [],
          });
        }
      }
    }

    /* ------------------------------------- assign racks to distribution --- */
    // Nearest unit on the same feed that still has capacity and breaker poles.
    let assignment = new Map(); // `${rackId}:${feed}` → distribution unit

    const assignRacks = () => {
      const map = new Map();
      for (const d of distribution) {
        if (d.kind === "rpp") {
          d.load_kw = 0;
          d.poles_used = 0;
          d.serves = [];
        }
      }
      for (const rack of racks) {
        for (const feed of feeds) {
          const candidates = distribution.filter((d) => d.feed === feed && (busway ? d.row === rack.row : true));
          const need = rack.kw;
          const fits = candidates
            .filter((d) => busway || d.load_kw + need <= d.capacity_kw)
            .sort((a, b) =>
              (Math.abs(a.x - rack.x) + Math.abs(a.y - rack.y)) - (Math.abs(b.x - rack.x) + Math.abs(b.y - rack.y)))[0];
          // Nothing with room left: fall back to the emptiest panel so the
          // overload lands on one unit and validation names it.
          const pick = fits || [...candidates].sort((a, b) => a.load_kw - b.load_kw)[0];
          if (!pick) {
            notes.push(`no ${feed}-feed distribution unit available for ${rack.name}`);
            continue;
          }
          if (!busway) {
            pick.load_kw = DCP.Util.round(pick.load_kw + need, 2);
            pick.poles_used += (rack.pdus_per_side || 1) * (pduSpec.phases === 3 ? 3 : 1);
            pick.serves.push(rack.id);
          }
          map.set(`${rack.id}:${feed}`, pick);
        }
      }
      return map;
    };

    assignment = assignRacks();

    if (!busway) {
      // Second pass: slide each panel to the centroid of the racks it actually
      // picked up, then reassign against the new geometry. Panels sited on an
      // even pitch and racks placed by the QAP solver rarely line up on the
      // first try, and a panel two rows away is metres of extra whip per rack.
      for (const d of distribution) {
        const served = d.serves.map((id) => racks.find((r) => r.id === id)).filter(Boolean);
        if (served.length) {
          d.y = DCP.Util.round(DCP.Util.sum(served, (r) => r.y) / served.length, 2);
        }
      }
      assignment = assignRacks();

      // Drop panels nothing landed on -- an empty RPP is a line item nobody ordered.
      for (let i = distribution.length - 1; i >= 0; i--) {
        if (distribution[i].kind === "rpp" && distribution[i].serves.length === 0) {
          distribution.splice(i, 1);
        }
      }
    }

    /* --------------------------------------------------------- cabling --- */
    // Entrance → UPS. Each feeder lands on its own switchgear section.
    const entrancePort = new Map();
    for (const u of ups) {
      const ent = entrances.find((e) => e.feed === u.feed) || entrances[0];
      const secIdx = (entrancePort.get(ent.id) || 0) + 1;
      entrancePort.set(ent.id, secIdx);
      runs.push({
        label: `PE-${u.feed}-${u.name}`,
        class: "power",
        media: "feeder-800a",
        a: { device: ent.name, port: `section-${secIdx}`, rack: "entrance" },
        b: { device: u.name, port: "input", rack: "electrical" },
        from_key: `equip:${ent.id}`,
        to_key: `equip:${u.id}`,
        feed: u.feed,
        // Service and UPS feeders run in conduit/ladder in the electrical zone,
        // not in the cable tray -- they must not consume tray fill.
        pathway: "conduit",
      });
    }

    // UPS → RPP / busway riser, each on its own output breaker.
    const upsPort = new Map();
    for (const d of distribution) {
      const feeder = d.capacity_kw > 300 ? "feeder-800a" : "feeder-400a";
      const source = ups.filter((u) => u.feed === d.feed && !u.spare)[0] || ups.find((u) => u.feed === d.feed) || ups[0];
      if (!source) continue;
      const outIdx = (upsPort.get(source.id) || 0) + 1;
      upsPort.set(source.id, outIdx);
      runs.push({
        label: `PF-${d.feed}-${d.name}`,
        class: "power",
        media: feeder,
        a: { device: source.name, port: `output-${outIdx}`, rack: "electrical" },
        b: { device: d.name, port: "main", rack: d.kind === "busway" ? `row-${d.row}` : "distribution" },
        from_key: `equip:${source.id}`,
        to_key: `equip:${d.id}`,
        feed: d.feed,
        pathway: "conduit",
      });
    }

    // Distribution → rack PDU (the whips / tap-offs that actually get labeled)
    for (const pdu of rackPdus) {
      const src = assignment.get(`${pdu.rack_id}:${pdu.feed}`);
      if (!src) continue;
      const media = busway ? "busway-tap" : pduSpec.amps >= 100 ? "whip-3ph-100a" : "whip-3ph-60a";
      runs.push({
        label: `${busway ? "PT" : "PW"}-${pdu.feed}${pdu.index}-${pdu.rack}`,
        class: "power",
        media,
        a: { device: src.name, port: busway ? `tap-${pdu.rack}-${pdu.index}` : `breaker-${pdu.rack}-${pdu.index}`, rack: src.kind === "busway" ? `row-${src.row}` : "distribution" },
        b: { device: pdu.name, port: "input", rack: pdu.rack },
        from_key: `equip:${src.id}`,
        to_key: `rack:${pdu.rack_id}`,
        feed: pdu.feed,
        // Lets the router push B onto different tray segments than A.
        pair_key: `${pdu.rack_id}:${pdu.index}`,
      });
    }

    /* ------------------------------------------------ optional PSU cords -- */
    if (P.emit_device_cords) {
      for (const rack of racks) {
        for (const dev of rack.devices) {
          const sku = C.SERVERS[dev.sku] || C.SWITCHES[dev.sku];
          const psus = (sku && sku.psus) || (dev.kind === "switch" ? 2 : 0);
          if (!psus) continue; // busbar-powered trays have no cords
          for (let n = 1; n <= psus; n++) {
            const feed = feeds[(n - 1) % feeds.length];
            runs.push({
              label: `PC-${feed}-${dev.name}-P${n}`,
              class: "power",
              media: sku && sku.kw / psus > 3 ? "cord-c21" : "cord-c19",
              a: { device: `PDU-${rack.name}-${feed}1`, port: `outlet-${dev.u}-${n}`, rack: rack.name },
              b: { device: dev.name, port: `PSU${n}`, rack: rack.name },
              from_key: `rack:${rack.id}`,
              to_key: `rack:${rack.id}`,
              feed,
              in_rack: true,
            });
          }
        }
      }
    }

    /* ----------------------------------------------------------- totals -- */
    const upsCapacityPerFeed = modulesPerFeed * upsKw;
    const spareModules = P.ups_redundancy === "N+1" ? 1 : 0;
    const upsFirmPerFeed = (modulesPerFeed - spareModules) * upsKw;

    return {
      feeds,
      entrances,
      ups,
      distribution,
      rack_pdus: rackPdus,
      runs,
      notes,
      assignment,
      totals: {
        it_load_kw: DCP.Util.round(itLoadKw, 1),
        mechanical_kw: DCP.Util.round(mechKw, 1),
        facility_kw: DCP.Util.round(facilityKw, 1),
        pue_target: P.pue_target,
        ups_modules_per_feed: modulesPerFeed,
        ups_capacity_per_feed_kw: DCP.Util.round(upsCapacityPerFeed, 1),
        ups_firm_capacity_per_feed_kw: DCP.Util.round(upsFirmPerFeed, 1),
        entrance_capacity_kw: P.entrance_kw,
        distribution_units: distribution.length,
        rack_pdu_count: rackPdus.length,
        rack_pdu_usable_kw: DCP.Util.round(pduUsableKw, 1),
        derate: derate,
      },
    };
  }

  DCP.Power = { plan, kvaOf };
})(typeof globalThis !== "undefined" ? globalThis : this);
