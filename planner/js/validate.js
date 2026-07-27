/**
 * Constraint checking.
 *
 * The planner will happily *build* an illegal room -- that is deliberate. You
 * find out what breaks by seeing it break, so every violation is reported with
 * the number that failed and the number it needed to be, and nothing is quietly
 * auto-corrected behind the user's back.
 *
 * severity: "error" = not buildable as drawn · "warn" = buildable, but someone
 * is going to be unhappy · "info" = worth knowing.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  function check(model) {
    const out = [];
    const add = (severity, code, message, subject) => out.push({ severity, code, message, subject });
    const { design, floor, racks, cables, cooling, power, fabric, totals } = model;
    const C = DCP.Catalog;
    const R = DCP.Util.round;

    /* ------------------------------------------------------------ room --- */
    if (floor.capacity < racks.length) {
      add("error", "room.capacity",
        `room fits ${floor.capacity} rack positions but ${racks.length} racks are placed — enlarge the room or remove racks`,
        "room");
    }
    if (floor.rows.length === 0) {
      add("error", "room.rows",
        `no complete row fits: ${design.room.depth_m} m depth cannot hold ${R(floor.rowDepth, 2)} m of rack plus ${design.room.cold_aisle_m} m cold and ${design.room.hot_aisle_m} m hot aisle`,
        "room");
    }
    if (design.room.cold_aisle_m < 1.2) {
      add("warn", "room.cold_aisle",
        `cold aisle ${design.room.cold_aisle_m} m is below the 1.2 m needed to pull a chassis onto a lift`, "room");
    }
    if (design.room.hot_aisle_m < 0.9) {
      add("warn", "room.hot_aisle",
        `hot aisle ${design.room.hot_aisle_m} m leaves no room to service rear cabling`, "room");
    }
    if (design.room.clear_height_m < design.room.power_tray_height_m + 0.5) {
      add("error", "room.height",
        `clear height ${design.room.clear_height_m} m cannot carry a power tray at ${design.room.power_tray_height_m} m`,
        "room");
    }

    /* ------------------------------------------------------------ racks --- */
    for (const rack of racks) {
      if (rack.u_used > rack.u_height) {
        add("error", "rack.ru",
          `${rack.name}: ${rack.u_used}U of equipment in a ${rack.u_height}U frame (${rack.u_used - rack.u_height}U over)`,
          rack.name);
      }
      // Elevation overlap.
      const occupied = new Map();
      for (const dev of rack.devices) {
        for (let u = dev.u; u < dev.u + dev.ru; u++) {
          if (occupied.has(u)) {
            add("error", "rack.overlap",
              `${rack.name}: ${dev.name} and ${occupied.get(u)} both occupy U${u}`, rack.name);
          }
          occupied.set(u, dev.name);
        }
      }
      if (rack.kw > cooling.per_rack_cap_kw) {
        add("error", "cooling.rack_cap",
          `${rack.name} draws ${rack.kw} kW but ${labelMode(cooling)} tops out at ${cooling.per_rack_cap_kw} kW/rack`,
          rack.name);
      }
      // Floor loading over the rack footprint.
      const foot = rack.frame.w_m * rack.frame.d_m;
      const load = rack.weight_kg / foot;
      if (load > design.room.floor_capacity_kg_m2) {
        add("error", "room.floor_load",
          `${rack.name}: ${R(load, 0)} kg/m² exceeds the ${design.room.floor_capacity_kg_m2} kg/m² floor rating`,
          rack.name);
      } else if (load > design.room.floor_capacity_kg_m2 * 0.85) {
        add("warn", "room.floor_load",
          `${rack.name}: ${R(load, 0)} kg/m² is within 15% of the floor rating`, rack.name);
      }
      if (!DCP.Design.layoutLegalUnder(rack.layout, design.cooling.mode)) {
        add("error", "cooling.layout",
          `${rack.name}: ${C.RACK_LAYOUTS[rack.layout].name} has no ${design.cooling.mode}-cooled variant`,
          rack.name);
      }
    }

    /* ------------------------------------------------- floor collisions --- */
    // Two things cannot stand on the same square metre. Worth checking rather
    // than assuming: floor positions are cut to the row pitch, so anything wider
    // than a rack silently overhangs its neighbours, and equipment that gets
    // slid toward the load it serves can be slid straight into a peer.
    //
    // Attachments are skipped on purpose -- a rack manifold or a rear-door heat
    // exchanger hangs on a frame rather than standing on the floor, and carries a
    // zero footprint to say so (rear-door depth is already in the row pitch).
    const COLLIDE_TOL_M = 0.005;
    const footprints = [
      ...racks
        .filter((r) => r.x !== undefined && r.y !== undefined)
        .map((r) => ({ name: r.name, kind: "rack", x: r.x, y: r.y, w: r.frame.w_m, d: r.frame.d_m })),
      ...(model.equipment || [])
        .filter((e) => e.x !== undefined && e.y !== undefined && e.w_m > 0 && e.d_m > 0)
        .map((e) => ({ name: e.name || e.id, kind: e.kind || "equipment", x: e.x, y: e.y, w: e.w_m, d: e.d_m })),
    ];
    for (let i = 0; i < footprints.length; i++) {
      for (let j = i + 1; j < footprints.length; j++) {
        const a = footprints[i];
        const b = footprints[j];
        const ox = (a.w + b.w) / 2 - Math.abs(a.x - b.x);
        const oy = (a.d + b.d) / 2 - Math.abs(a.y - b.y);
        if (ox > COLLIDE_TOL_M && oy > COLLIDE_TOL_M) {
          add("error", "room.collision",
            `${a.name} (${a.kind}) and ${b.name} (${b.kind}) occupy the same floor space — ` +
            `they overlap by ${R(ox, 2)} × ${R(oy, 2)} m`,
            a.name);
        }
      }
    }

    /* ------------------------------------------- placement constraints --- */
    // The solver is told about these before it places anything, so reaching this
    // code with a violation means something downstream of the search overrode it
    // -- a pin, or a rack whose rules could not all be met at once. Either way it
    // is the user's call now, so it is reported rather than silently accepted.
    const con = (model.optimization && model.optimization.constraints) || null;
    if (con) {
      if (con.hard_violations > 0) {
        add("error", "placement.constraint",
          `${con.hard_violations} rack(s) stand where a hard placement rule forbids — ` +
          `check pinned racks and the haul limit`, null);
      }
      if (con.bay.bays_over > 0) {
        add("error", "room.distributed_load",
          `${con.bay.bays_over} structural bay(s) carry more than the ` +
          `${con.bay.capacity_kg_m2} kg/m² distributed rating — ` +
          `${con.bay.overload_kg} kg over in total, peak ${con.bay.peak_kg_m2} kg/m²`, null);
      } else if (con.bay.peak_kg_m2 > con.bay.capacity_kg_m2 * 0.85) {
        add("warn", "room.distributed_load",
          `peak distributed load ${con.bay.peak_kg_m2} kg/m² is within 15% of the ` +
          `${con.bay.capacity_kg_m2} kg/m² rating over ${con.bay.bay_size_m} m bays`, null);
      }
      if (con.reserve && con.reserve.racks_inside > 0) {
        add("warn", "room.expansion",
          `${con.reserve.racks_inside} rack(s) sit inside the growth reserve ` +
          `(beyond y=${con.reserve.y0_m} m) — the room has no room left to grow into`, null);
      }
    }

    // A pod is a contiguous block of floor. A rack outside its own block means
    // the containment mask was overridden, and the pod is no longer a pod.
    const podPlan = (model.optimization && model.optimization.pods) || null;
    if (podPlan && podPlan.enabled) {
      for (const pod of podPlan.list) {
        if (!pod.bounds) continue;
        for (const name of pod.rack_names) {
          const rack = racks.find((r) => r.name === name);
          if (!rack || rack.x === undefined) continue;
          const b = pod.bounds;
          const tol = 1e-6;
          if (rack.x < b.x0 - tol || rack.x > b.x1 + tol || rack.y < b.y0 - tol || rack.y > b.y1 + tol) {
            add("error", "pod.containment",
              `${rack.name} is assigned to ${pod.name} but stands at ` +
              `(${R(rack.x, 2)}, ${R(rack.y, 2)}), outside that pod's block`, rack.name);
          }
        }
      }
    }

    /* ---------------------------------------------------------- cooling --- */
    if (cooling.capacity_kw < totals.it_load_kw) {
      add("error", "cooling.capacity",
        `cooling capacity ${cooling.capacity_kw} kW is below the ${totals.it_load_kw} kW IT load`, "cooling");
    } else if (cooling.capacity_kw < totals.it_load_kw * 1.1) {
      add("warn", "cooling.headroom",
        `only ${R(cooling.capacity_kw - totals.it_load_kw, 1)} kW of cooling headroom`, "cooling");
    }
    if (cooling.mode === "water" && cooling.water_type === "dlc" && cooling.residual_air_kw > 0) {
      add("info", "cooling.residual_air",
        `direct-liquid still leaves ${cooling.residual_air_kw} kW to the air path (PSUs, DIMMs, NICs) — the room still needs air handling`,
        "cooling");
    }

    /* ------------------------------------------------------------ power --- */
    const t = power.totals;
    if (power.feeds.length >= 2) {
      // Dual-corded: either service alone has to carry the hall.
      if (t.entrance_capacity_kw < t.facility_kw) {
        add("error", "power.entrance",
          `each ${t.entrance_capacity_kw} kW service must carry the full ${t.facility_kw} kW facility load when the other fails`,
          "power");
      }
    } else if (t.entrance_capacity_kw < t.facility_kw) {
      add("error", "power.entrance",
        `single service ${t.entrance_capacity_kw} kW is below the ${t.facility_kw} kW facility load`, "power");
    }
    if (power.feeds.length < 2) {
      add("warn", "power.redundancy",
        "one utility entrance means no A/B diversity — any upstream fault drops the hall", "power");
    }
    if (t.ups_firm_capacity_per_feed_kw < t.it_load_kw) {
      add("error", "power.ups",
        `UPS firm capacity ${t.ups_firm_capacity_per_feed_kw} kW/feed is below the ${t.it_load_kw} kW IT load it must carry alone`,
        "power");
    }
    for (const d of power.distribution) {
      if (d.kind === "rpp") {
        if (d.load_kw > d.capacity_kw) {
          add("error", "power.rpp",
            `${d.name}: ${d.load_kw} kW on a ${d.capacity_kw} kW panel (80% derated)`, d.name);
        }
        if (d.poles_used > d.poles) {
          add("error", "power.poles",
            `${d.name}: ${d.poles_used} breaker poles needed, ${d.poles} available`, d.name);
        }
      } else if (d.load_kw > d.capacity_kw) {
        add("error", "power.busway",
          `${d.name}: ${d.load_kw} kW on a ${d.capacity_kw} kW run`, d.name);
      }
    }
    /* --------------------------------------------- switchboard + bypass --- */
    for (const board of power.switchboards || []) {
      if (board.capacity_kw < t.it_load_kw) {
        add("error", "power.switchboard",
          `${board.name}: ${board.capacity_kw} kW frame on a feed that must carry ${t.it_load_kw} kW alone`,
          board.name);
      }
      if (!board.bypass) {
        add("warn", "power.bypass",
          `${board.name} has no maintenance bypass — the UPS cannot be taken out of the path for service ` +
          `without dropping the whole ${board.feed} feed`, board.name);
      } else if (board.bypass_rating_kw < t.it_load_kw) {
        add("error", "power.bypass",
          `${board.name}: bypass rated ${board.bypass_rating_kw} kW but has to carry ${t.it_load_kw} kW ` +
          `on its own while the UPS is out`, board.name);
      }
    }

    // A run whose media could not be found on the ladder is emitted anyway so it
    // is visible; this is where it gets named. Covers both chains: a feeder that
    // no conductor carries and a hose that no bore passes are the same failure.
    for (const c of cables) {
      if (!c.undersized) continue;
      add("error", c.class === "coolant" ? "cooling.flow" : "power.ampacity",
        `${c.label}: no ${c.class === "coolant" ? "hose or pipe" : "power media"} carries this run — ` +
        `sized up to ${c.media} and still short` +
        (c.sizing_need ? ` of ${c.sizing_need}` : ""),
        c.label);
    }

    const pduByRack = DCP.Util.groupBy(power.rack_pdus, (p) => `${p.rack}:${p.feed}`);
    for (const [key, pdus] of pduByRack) {
      const rack = racks.find((r) => r.name === pdus[0].rack);
      if (!rack) continue;
      const side = DCP.Util.sum(pdus, (p) => p.usable_kw);
      if (side < rack.kw) {
        add("error", "power.rack_pdu",
          `${key}: ${R(side, 1)} kW of PDU on a side that must carry ${rack.kw} kW alone`, pdus[0].rack);
      }

      // Capacity is not the only way a PDU runs out. Cords need connectors, and
      // the high-draw ones need C19 specifically -- a PDU can have plenty of
      // kilowatts left and nowhere to plug the next PSU in.
      const feeds = power.feeds.length || 1;
      let need = 0;
      let needC19 = 0;
      for (const dev of rack.devices) {
        if (dev.kind !== "server" || dev.busbar_powered || !dev.psus) continue;
        const sku = DCP.Catalog.SERVERS[dev.sku];
        const perSide = Math.ceil(dev.psus / feeds);
        need += perSide;
        if (sku && sku.psu_kw > 2) needC19 += perSide;
      }
      const have = DCP.Util.sum(pdus, (p) => p.outlets || 0);
      const haveC19 = DCP.Util.sum(pdus, (p) => p.outlets_c19 || 0);
      if (need > have) {
        add("error", "power.outlets",
          `${key}: ${need} cords on this side but only ${have} outlets across ${pdus.length} PDU(s)`,
          pdus[0].rack);
      } else if (needC19 > haveC19) {
        add("error", "power.outlets",
          `${key}: ${needC19} high-draw cords need C19 but the side offers ${haveC19}`,
          pdus[0].rack);
      }
    }
    const sharedAB = cables.filter((c) => c.class === "power" && c.shared_segments_with_a > 0);
    if (sharedAB.length) {
      add("warn", "power.diversity",
        `${sharedAB.length} B-feed runs still share tray segments with their A-feed pair — the room offers no fully disjoint path`,
        "power");
    }

    /* ----------------------------------------------------------- fabric --- */
    const portUse = new Map();
    for (const cable of cables) {
      for (const end of [cable.a, cable.b]) {
        if (!end || !end.device) continue;
        const k = `${end.device}|${end.port}`;
        portUse.set(k, (portUse.get(k) || 0) + 1);
      }
    }
    for (const [k, n] of portUse) {
      if (n > 1) {
        add("error", "fabric.port_conflict", `${k.replace("|", " port ")} is cabled ${n} times`, k.split("|")[0]);
      }
    }
    for (const sw of fabric.switches) {
      // Only front-panel data ports count against the port budget; Management1
      // is a separate RJ45 and must not make a full switch look over-subscribed.
      const used = cables.filter((c) =>
        (c.a && c.a.device === sw.id && /^Ethernet/.test(c.a.port)) ||
        (c.b && c.b.device === sw.id && /^Ethernet/.test(c.b.port))).length;
      const capacity = sw.ports + (C.SWITCHES[sw.sku].uplink_ports || 0);
      if (used > capacity) {
        add("error", "fabric.ports",
          `${sw.name}: ${used} cables on a ${capacity}-port ${sw.model}`, sw.name);
      }
      sw.ports_used = used;
    }
    if (fabric.leaves.length) {
      const achieved = fabric.split.down / fabric.split.up;
      if (Math.abs(achieved - design.fabric.oversubscription) > 0.35) {
        add("info", "fabric.oversubscription",
          `port split gives ${R(achieved, 2)}:1, not the requested ${design.fabric.oversubscription}:1 — a ${C.SWITCHES[design.fabric.leaf_model].ports}-port leaf cannot divide evenly`,
          "fabric");
      }
    }

    /* ----------------------------------------------------------- cables --- */
    const labels = new Map();
    for (const cable of cables) {
      labels.set(cable.label, (labels.get(cable.label) || 0) + 1);
      if (cable.unroutable) {
        add("error", "cable.unroutable",
          `${cable.label}: no pathway exists between its endpoints`, cable.label);
      }
      if (cable.media === "UNREACHABLE") {
        add("error", "cable.reach",
          `${cable.label}: ${cable.length_m} m exceeds every available ${cable.speed_gbps}G medium — move the racks closer or add a patch point`,
          cable.label);
      }
      const spec = C.MEDIA[cable.media];
      if (spec && cable.length_m > spec.max_m) {
        add("error", "cable.reach",
          `${cable.label}: ${cable.length_m} m on ${spec.name} (max ${spec.max_m} m)`, cable.label);
      }
    }
    for (const [label, n] of labels) {
      if (n > 1) add("error", "cable.duplicate_label", `label ${label} is used ${n} times`, label);
    }

    /* ------------------------------------------------------------ trays --- */
    for (const tier of ["data", "power"]) {
      const u = model.optimization.routing[`${tier}_tray`];
      if (!u) continue;
      if (u.over_fill_segments > 0) {
        add("error", "tray.fill",
          `${u.over_fill_segments} ${tier} tray segments are over 100% fill (peak ${R(u.peak_fill * 100, 0)}%) — add a pathway or spread the racks`,
          tier);
      } else if (u.peak_fill > 0.8) {
        add("warn", "tray.fill",
          `peak ${tier} tray fill ${R(u.peak_fill * 100, 0)}% leaves little room for moves and adds`, tier);
      }
    }

    /* -------------------------------------------------- workload locality - */
    const tpCrossing = countCrossing(model, DCP.Graph.W_TP);
    if (tpCrossing > 0) {
      add("warn", "workload.tp_split",
        `${tpCrossing} tensor-parallel peer links cross a rack boundary — TP traffic should stay inside one rack`,
        "workload");
    }

    /* ----------------------------------------------- build-stage notes ---- */
    // fabric.js, cooling.js and power.js each report what only they can see: a
    // CDU with no run of slots wide enough to stand on, a distribution zone too
    // short for its own panels. Those were collected into model.warnings and
    // surfaced nowhere but the YAML dump, which is the one place nobody looks
    // when the drawing is wrong. Same channel as everything else, at the end so
    // the specific checks above are read first.
    const seen = new Set(out.map((o) => o.message));
    for (const note of model.warnings || []) {
      if (!seen.has(note)) add("warn", "build.note", note, null);
    }

    const errors = out.filter((o) => o.severity === "error").length;
    const warns = out.filter((o) => o.severity === "warn").length;
    return { items: out, errors, warnings: warns, ok: errors === 0 };
  }

  /** How many high-weight (TP-class) demand edges the partition failed to keep local. */
  function countCrossing(model, threshold) {
    const { traffic, fleet, racks } = model;
    if (!traffic || !traffic.edges) return 0;
    const home = new Map();
    for (const rack of racks) {
      for (const dev of rack.devices) home.set(dev.name, rack.id);
    }
    // Map fleet server order onto the emitted device names by class order.
    const order = [];
    for (const rack of racks) {
      for (const dev of rack.devices) if (dev.kind === "server") order.push({ name: dev.name, rackId: rack.id });
    }
    const byName = new Map(order.map((o) => [o.name, o.rackId]));
    let crossing = 0;
    const names = [...byName.keys()];
    for (const e of traffic.edges) {
      if (e.w < threshold) continue;
      const a = names[e.a];
      const b = names[e.b];
      if (a === undefined || b === undefined) continue;
      if (byName.get(a) !== byName.get(b)) crossing++;
    }
    return crossing;
  }

  function labelMode(cooling) {
    if (cooling.mode === "air") return "contained air";
    return cooling.water_type === "rdhx" ? "rear-door heat exchangers" : "direct-to-chip liquid";
  }

  DCP.Validate = { check };
})(typeof globalThis !== "undefined" ? globalThis : this);
