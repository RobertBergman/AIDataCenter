/**
 * Room geometry: turns width/depth/aisle settings into the discrete set of rack
 * *positions* the placement solver is allowed to use.
 *
 * Layout convention (rows run along X, depth is Y):
 *
 *   ┌────────────────── room ──────────────────┐
 *   │ perimeter keep-clear                     │
 *   │  ELEC │ cold aisle                       │
 *   │  zone │ row 0  (faces north) ██ row 0    │  ─┐
 *   │  UPS  │ hot aisle            ██ …        │   │ back-to-back pair
 *   │  SWBD │ row 1  (faces south) ██ row 1    │  ─┘
 *   │       │ cold aisle           ██          │
 *   └───────────────────────────▲──────────────┘
 *                               └─ DIST spine (RPP column)
 *
 * The RPP column defaults to a spine through the middle of the rack block
 * rather than a strip on the far wall, because the wall position puts the whole
 * rack block between the UPS and the panels and every feeder then crosses the
 * room in one direction while every rack whip crosses back in the other. See
 * `rpp_siting` below for the trade.
 *
 * Rows are built to a single pitch (the widest rack in the design) because a
 * real row is framed to one pitch -- mixing 600 and 750 mm frames mid-row is a
 * cable-management problem nobody wants.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  const ELEC_ZONE_M = 2.6;  // UPS + switchgear strip along the entrance wall
  const DIST_ZONE_M = 1.2;  // RPP column footprint
  const SPINE_GAP_M = 0.6;  // door swing / working clearance either side of a spine

  /**
   * @param {object} design
   * @param {object} [opts]  `electrical_width_m` sizes the electrical strip to
   *   the plant that will stand in it (see Power.sizeElectricalZone). Omitted,
   *   the strip falls back to the nominal width, which is only safe before the
   *   load is known.
   */
  function plan(design, opts = {}) {
    const C = DCP.Catalog;
    const room = design.room;

    // Rack frames present in this design set the row pitch and depth.
    const types = design.racks.map((r) => C.RACK_TYPES[r.rack_type] || C.RACK_TYPES["600-48u"]);
    const pitch = types.length ? Math.max(...types.map((t) => t.w_m)) : 0.6;
    let rowDepth = types.length ? Math.max(...types.map((t) => t.d_m)) : 1.2;

    // A rear-door heat exchanger hangs off the back of the frame and eats aisle.
    const rdhx = design.cooling.mode === "water" && design.cooling.water_type === "rdhx";
    if (rdhx) rowDepth += C.RDHX[design.cooling.rdhx_model].adds_depth_m;

    const elecWidth = Math.max(ELEC_ZONE_M, opts.electrical_width_m || 0);
    const elecZone = { x0: room.perimeter_m, x1: room.perimeter_m + elecWidth };
    const busway = design.power.distribution === "busway";

    /**
     * Where the RPP column stands.
     *
     * "wall" parks it against the far wall, which is tidy on a drawing and
     * expensive in copper: the UPS is on the *other* wall with the whole rack
     * block between them, so every feeder crosses the room eastbound and every
     * rack whip crosses back westbound. Moving the column next to the UPS does
     * not help either -- it only swaps which of the two hops pays, and the whips
     * are the more numerous hop.
     *
     * "spine" carves the strip out of the middle of the rack block instead, so
     * feeders and whips are both short. It costs the rack slots the strip sits
     * on, which is the trade being made: floor area for feeder copper.
     *
     * "auto" (the default) takes the spine only where the room can pay for it.
     * A spine is a fine trade in a hall with slack and a bad one in a pod, where
     * the strip plus its clearances can take most of a short row -- and a design
     * that no longer fits its own room is a worse answer than a longer feeder.
     */
    const requested = busway ? "none" : (design.power.rpp_siting || "auto");
    const blockX0 = elecZone.x1 + 0.6;
    const blockX1 = room.width_m - room.perimeter_m;

    const zoneFor = (s) => {
      if (s === "wall") return { x0: blockX1 - DIST_ZONE_M, x1: blockX1 };
      if (s === "spine") {
        const mid = (blockX0 + blockX1) / 2;
        return { x0: mid - DIST_ZONE_M / 2, x1: mid + DIST_ZONE_M / 2 };
      }
      return null;
    };
    const usableFor = (s, zone) => ({
      x0: blockX0,
      // A wall strip is carved off the end of the block; a spine is carved out
      // of the middle, once the slot grid exists.
      x1: s === "wall" ? zone.x0 - 0.6 : blockX1,
      y0: room.perimeter_m,
      y1: room.depth_m - room.perimeter_m,
    });

    const cold = room.cold_aisle_m;
    const hot = room.hot_aisle_m;
    const usableD = room.depth_m - 2 * room.perimeter_m;

    // Rows depend only on depth, so they are the same whichever way the RPP
    // column is sited and are built once.
    const pairDepth = 2 * rowDepth + hot + cold;
    const pairs = Math.max(0, Math.floor((usableD - cold) / pairDepth));

    const rows = [];
    const aisles = [];
    let y = room.perimeter_m;
    aisles.push({ type: "cold", y0: y, y1: y + cold, y: y + cold / 2 });
    y += cold;

    for (let p = 0; p < pairs; p++) {
      rows.push({
        index: rows.length, pair: p, facing: "north",
        y0: y, y1: y + rowDepth, y: y + rowDepth / 2,
        cold_aisle_y: y - cold / 2, hot_aisle_y: y + rowDepth + hot / 2,
      });
      y += rowDepth;

      aisles.push({ type: "hot", y0: y, y1: y + hot, y: y + hot / 2 });
      y += hot;

      rows.push({
        index: rows.length, pair: p, facing: "south",
        y0: y, y1: y + rowDepth, y: y + rowDepth / 2,
        cold_aisle_y: y + rowDepth + cold / 2, hot_aisle_y: y - hot / 2,
      });
      y += rowDepth;

      aisles.push({ type: "cold", y0: y, y1: y + cold, y: y + cold / 2 });
      y += cold;
    }

    /**
     * The slot grid for one siting choice.
     *
     * Slot indices stay tied to the grid rather than being renumbered around the
     * spine, so a gap in the sequence is exactly what it looks like: a slot the
     * spine is standing in. `takeFreeRun` tests slot adjacency to seat wide gear,
     * and the gap correctly stops a run from spanning the spine.
     */
    const gridFor = (s) => {
      const zone = zoneFor(s);
      const use = usableFor(s, zone || { x0: blockX1, x1: blockX1 });
      const slotsPerRow = Math.max(0, Math.floor((use.x1 - use.x0) / pitch));
      // A spine stands inside the rack rows, so it needs working clearance in
      // front of the panel doors on top of its own footprint.
      const blocked = s === "spine"
        ? { x0: zone.x0 - SPINE_GAP_M, x1: zone.x1 + SPINE_GAP_M }
        : null;

      const positions = [];
      let blockedSlots = 0;
      for (const row of rows) {
        for (let i = 0; i < slotsPerRow; i++) {
          const x = use.x0 + (i + 0.5) * pitch;
          if (blocked && x + pitch / 2 > blocked.x0 && x - pitch / 2 < blocked.x1) {
            blockedSlots++;
            continue;
          }
          positions.push({
            id: `p${row.index}-${i}`,
            row: row.index,
            slot: i,
            x,
            y: row.y,
            facing: row.facing,
            service_aisle_y: row.facing === "north" ? row.cold_aisle_y : row.cold_aisle_y,
            hot_aisle_y: row.hot_aisle_y,
          });
        }
      }
      return { siting: s, zone, usable: use, slotsPerRow, positions, blockedSlots };
    };

    // In-row cooling gear claims free positions too, so a grid that exactly fits
    // the racks does not actually fit the design. Ask for a little headroom.
    const needed = design.racks.length
      + (design.cooling.mode === "water" && design.cooling.water_type === "dlc"
        ? Math.ceil(design.racks.length / Math.max(1, design.cooling.racks_per_cdu)) : 0);

    let grid;
    if (requested === "auto") {
      grid = gridFor("spine");
      if (grid.positions.length < needed) {
        const fallback = gridFor("wall");
        // Only fall back if it genuinely buys room -- in a pod too small for
        // either, the spine at least keeps the feeders short.
        if (fallback.positions.length > grid.positions.length) grid = fallback;
      }
    } else {
      grid = gridFor(requested);
    }

    const siting = grid.siting;
    const distZone = grid.zone;
    const usable = grid.usable;
    const slotsPerRow = grid.slotsPerRow;
    const positions = grid.positions;
    const blockedSlots = grid.blockedSlots;
    const usableW = usable.x1 - usable.x0;

    return {
      pitch, rowDepth, pairs, slotsPerRow, rows, aisles, positions, usable,
      rpp_siting: siting,
      electrical_width_m: DCP.Util.round(elecWidth, 2),
      // What the spine cost in rack slots -- the other half of the trade, and the
      // number the report has to show next to the copper it saved.
      slots_lost_to_spine: blockedSlots,
      zones: {
        electrical: { ...elecZone, y0: room.perimeter_m, y1: room.depth_m - room.perimeter_m },
        distribution: distZone
          ? { ...distZone, y0: room.perimeter_m, y1: room.depth_m - room.perimeter_m, siting }
          : null,
      },
      area_m2: DCP.Util.round(room.width_m * room.depth_m, 1),
      usable_area_m2: DCP.Util.round(usableW * usableD, 1),
      capacity: positions.length,
      rdhx_depth_applied: rdhx,
    };
  }

  /**
   * Snap a dragged rack to the nearest legal position so manual overrides land
   * on the row grid instead of floating between aisles.
   */
  function nearestPosition(floor, x, y) {
    let best = null;
    let bestD = Infinity;
    for (const p of floor.positions) {
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  DCP.Floor = { plan, nearestPosition, ELEC_ZONE_M, DIST_ZONE_M, SPINE_GAP_M };
})(typeof globalThis !== "undefined" ? globalThis : this);
