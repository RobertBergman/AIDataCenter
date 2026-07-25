/**
 * Room geometry: turns width/depth/aisle settings into the discrete set of rack
 * *positions* the placement solver is allowed to use.
 *
 * Layout convention (rows run along X, depth is Y):
 *
 *   ┌──────────── room ────────────┐
 *   │ perimeter keep-clear         │
 *   │  ELEC │ cold aisle           │
 *   │  zone │ row 0  (faces north) │  ─┐
 *   │       │ hot aisle            │   │ back-to-back pair
 *   │       │ row 1  (faces south) │  ─┘
 *   │       │ cold aisle           │
 *   │       │ …                    │ DIST zone (RPP / busway risers)
 *   └──────────────────────────────┘
 *
 * Rows are built to a single pitch (the widest rack in the design) because a
 * real row is framed to one pitch -- mixing 600 and 750 mm frames mid-row is a
 * cable-management problem nobody wants.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  const ELEC_ZONE_M = 2.6;  // UPS + switchgear strip along the entrance wall
  const DIST_ZONE_M = 1.2;  // RPP / busway riser strip on the opposite wall

  function plan(design) {
    const C = DCP.Catalog;
    const room = design.room;

    // Rack frames present in this design set the row pitch and depth.
    const types = design.racks.map((r) => C.RACK_TYPES[r.rack_type] || C.RACK_TYPES["600-48u"]);
    const pitch = types.length ? Math.max(...types.map((t) => t.w_m)) : 0.6;
    let rowDepth = types.length ? Math.max(...types.map((t) => t.d_m)) : 1.2;

    // A rear-door heat exchanger hangs off the back of the frame and eats aisle.
    const rdhx = design.cooling.mode === "water" && design.cooling.water_type === "rdhx";
    if (rdhx) rowDepth += C.RDHX[design.cooling.rdhx_model].adds_depth_m;

    const elecZone = { x0: room.perimeter_m, x1: room.perimeter_m + ELEC_ZONE_M };
    const distZone = { x0: room.width_m - room.perimeter_m - DIST_ZONE_M, x1: room.width_m - room.perimeter_m };
    const busway = design.power.distribution === "busway";

    const usable = {
      x0: elecZone.x1 + 0.6,
      x1: (busway ? room.width_m - room.perimeter_m : distZone.x0) - 0.6,
      y0: room.perimeter_m,
      y1: room.depth_m - room.perimeter_m,
    };

    const cold = room.cold_aisle_m;
    const hot = room.hot_aisle_m;
    const usableW = usable.x1 - usable.x0;
    const usableD = usable.y1 - usable.y0;

    // Depth consumed by one back-to-back pair, including its trailing cold aisle.
    const pairDepth = 2 * rowDepth + hot + cold;
    const pairs = Math.max(0, Math.floor((usableD - cold) / pairDepth));
    const slotsPerRow = Math.max(0, Math.floor(usableW / pitch));

    const rows = [];
    const aisles = [];
    let y = usable.y0;
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

    // Candidate positions, ordered row-major. The QAP solver permutes racks over
    // these; nothing downstream may assume rack i sits at position i.
    const positions = [];
    for (const row of rows) {
      for (let s = 0; s < slotsPerRow; s++) {
        positions.push({
          id: `p${row.index}-${s}`,
          row: row.index,
          slot: s,
          x: usable.x0 + (s + 0.5) * pitch,
          y: row.y,
          facing: row.facing,
          service_aisle_y: row.facing === "north" ? row.cold_aisle_y : row.cold_aisle_y,
          hot_aisle_y: row.hot_aisle_y,
        });
      }
    }

    return {
      pitch, rowDepth, pairs, slotsPerRow, rows, aisles, positions, usable,
      zones: {
        electrical: { ...elecZone, y0: room.perimeter_m, y1: room.depth_m - room.perimeter_m },
        distribution: busway ? null : { ...distZone, y0: room.perimeter_m, y1: room.depth_m - room.perimeter_m },
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

  DCP.Floor = { plan, nearestPosition, ELEC_ZONE_M, DIST_ZONE_M };
})(typeof globalThis !== "undefined" ? globalThis : this);
