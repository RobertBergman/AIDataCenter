/**
 * The power chain, end to end:
 *
 *   utility     switchboard lineup      RPP or
 *   entrance ─▶ ┌─────────────────┐ ─▶  overhead ─▶ rack PDU ─▶ PSU cords
 *    (A / B)    │ input │ UPS │out│      busway       (A/B)
 *               │   └ bypass ┘   │       (A/B)
 *               └─────────────────┘
 *
 * Three rules shape every number here:
 *
 *  1. Dual-corded IT means each side must survive alone. A and B normally share
 *     the load roughly 50/50, but each is sized for 100% -- otherwise losing a
 *     feed drops the hall. So UPS, RPP and rack-PDU capacity are all sized
 *     against full rack load per side, not half.
 *
 *  2. Continuous load is derated (NEC 80%). A 60 A rack PDU is a 34.5 kW rack
 *     PDU, and a 100 kW NVL72 rack therefore needs three of them per side.
 *
 *  3. Feeders are bought by the metre, so every hop is homed to the *nearest*
 *     source that can carry it, and the gear is sited at the centroid of what it
 *     feeds rather than spread evenly down a wall.
 *
 * The switchboard lineup is why the feeder count is what it is. A service feeder
 * is the most expensive conductor in the room, and the naive chain buys one per
 * UPS module -- six of them on an N+1 ×3 design, all landing in the same 2.6 m
 * strip. A real lineup takes the service once per feed onto an input section;
 * the modules tap its bus, their outputs land on an output section, and the RPP
 * breakers live there too. The maintenance bypass is a wrap-around *inside* that
 * assembly, which is what makes it nearly free in copper: it is bus between two
 * adjacent sections, not a cable across the room.
 *
 * Power is placed and routed on its own pathway tier, physically separated from
 * the data trays, and the B feed is deliberately routed to share as few tray
 * segments with A as the room allows.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  const SQRT3 = Math.sqrt(3);
  const kvaOf = (amps, volts, phases) => (phases === 3 ? volts * amps * SQRT3 : volts * amps) / 1000;

  /** Side clearance between adjacent floor-standing panels, for access and hinge swing. */
  const RPP_GAP_M = 0.2;

  /** Floor of the electrical strip width, before the plant is measured. */
  const DEFAULT_ELEC_M = 2.6;

  /**
   * Separate a column of floor-standing units along y so no two share ground.
   *
   * Two sweeps: forward, so nothing starts before its predecessor ends; then
   * backward from the far wall, so the column stays inside the zone. Units keep
   * as much of their target position as the geometry allows, which matters --
   * they were slid there to sit near their load.
   *
   * @returns metres by which the column overruns the zone (0 when it fits).
   */
  function spaceOutColumn(units, zone, design) {
    if (units.length < 2) return 0;
    const lo = zone ? zone.y0 : design.room.perimeter_m;
    const hi = zone ? zone.y1 : design.room.depth_m - design.room.perimeter_m;

    const needed = DCP.Util.sum(units, (u) => u.d_m) + (units.length - 1) * RPP_GAP_M;
    const spill = Math.max(0, needed - (hi - lo));

    units.sort((a, b) => a.y - b.y || (a.id < b.id ? -1 : 1));

    let cursor = lo;
    for (const u of units) {
      u.y = Math.max(u.y, cursor + u.d_m / 2);
      cursor = u.y + u.d_m / 2 + RPP_GAP_M;
    }
    cursor = hi;
    for (let i = units.length - 1; i >= 0; i--) {
      const u = units[i];
      u.y = Math.min(u.y, cursor - u.d_m / 2);
      cursor = u.y - u.d_m / 2 - RPP_GAP_M;
    }
    // When the zone is genuinely too short the two sweeps fight, and the second
    // one walks the column off the end of the building. Keep every panel inside
    // the zone regardless: the result is panels standing too close, which the
    // collision check reports honestly, rather than a panel drawn outdoors.
    for (const u of units) {
      u.y = DCP.Util.round(DCP.Util.clamp(u.y, lo + u.d_m / 2, Math.max(lo + u.d_m / 2, hi - u.d_m / 2)), 2);
    }
    return spill;
  }

  /**
   * How wide the electrical strip has to be for the plant that stands in it.
   *
   * The zone used to be a constant 2.6 m, which was fine only because nothing
   * checked: UPS modules were spread evenly over the *whole* room depth,
   * perimeter included, so they never collided and never revealed that the strip
   * could not actually hold them. Adding the switchboards made the shortfall
   * real -- two 5 m lineups plus six 1 m modules is 17.4 m of gear queueing for
   * 13.6 m of wall.
   *
   * So the strip is sized rather than assumed. Gear stands in as many parallel
   * columns as the run length needs, and the zone widens to carry them. That
   * costs floor area the rack block would otherwise have had, which is the
   * honest trade -- and it is reported instead of showing up as an overlap.
   *
   * Pure function of the design and its IT load, so `floor.js` can call it
   * before any of this module's own siting has happened.
   */
  function sizeElectricalZone(design, itLoadKw) {
    const C = DCP.Catalog;
    const P = design.power;
    const derate = P.breaker_derate;
    const feeds = P.entrances >= 2 ? 2 : 1;

    const upsSpec = C.UPS[P.ups_model] || C.UPS["ups-500"];
    const upsKw = upsSpec.kva * upsSpec.pf;
    const nModules = Math.max(1, Math.ceil(itLoadKw / upsKw));
    const perFeed = P.ups_redundancy === "2N" ? nModules * 2
      : P.ups_redundancy === "N+1" ? nModules + 1 : nModules;

    const swbdKey = P.switchboard_model && P.switchboard_model !== "auto"
      ? P.switchboard_model
      : C.pickSwitchboard(P.entrance_kw, P.volts, P.phases, derate);
    const swbdSpec = C.SWITCHBOARD[swbdKey] || C.SWITCHBOARD["swbd-2000a"];

    const units = feeds * perFeed;
    // Along-strip length of everything, plus a service gap between neighbours.
    const runLength = feeds * swbdSpec.w_m + units * upsSpec.d_m
      + (feeds + units - 1) * RPP_GAP_M;
    const available = Math.max(1, design.room.depth_m - 2 * design.room.perimeter_m);
    const columns = Math.max(1, Math.ceil(runLength / available));
    // Widest thing standing in a column decides how wide a column has to be.
    const columnWidth = Math.max(upsSpec.w_m, swbdSpec.d_m);

    return {
      columns,
      column_width_m: columnWidth,
      width_m: DCP.Util.round(Math.max(DEFAULT_ELEC_M,
        columns * columnWidth + (columns - 1) * RPP_GAP_M), 2),
      run_length_m: DCP.Util.round(runLength, 2),
      available_m: DCP.Util.round(available, 2),
      ups_modules_per_feed: perFeed,
      switchboard_model: swbdKey,
    };
  }

  /**
   * Stand a feed's switchboard and its UPS modules in the electrical strip.
   *
   * Gear is grouped by feed and each feed gets its own column where the strip is
   * wide enough for one -- which is both how the plant packs and how it should
   * be built anyway, since A and B standing in separate columns is real physical
   * separation rather than two lineups interleaved along one wall.
   *
   * @returns metres of overrun on the worst column (0 when everything fits).
   */
  function layoutLineup(byFeed, zone, columnWidth, columns) {
    const lo = zone.y0;
    const hi = zone.y1;
    const feeds = [...byFeed.keys()];
    let spill = 0;

    // Feeds are assigned to columns whole -- a lineup is not split down the
    // middle -- and packing then happens per column. Packing per *feed* instead
    // is what let two lineups sharing a column each centre themselves on the
    // same midpoint and stand in each other.
    const perColumn = Array.from({ length: Math.max(1, columns) }, () => []);
    feeds.forEach((feed, i) => {
      const col = columns >= feeds.length ? i : i % Math.max(1, columns);
      perColumn[col].push(...byFeed.get(feed));
    });

    perColumn.forEach((units, col) => {
      if (!units.length) return;
      const x = DCP.Util.round(zone.x0 + col * (columnWidth + RPP_GAP_M) + columnWidth / 2, 2);
      const needed = DCP.Util.sum(units, (u) => u.d_m) + (units.length - 1) * RPP_GAP_M;
      spill = Math.max(spill, Math.max(0, needed - (hi - lo)));

      // Centre the column on the load its gear was sited against, then clamp so
      // it stays on the floor.
      const anchor = DCP.Util.sum(units, (u) => u.y) / units.length;
      let cursor = DCP.Util.clamp(anchor - needed / 2, lo, Math.max(lo, hi - needed));
      for (const u of units) {
        u.x = x;
        u.y = DCP.Util.round(DCP.Util.clamp(cursor + u.d_m / 2, lo + u.d_m / 2,
          Math.max(lo + u.d_m / 2, hi - u.d_m / 2)), 2);
        cursor += u.d_m + RPP_GAP_M;
      }
    });

    return spill;
  }

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
            model_name: pduSpec.model,
            // A 0U strip clips to the rail and costs no U; a horizontal unit is
            // seated in the elevation like any other device and takes its bite
            // out of the frame.
            mount: pduSpec.ru
              ? `${pduSpec.ru}U horizontal (${feed} side)`
              : `0U ${feed === "A" ? "left" : "right"} rail`,
            ru: pduSpec.ru || 0,
            amps: pduSpec.amps,
            volts: pduSpec.volts,
            phases: pduSpec.phases,
            kva: DCP.Util.round(pduKva, 1),
            usable_kw: DCP.Util.round(pduUsableKw, 1),
            load_kw: DCP.Util.round(rack.kw / perSide, 2),
            outlets: pduSpec.outlets,
            outlets_c13: pduSpec.outlets_c13 ?? pduSpec.outlets,
            outlets_c19: pduSpec.outlets_c19 ?? 0,
            weight_kg: pduSpec.weight_kg,
          });
        }
      }
      rack.pdus_per_side = perSide;
    }

    /* ------------------------------------------------------- UPS sizing -- */
    // Sized here, sited later: the modules stand in a lineup with their
    // switchboard, and the switchboard cannot be sited until the RPPs it feeds
    // have found their own positions.
    const upsSpec = C.UPS[P.ups_model];
    const upsKw = upsSpec.kva * upsSpec.pf;
    // Mechanical plant normally rides the generator, not the UPS.
    const upsLoadPerFeed = itLoadKw;
    const nModules = Math.max(1, Math.ceil(upsLoadPerFeed / upsKw));
    const modulesPerFeed =
      P.ups_redundancy === "2N" ? nModules * 2 : P.ups_redundancy === "N+1" ? nModules + 1 : nModules;
    const elec = floor.zones.electrical;

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
      // Every panel shares the distribution zone's centreline, so two whose racks
      // share a centroid slide onto the *same square metre* -- A1 and B2 landing
      // on one another is not a layout, it is a drawing error. Push the column
      // apart before reassigning, so the second pass costs whips against where
      // the panels can really stand.
      const spill = spaceOutColumn(distribution.filter((d) => d.kind === "rpp"),
        floor.zones.distribution, design);
      if (spill > 0) {
        notes.push(`distribution zone is ${DCP.Util.round(spill, 2)} m short for ` +
          `${distribution.filter((d) => d.kind === "rpp").length} RPPs at ${RPP_GAP_M} m spacing — ` +
          `panels are packed tighter than the service gap`);
      }
      assignment = assignRacks();

      // Drop panels nothing landed on -- an empty RPP is a line item nobody ordered.
      for (let i = distribution.length - 1; i >= 0; i--) {
        if (distribution[i].kind === "rpp" && distribution[i].serves.length === 0) {
          distribution.splice(i, 1);
        }
      }
    }

    /* -------------------------------------------------- switchboards ----- */
    // One lineup per feed, standing at the load centroid of the distribution it
    // feeds rather than at an arbitrary point on the wall. Every metre the board
    // moves toward its panels is paid for once on the service feeder and saved
    // once on each of the RPP feeders, so the centroid is the right place even
    // though the service has to reach further to get there.
    const swbdKey = P.switchboard_model && P.switchboard_model !== "auto"
      ? P.switchboard_model
      : C.pickSwitchboard(P.entrance_kw, P.volts, P.phases, derate);
    const swbdSpec = C.SWITCHBOARD[swbdKey] || C.SWITCHBOARD["swbd-2000a"];

    const switchboards = [];
    for (const feed of feeds) {
      const fed = distribution.filter((d) => d.feed === feed);
      const load = DCP.Util.sum(fed, (d) => d.load_kw || d.capacity_kw || 0);
      const centroidY = fed.length
        ? DCP.Util.sum(fed, (d) => d.y * (d.load_kw || d.capacity_kw || 1)) / Math.max(1e-9, DCP.Util.sum(fed, (d) => d.load_kw || d.capacity_kw || 1))
        : design.room.depth_m / 2;
      switchboards.push({
        id: `swbd-${feed}`,
        name: `SWBD-${feed}`,
        kind: "switchboard",
        feed,
        model: swbdKey,
        amps: swbdSpec.amps,
        volts: P.volts,
        phases: P.phases,
        capacity_kw: DCP.Util.round(swbdSpec.amps * derate * P.volts * SQRT3 / 1000, 1),
        // The bypass is a section of this lineup, not a separate run. Size it
        // against what it has to carry -- the whole IT load of this feed, since
        // each feed must stand alone -- and not against the frame it sits in.
        // Rating it at the frame buys bus nobody needs; rating it at half the
        // load because A and B normally share is how a hall goes dark during a
        // UPS service window.
        bypass: !!P.maintenance_bypass,
        bypass_rating_kw: DCP.Util.round(itLoadKw, 1),
        downstream_kw: DCP.Util.round(load, 1),
        sections: swbdSpec.sections,
        x: DCP.Util.round((elec.x0 + elec.x1) / 2, 2),
        y: DCP.Util.round(DCP.Util.clamp(centroidY, elec.y0, elec.y1), 2),
        // The lineup runs *along* the electrical strip, not across it: a 5 m
        // switchboard laid broadside would reach straight out of a 2.6 m zone
        // and into the first rack row. Catalog `w_m` is the length of the
        // assembly, so it becomes the y extent here and its depth becomes x.
        w_m: swbdSpec.d_m,
        d_m: swbdSpec.w_m,
        lineup_length_m: swbdSpec.w_m,
        weight_kg: swbdSpec.weight_kg,
      });
    }
    const boardFor = (feed) => switchboards.find((s) => s.feed === feed) || switchboards[0];

    /* --------------------------------------------------- UPS placement --- */
    // Modules stand in their feed's lineup, centred on the board they tap.
    const ups = [];
    for (const feed of feeds) {
      const board = boardFor(feed);
      for (let k = 1; k <= modulesPerFeed; k++) {
        ups.push({
          id: `ups-${feed}${k}`,
          name: `UPS-${feed}${k}`,
          kind: "ups",
          feed,
          model: P.ups_model,
          kva: upsSpec.kva,
          usable_kw: DCP.Util.round(upsKw, 1),
          board: board ? board.id : null,
          x: DCP.Util.round((elec.x0 + elec.x1) / 2, 2),
          // Offset around the board; spaceOutColumn resolves the overlaps below.
          y: DCP.Util.round((board ? board.y : design.room.depth_m / 2)
            + (k - (modulesPerFeed + 1) / 2) * (upsSpec.d_m + RPP_GAP_M), 2),
          w_m: upsSpec.w_m,
          d_m: upsSpec.d_m,
          weight_kg: upsSpec.weight_kg,
          spare: P.ups_redundancy === "N+1" && k === modulesPerFeed,
        });
      }
    }

    // Boards and modules share one strip, so they are laid out together -- one
    // lineup per feed, each starting with its board.
    const elecPlan = sizeElectricalZone(design, itLoadKw);
    const lineups = new Map();
    for (const feed of feeds) {
      lineups.set(feed, [
        ...switchboards.filter((s) => s.feed === feed),
        ...ups.filter((u) => u.feed === feed),
      ]);
    }
    const elecSpill = layoutLineup(lineups, elec, elecPlan.column_width_m, elecPlan.columns);
    if (elecSpill > 0) {
      notes.push(`electrical zone is ${DCP.Util.round(elecSpill, 2)} m short for the ` +
        `${elecPlan.columns}-column lineup (${switchboards.length} switchboard(s), ` +
        `${ups.length} UPS module(s)) — gear is packed tighter than the ${RPP_GAP_M} m service gap`);
    }

    /* ------------------------------------------------------ entrances ---- */
    // The service lands on the wall opposite its own switchboard: a service
    // feeder that has to walk down the room before it turns in is the single
    // most expensive conductor in the building.
    const entrances = [];
    for (let i = 0; i < P.entrances; i++) {
      const feed = feeds[i] || feeds[i % feeds.length];
      const board = boardFor(feed);
      entrances.push({
        id: `entrance-${feed}`,
        name: `SVC-${feed}`,
        kind: "entrance",
        feed,
        side: P.entrance_side,
        capacity_kw: P.entrance_kw,
        volts: P.volts,
        phases: P.phases,
        board: board ? board.id : null,
        x: 0,
        y: board ? board.y : DCP.Util.round(((i + 1) / (P.entrances + 1)) * design.room.depth_m, 2),
      });
    }

    /* --------------------------------------------------------- cabling --- */
    /** Manhattan gap between two sited units, for connections that stay in the lineup. */
    const lineupSpan = (a, b) => DCP.Util.round(Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + 1.0, 2);

    /**
     * Size a run and carry the verdict with it.
     *
     * When nothing on the ladder carries the load the pick still comes back --
     * dropping the circuit would hide the problem -- so the shortfall is stamped
     * on the run and validate.js turns it into an error naming the hop.
     */
    const sized = (kw, lineup) => {
      const s = lineup
        ? C.sizeBusMedia(kw, P.volts, P.phases, derate)
        : C.sizePowerMedia(kw, P.volts, P.phases, derate);
      if (!s.fits) {
        notes.push(`no power media carries ${DCP.Util.round(kw, 0)} kW ` +
          `(${DCP.Util.round(s.amps_needed, 0)} A continuous) at ${P.volts} V — ` +
          `sized up to ${s.key} and still short`);
      }
      return s;
    };

    // Entrance → switchboard input. One service feeder per feed, not one per UPS
    // module: the modules tap the board's bus downstream of this point.
    for (const ent of entrances) {
      const board = boardFor(ent.feed);
      if (!board) continue;
      const s = sized(ent.capacity_kw, false);
      runs.push({
        label: `PS-${ent.feed}-${board.name}`,
        class: "power",
        media: s.key,
        undersized: !s.fits,
        sizing_need: `${DCP.Util.round(s.amps_needed, 0)} A continuous`,
        a: { device: ent.name, port: "service", rack: "entrance" },
        b: { device: board.name, port: "input", rack: "electrical" },
        from_key: `equip:${ent.id}`,
        to_key: `equip:${board.id}`,
        feed: ent.feed,
        // The service enters through the wall and lands on the board's input
        // section a couple of metres away. Routing it over the power tray would
        // charge it a 3.8 m rise and a 3.8 m drop it never makes -- 7.6 m of
        // phantom bus duct at four figures a metre, on the most expensive
        // conductor in the room.
        pathway: "conduit",
        fixed_length_m: lineupSpan(ent, board),
      });
    }

    // Switchboard ⇄ UPS module. Both legs stay inside the lineup, so they are
    // measured across the floor between adjacent gear rather than routed up to
    // the ceiling tray and back -- switchgear interconnections run through the
    // base, and sending them to the tray would triple a 2 m connection.
    const boardPort = new Map();
    for (const u of ups) {
      const board = boardFor(u.feed);
      if (!board) continue;
      const s = sized(u.usable_kw, true);
      const idx = (boardPort.get(board.id) || 0) + 1;
      boardPort.set(board.id, idx);
      const span = lineupSpan(board, u);
      runs.push({
        label: `PU-${u.feed}-${u.name}-IN`,
        class: "power",
        media: s.key,
        undersized: !s.fits,
        sizing_need: `${DCP.Util.round(s.amps_needed, 0)} A continuous`,
        a: { device: board.name, port: `ups-in-${idx}`, rack: "electrical" },
        b: { device: u.name, port: "input", rack: "electrical" },
        from_key: `equip:${board.id}`,
        to_key: `equip:${u.id}`,
        feed: u.feed,
        pathway: "bus",
        lineup: true,
        fixed_length_m: span,
      });
      runs.push({
        label: `PU-${u.feed}-${u.name}-OUT`,
        class: "power",
        media: s.key,
        undersized: !s.fits,
        sizing_need: `${DCP.Util.round(s.amps_needed, 0)} A continuous`,
        a: { device: u.name, port: "output", rack: "electrical" },
        b: { device: board.name, port: `ups-out-${idx}`, rack: "electrical" },
        from_key: `equip:${u.id}`,
        to_key: `equip:${board.id}`,
        feed: u.feed,
        pathway: "bus",
        lineup: true,
        fixed_length_m: span,
      });
    }

    // Maintenance bypass: the wrap-around from the input section to the output
    // section, sized for the whole feed. It is bus between two sections of one
    // assembly, so its length is the width of the lineup -- which is exactly why
    // putting the bypass in the board instead of across the room is worth doing.
    for (const board of switchboards) {
      if (!board.bypass) continue;
      const s = sized(board.bypass_rating_kw, true);
      runs.push({
        label: `PB-${board.feed}-${board.name}`,
        class: "power",
        media: s.key,
        undersized: !s.fits,
        sizing_need: `${DCP.Util.round(s.amps_needed, 0)} A continuous`,
        a: { device: board.name, port: "bypass-in", rack: "electrical" },
        b: { device: board.name, port: "bypass-out", rack: "electrical" },
        from_key: `equip:${board.id}`,
        to_key: `equip:${board.id}`,
        feed: board.feed,
        pathway: "bus",
        lineup: true,
        fixed_length_m: DCP.Util.round(board.lineup_length_m || board.d_m, 2),
      });
    }

    // Switchboard output → RPP / busway riser, each on its own output breaker,
    // homed to the nearest board carrying that feed.
    const outPort = new Map();
    for (const d of distribution) {
      const source = switchboards
        .filter((s) => s.feed === d.feed)
        .sort((a, b) => (Math.abs(a.x - d.x) + Math.abs(a.y - d.y)) - (Math.abs(b.x - d.x) + Math.abs(b.y - d.y)))[0]
        || switchboards[0];
      if (!source) continue;
      const outIdx = (outPort.get(source.id) || 0) + 1;
      outPort.set(source.id, outIdx);
      const s = sized(d.capacity_kw, false);
      runs.push({
        label: `PF-${d.feed}-${d.name}`,
        class: "power",
        media: s.key,
        undersized: !s.fits,
        sizing_need: `${DCP.Util.round(s.amps_needed, 0)} A continuous`,
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
      switchboards,
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
        switchboard_model: swbdKey,
        switchboard_capacity_kw: switchboards.length ? switchboards[0].capacity_kw : 0,
        maintenance_bypass: !!P.maintenance_bypass,
        distribution_units: distribution.length,
        rpp_siting: floor.rpp_siting || "wall",
        slots_lost_to_spine: floor.slots_lost_to_spine || 0,
        rack_pdu_count: rackPdus.length,
        rack_pdu_usable_kw: DCP.Util.round(pduUsableKw, 1),
        rack_pdu_mount: pduSpec.mount || "0U vertical",
        rack_pdu_ru_per_rack: (pduSpec.ru || 0) * rackPdus.length / Math.max(1, racks.length),
        derate: derate,
      },
    };
  }

  DCP.Power = { plan, kvaOf, sizeElectricalZone, layoutLineup, spaceOutColumn };
})(typeof globalThis !== "undefined" ? globalThis : this);
