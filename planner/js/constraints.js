/**
 * Hard constraints and the penalties that stand in for them.
 *
 * Every engineering rule in this planner used to be checked in validate.js,
 * which runs *after* placement. That ordering is the bug: the solver would
 * happily pile every heavy rack into one structural bay, and the only feedback
 * was a warning on a layout that had already been committed to. A constraint
 * the optimiser cannot see is not a constraint, it is a complaint.
 *
 * So the rules are split by shape, because the two shapes need different
 * machinery:
 *
 *   mask     -- per (rack, position). "This rack may not stand here", full stop:
 *               it is outside its pod, or too heavy to be hauled that far from
 *               the door. Enforced by rejecting the move, so an infeasible
 *               layout is never even evaluated.
 *
 *   penalty  -- aggregate, and priced. "Too much weight in this bay", "this rack
 *               is a long walk from the service corridor". These are capacity
 *               and comfort rules that no single rack violates on its own, so
 *               they cannot be a per-cell test; they are charged into the
 *               objective in dollars and traded against cable like everything
 *               else.
 *
 * A hard rule expressed as a penalty gets a deliberately brutal price, which is
 * the standard treatment -- steep enough that the solver will not buy its way
 * through, finite so that a design starting in violation can still climb out.
 * An infinite penalty is a wall, and a wall the annealer starts behind is a wall
 * it never crosses.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  /** What a kilogram of structural overload costs the objective. Steep on purpose. */
  const OVERLOAD_USD_PER_KG = 40;

  /** Annualised cost of a metre of technician walk, per unit of serviceability. */
  const ACCESS_USD_PER_M = 90;

  /**
   * How often a rack gets opened, relative to a compute rack.
   *
   * Liquid-cooled GPU racks are the ones people are forever in: drives, optics,
   * cold-plate hoses, the occasional tray swap. Management and network racks are
   * comparatively set-and-forget, so parking them at the far end of the hall is
   * cheap and parking the GPU rows there is not.
   */
  const SERVICE_WEIGHT = { compute: 1.0, storage: 0.7, network: 0.4, mgmt: 0.3 };

  /** Where the room is served from -- the door parts and people come through. */
  function accessPoint(design, floor) {
    const room = design.room;
    const side = design.room.access_side || "south";
    const midX = room.width_m / 2;
    const midY = room.depth_m / 2;
    if (side === "north") return { x: midX, y: room.depth_m };
    if (side === "east") return { x: room.width_m, y: midY };
    if (side === "west") return { x: 0, y: midY };
    return { x: midX, y: 0 };
  }

  /**
   * The slice of floor held back for the next phase.
   *
   * Expressed as a fraction of usable depth taken from the far side of the room,
   * because that is how halls actually grow -- you build out from the entrance
   * and leave the far end empty, rather than leaving a hole in the middle.
   * Returning null when the fraction is zero keeps the term out of the objective
   * entirely rather than adding a row of zeroes to every lookup.
   */
  function reserveZone(design, floor) {
    const frac = DCP.Util.clamp(design.expansion?.reserve_fraction ?? 0, 0, 0.9);
    if (frac <= 0) return null;
    const y0 = floor.usable.y1 - frac * (floor.usable.y1 - floor.usable.y0);
    return { x0: floor.usable.x0, x1: floor.usable.x1, y0, y1: floor.usable.y1, fraction: frac };
  }

  /**
   * Structural bays over the room, on the column grid.
   *
   * The existing floor-load check divides a rack's weight by its own footprint,
   * which is the *point* load -- a property of the rack, identical wherever it
   * stands, and therefore something placement can do exactly nothing about. The
   * number a structural engineer also asks for is the distributed load: total
   * weight over a bay of slab, aisles included. That one *is* placement
   * dependent, and it is the one that says "stop putting all eight GPU racks in
   * the same corner".
   */
  function bayGrid(design, floor) {
    const size = Math.max(1, design.room.structural_bay_m || 6);
    const cols = Math.max(1, Math.ceil(design.room.width_m / size));
    const rows = Math.max(1, Math.ceil(design.room.depth_m / size));
    const of = new Int32Array(floor.positions.length);
    floor.positions.forEach((p, j) => {
      const cx = DCP.Util.clamp(Math.floor(p.x / size), 0, cols - 1);
      const cy = DCP.Util.clamp(Math.floor(p.y / size), 0, rows - 1);
      of[j] = cy * cols + cx;
    });
    return {
      of,
      count: cols * rows,
      cols,
      rows,
      size_m: size,
      area_m2: size * size,
      capacity_kg: (design.room.floor_distributed_kg_m2 || 732) * size * size,
    };
  }

  function roleOf(rack) {
    const layout = DCP.Catalog.RACK_LAYOUTS[rack.layout];
    return (layout && layout.role) || "compute";
  }

  /**
   * Assemble every placement-time rule into the tables the solver reads.
   *
   * @param {object} spec {design, floor, racks, pods}
   */
  function build(spec) {
    const { design, floor, racks } = spec;
    const n = racks.length;
    const m = floor.positions.length;
    const notes = [];

    const bays = bayGrid(design, floor);
    const reserve = reserveZone(design, floor);
    const door = accessPoint(design, floor);

    const weight = new Float64Array(n);
    racks.forEach((r, i) => (weight[i] = r.weight_kg || 0));

    /* ------------------------------------------------------------- mask -- */
    // Starts fully permissive; each rule can only ever take positions away, so
    // the order rules are applied in cannot change the result.
    let mask = null;
    const denyReasons = new Map();
    const deny = (i, j, why) => {
      if (!mask) {
        mask = new Uint8Array(n * m).fill(1);
      }
      if (mask[i * m + j]) {
        mask[i * m + j] = 0;
        denyReasons.set(why, (denyReasons.get(why) || 0) + 1);
      }
    };

    // Pod containment: a rack belongs to a pod, and a pod owns a contiguous
    // block of floor. This is what makes the hierarchy real rather than a label
    // in the export -- without it "pod" is just a name attached to racks that
    // ended up wherever the fiber objective liked.
    if (spec.pods && spec.pods.regionOf) {
      racks.forEach((rack, i) => {
        const region = spec.pods.regionOf(rack.id);
        if (!region) return;
        for (let j = 0; j < m; j++) if (!region.has(j)) deny(i, j, "outside its pod");
      });
    }

    // Haul distance for anything too heavy to walk in on a pallet jack. A 1.4 t
    // liquid rack comes off the dock on a lift and every extra metre of that
    // trip is a real handling risk, so it is a hard limit rather than a price.
    const craneKg = design.room.crane_required_kg || 0;
    const haulM = design.room.max_haul_m || 0;
    if (craneKg > 0 && haulM > 0) {
      racks.forEach((rack, i) => {
        if ((rack.weight_kg || 0) < craneKg) return;
        for (let j = 0; j < m; j++) {
          const p = floor.positions[j];
          if (Math.abs(p.x - door.x) + Math.abs(p.y - door.y) > haulM) {
            deny(i, j, `over ${craneKg} kg and beyond the ${haulM} m haul limit`);
          }
        }
      });
    }

    // A rack with nowhere legal left to stand makes the whole solve infeasible,
    // and silently handing back a mask of zeroes would strand the annealer with
    // no accepted move and no explanation. Drop the rule for that rack instead
    // and say so -- a reported compromise beats a mysterious layout.
    if (mask) {
      racks.forEach((rack, i) => {
        let any = false;
        for (let j = 0; j < m; j++) if (mask[i * m + j]) { any = true; break; }
        if (!any) {
          for (let j = 0; j < m; j++) mask[i * m + j] = 1;
          notes.push(`${rack.name}: no position satisfies every hard constraint — ` +
            `placement constraints were relaxed for this rack, check the layout by hand`);
        }
      });
    }

    /* ---------------------------------------------------------- penalty -- */
    // Walk distance from the service door, weighted by how often the rack is
    // actually opened. Priced per metre so it is comparable with the cable it
    // is competing against.
    const maintenance = new Float64Array(n * m);
    const accessRate = design.optimizer?.access_usd_per_m ?? ACCESS_USD_PER_M;
    racks.forEach((rack, i) => {
      const w = SERVICE_WEIGHT[roleOf(rack)] ?? 1;
      const base = i * m;
      for (let j = 0; j < m; j++) {
        const p = floor.positions[j];
        maintenance[base + j] = accessRate * w
          * (Math.abs(p.x - door.x) + Math.abs(p.y - door.y));
      }
    });

    // Occupying the growth reserve is allowed but charged, so the solver packs
    // away from it and only spills in when the room genuinely has nowhere else.
    const expansion = new Float64Array(n * m);
    if (reserve) {
      const rate = design.expansion?.penalty_usd_per_rack ?? 25000;
      for (let j = 0; j < m; j++) {
        const p = floor.positions[j];
        if (p.y < reserve.y0) continue;
        for (let i = 0; i < n; i++) expansion[i * m + j] = rate;
      }
    }

    for (const [why, count] of denyReasons) {
      notes.push(`${count} rack-position combination${count === 1 ? "" : "s"} ruled out: ${why}`);
    }

    return {
      n, m, mask, bays, weight, maintenance, expansion, reserve, door, notes,
      overload_usd_per_kg: design.optimizer?.overload_usd_per_kg ?? OVERLOAD_USD_PER_KG,
      feasible: mask ? (i, j) => mask[i * m + j] === 1 : () => true,
    };
  }

  /**
   * Distributed floor load per bay under a finished placement, for the report.
   *
   * Recomputed from scratch rather than read off the solver's running totals:
   * the point of a report is to be checkable, and a number carried through a
   * hundred thousand incremental updates is exactly the number you would want to
   * verify independently.
   */
  function bayLoads(constraints, posOf) {
    const { bays, weight, n } = constraints;
    const load = new Float64Array(bays.count);
    for (let i = 0; i < n; i++) load[bays.of[posOf[i]]] += weight[i];

    let peak = 0;
    let over = 0;
    let overKg = 0;
    for (let b = 0; b < bays.count; b++) {
      const density = load[b] / bays.area_m2;
      if (density > peak) peak = density;
      if (load[b] > bays.capacity_kg) {
        over++;
        overKg += load[b] - bays.capacity_kg;
      }
    }
    return {
      peak_kg_m2: DCP.Util.round(peak, 1),
      capacity_kg_m2: DCP.Util.round(bays.capacity_kg / bays.area_m2, 1),
      bays_over: over,
      overload_kg: DCP.Util.round(overKg, 1),
      bay_size_m: bays.size_m,
    };
  }

  DCP.Constraints = {
    build, bayLoads, bayGrid, reserveZone, accessPoint, roleOf,
    OVERLOAD_USD_PER_KG, ACCESS_USD_PER_M, SERVICE_WEIGHT,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
