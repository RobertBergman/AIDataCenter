/**
 * Cooling: air or water, and what each choice costs you in floor space,
 * per-rack ceiling, and plumbing.
 *
 *   air        hot-aisle containment + perimeter CRAH.
 *              Practical ceiling ~40 kW/rack; above that the aisle cannot move
 *              enough air regardless of how much CRAH you buy.
 *   water/rdhx rear-door heat exchangers. No floor space, but the door adds
 *              depth to every row and each rack needs a supply/return pair.
 *   water/dlc  direct-to-chip cold plates + in-row CDUs. Highest density, but
 *              the CDU eats a rack slot in the row it serves and a residual
 *              air load still has to be handled.
 *
 * The mode is load-bearing: it gates which rack layouts are legal (an NVL72 has
 * no air-cooled variant) and it sets the per-rack kW ceiling that validation
 * checks every rack against.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  const DLC_RACK_CAP_KW = 150;   // what a direct-liquid rack + manifold can take
  const RESIDUAL_AIR_FRACTION = 0.1; // heat DLC leaves for the air path (PSUs, DIMMs, NICs)

  function redundancyFactor(mode) {
    return mode === "2N" ? 2 : 1;
  }
  function redundancySpares(mode) {
    return mode === "N+1" ? 1 : 0;
  }

  /**
   * @param ctx { design, floor, racks (placed, with kw/x/y), takeFreePosition() }
   */
  function plan(ctx) {
    const { design, floor, racks } = ctx;
    const C = DCP.Catalog;
    const cool = design.cooling;
    const units = [];
    const notes = [];

    const itLoadKw = DCP.Util.sum(racks, (r) => r.kw);
    const mode = cool.mode;
    const waterType = mode === "water" ? cool.water_type : null;

    let perRackCapKw;
    if (mode === "air") {
      perRackCapKw = cool.air_kw_per_rack_cap;
    } else if (waterType === "rdhx") {
      perRackCapKw = C.RDHX[cool.rdhx_model].kw;
    } else {
      perRackCapKw = DLC_RACK_CAP_KW;
    }

    // ---------------------------------------------------------------- air --
    if (mode === "air") {
      const crah = C.CRAH[cool.crah_model];
      const needed = Math.ceil(itLoadKw / crah.kw) || 1;
      const count = needed * redundancyFactor(cool.redundancy) + redundancySpares(cool.redundancy);

      // Perimeter placement, alternating north and south walls.
      const room = design.room;
      const span = floor.usable.x1 - floor.usable.x0;
      for (let i = 0; i < count; i++) {
        const north = i % 2 === 0;
        const k = Math.floor(i / 2);
        const perSide = Math.ceil(count / 2);
        const x = floor.usable.x0 + ((k + 0.5) / Math.max(1, perSide)) * span;
        const y = north ? room.perimeter_m / 2 : room.depth_m - room.perimeter_m / 2;
        units.push({
          id: `crah${DCP.Util.pad(i + 1)}`, kind: "crah", model: cool.crah_model,
          name: `CRAH-${DCP.Util.pad(i + 1)}`, x: DCP.Util.round(x, 2), y: DCP.Util.round(y, 2),
          w_m: crah.w_m, d_m: crah.d_m, kw_capacity: crah.kw, kw_draw: crah.kw * 0.06,
          weight_kg: crah.weight_kg, serves: "room",
        });
      }
      if (room.perimeter_m < crah.d_m) {
        notes.push(`perimeter keep-clear ${room.perimeter_m} m is shallower than the ${crah.d_m} m CRAH footprint`);
      }
      return finish({
        mode, waterType, units, notes, perRackCapKw, itLoadKw,
        capacity_kw: units.length * crah.kw,
        design, racks, ctx,
      });
    }

    // -------------------------------------------------------- rear-door HX --
    if (waterType === "rdhx") {
      const rdhx = C.RDHX[cool.rdhx_model];
      racks.forEach((r, i) => {
        units.push({
          id: `rdhx-${r.name}`, kind: "rdhx", model: cool.rdhx_model,
          name: `RDHX-${r.name}`, x: r.x, y: r.y, w_m: 0, d_m: rdhx.adds_depth_m,
          kw_capacity: rdhx.kw, kw_draw: rdhx.fan_kw || 0, weight_kg: rdhx.weight_kg,
          serves: [r.id], mounted_on: r.id,
        });
      });
      // Doors still need a liquid-to-liquid interface to the facility loop.
      const cdu = C.CDU["cdu-perimeter-2500"];
      const cduCount = Math.max(1, Math.ceil(itLoadKw / cdu.kw)) + redundancySpares(cool.redundancy);

      // These stand against the right-hand wall, which runs along y -- so the
      // catalogue's width lies along the *wall* and its depth reaches into the
      // room. Emitting the footprint unrotated put a 2.2 m frame across a 1.2 m
      // perimeter strip: half a metre outside the building, and straight through
      // the RPP zone. Everything downstream reads w_m as x and d_m as y, so the
      // transpose belongs here, at the point where the unit is oriented.
      const alongX = cdu.d_m;
      const alongY = cdu.w_m;
      if (design.room.perimeter_m < alongX) {
        notes.push(`perimeter keep-clear ${design.room.perimeter_m} m is shallower than the ` +
          `${alongX} m footprint of a perimeter CDU standing against the wall`);
      }
      const lane = design.room.depth_m / (cduCount + 1);
      if (cduCount > 1 && lane < alongY) {
        notes.push(`${cduCount} perimeter CDUs at ${DCP.Util.round(lane, 2)} m spacing cannot clear ` +
          `their own ${alongY} m frames — lengthen the room or fit larger CDUs`);
      }
      for (let i = 0; i < cduCount; i++) {
        units.push({
          id: `cdu${DCP.Util.pad(i + 1)}`, kind: "cdu", model: "cdu-perimeter-2500",
          name: `CDU-${DCP.Util.pad(i + 1)}`,
          x: DCP.Util.round(design.room.width_m - alongX / 2, 2),
          y: DCP.Util.round((i + 1) * lane, 2),
          w_m: alongX, d_m: alongY, kw_capacity: cdu.kw, kw_draw: cdu.kw * 0.02,
          lpm: cdu.lpm,
          weight_kg: cdu.weight_kg, serves: racks.map((r) => r.id), in_row: false,
        });
      }
      return finish({
        mode, waterType, units, notes, perRackCapKw, itLoadKw,
        capacity_kw: cduCount * cdu.kw, design, racks, ctx,
      });
    }

    // ----------------------------------------------- direct liquid + CDUs --
    const cdu = C.CDU[cool.cdu_model];
    const byLoad = Math.ceil(itLoadKw / cdu.kw);
    const byCount = Math.ceil(racks.length / Math.max(1, cool.racks_per_cdu));
    const needed = Math.max(1, byLoad, byCount);
    const count = needed * redundancyFactor(cool.redundancy) + redundancySpares(cool.redundancy);

    // Split racks into contiguous groups and drop a CDU beside each group. An
    // in-row CDU consumes a real floor position -- if the room is full, that is
    // a hard failure, not something to paper over.
    const groups = chunk(racks, Math.ceil(racks.length / needed));
    for (let i = 0; i < count; i++) {
      const group = groups[Math.min(i, groups.length - 1)] || [];
      const cx = group.length ? DCP.Util.sum(group, (r) => r.x) / group.length : floor.usable.x0;
      const cy = group.length ? DCP.Util.sum(group, (r) => r.y) / group.length : floor.usable.y0;
      // A 900 mm CDU does not fit a 750 mm slot: claim as many adjacent slots as
      // its frame actually needs, or say so.
      const pos = ctx.takeFreeRun(cx, cy, cdu.w_m);
      if (!pos) {
        const slots = Math.max(1, Math.ceil(cdu.w_m / floor.pitch - 1e-9));
        notes.push(`no free run of ${slots} adjacent floor position${slots > 1 ? "s" : ""} for CDU ${i + 1} ` +
          `(${cdu.w_m} m wide in a ${DCP.Util.round(floor.pitch, 2)} m row pitch) — ` +
          `grow the room or raise racks_per_cdu`);
        continue;
      }
      units.push({
        id: `cdu${DCP.Util.pad(i + 1)}`, kind: "cdu", model: cool.cdu_model,
        name: `CDU-${DCP.Util.pad(i + 1)}`, x: pos.x, y: pos.y, position: pos.id,
        w_m: cdu.w_m, d_m: cdu.d_m, kw_capacity: cdu.kw, kw_draw: cdu.kw * 0.02,
        lpm: cdu.lpm,
        weight_kg: cdu.weight_kg, in_row: true,
        serves: (i < groups.length ? groups[i] : group).map((r) => r.id),
      });
    }

    // The rack-side end of a direct-liquid loop is the manifold, not the frame.
    // Naming it keeps every coolant run terminating on something an installer
    // can physically put a label on.
    for (const rack of racks) {
      units.push({
        id: `manifold-${rack.id}`, kind: "manifold", model: "rack manifold",
        name: `MANIFOLD-${rack.name}`, x: rack.x, y: rack.y, w_m: 0, d_m: 0,
        kw_capacity: perRackCapKw, kw_draw: 0, weight_kg: 25,
        mounted_on: rack.id, serves: [rack.id],
      });
    }

    return finish({
      mode, waterType, units, notes, perRackCapKw, itLoadKw,
      capacity_kw: units.filter((u) => u.kind === "cdu").length * cdu.kw,
      design, racks, ctx,
    });
  }

  /** The rack-side termination: a rear door if fitted, otherwise the manifold. */
  function rackEnd(units, rack) {
    const door = units.find((u) => u.kind === "rdhx" && u.mounted_on === rack.id);
    if (door) return door.name;
    const manifold = units.find((u) => u.kind === "manifold" && u.mounted_on === rack.id);
    return manifold ? manifold.name : rack.name;
  }

  function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
    return out;
  }

  /**
   * Attach every rack to the CDU that serves it and emit the labeled coolant
   * runs. Hose lengths ride the same pathway graph as everything else, so a
   * badly placed CDU shows up as long hose runs rather than as a silent success.
   */
  function finish(state) {
    const { units, design, racks, ctx } = state;
    const C = DCP.Catalog;
    const runs = [];
    const deltaT = design.cooling.return_c - design.cooling.supply_c;

    /**
     * Size a run from the flow it actually carries and carry the verdict with it.
     *
     * The room models one supply/return pair, so the primary loop is sized at
     * the same ΔT as the secondary. That understates a real facility loop, which
     * usually runs wider and therefore cooler in flow -- so the pipe picked here
     * is conservative rather than optimistic, which is the right way round.
     */
    const sized = (lpm, kind) => {
      const s = C.sizeCoolantMedia(lpm, kind);
      if (!s.fits) {
        state.notes.push(`no ${kind} carries ${DCP.Util.round(lpm, 0)} L/min at ΔT ${deltaT} K — ` +
          `sized up to ${s.key} and still short; widen ΔT or split the run`);
      }
      return s;
    };

    const cdus = units.filter((u) => u.kind === "cdu");
    const liquid = state.mode === "water";

    if (liquid && cdus.length) {
      const primaries = cdus.filter((u) => !u.spare);
      // Each rack takes its own pair of ports on the CDU's secondary manifold.
      const manifoldPort = new Map();
      for (const rack of racks) {
        // Nearest CDU that lists this rack, else nearest CDU outright.
        let cdu = primaries.find((u) => Array.isArray(u.serves) && u.serves.includes(rack.id));
        if (!cdu) {
          cdu = primaries.reduce((best, u) => {
            const d = Math.abs(u.x - rack.x) + Math.abs(u.y - rack.y);
            return !best || d < best.d ? { u, d } : best;
          }, null)?.u;
        }
        if (!cdu) continue;
        // A rack drop carries that rack's heat at the room's ΔT. Nothing else
        // decides the bore -- least of all its kW on its own, which is only half
        // the equation.
        const lpm = C.flowLpm(rack.kw, deltaT);
        const s = sized(lpm, "hose");
        const port = (manifoldPort.get(cdu.id) || 0) + 1;
        manifoldPort.set(cdu.id, port);
        for (const side of ["S", "R"]) {
          runs.push({
            label: `CW-${side}-${rack.name}`,
            class: "coolant",
            media: s.key,
            undersized: !s.fits,
            sizing_need: `${DCP.Util.round(lpm, 0)} L/min at ΔT ${deltaT} K`,
            flow_lpm: DCP.Util.round(lpm, 1),
            a: { device: rackEnd(units, rack), port: side === "S" ? "supply" : "return", rack: rack.name },
            b: { device: cdu.name, port: `secondary-${side === "S" ? "supply" : "return"}-${port}`, rack: cdu.name },
            from_key: `rack:${rack.id}`,
            to_key: `equip:${cdu.id}`,
          });
        }
      }
    }

    // Facility (primary) loop into every CDU / CRAH, one header tap each.
    //
    // A header tap is permanent and the unit behind it can be driven to
    // nameplate, so it is sized to the unit's rated flow rather than to whatever
    // load happens to sit on it today. The CDU catalog already carries that
    // rating; a CRAH does not, so its flow comes from its capacity and the room
    // ΔT. Every tap used to be DN100 regardless, which fits an in-row CDU
    // exactly and leaves a perimeter CDU at twice its pipe.
    let headerTap = 0;
    for (const u of units) {
      if (u.kind !== "cdu" && u.kind !== "crah") continue;
      headerTap++;
      const lpm = u.lpm || C.flowLpm(u.kw_capacity, deltaT);
      const s = sized(lpm, "pipe");
      for (const side of ["S", "R"]) {
        runs.push({
          label: `CF-${side}-${u.name}`,
          class: "coolant",
          media: s.key,
          undersized: !s.fits,
          sizing_need: `${DCP.Util.round(lpm, 0)} L/min`,
          flow_lpm: DCP.Util.round(lpm, 1),
          a: { device: u.name, port: side === "S" ? "primary-supply" : "primary-return", rack: u.name },
          b: { device: "facility-loop", port: `${side === "S" ? "supply" : "return"}-header-${headerTap}`, rack: "facility" },
          from_key: `equip:${u.id}`,
          to_key: "facility:loop",
        });
      }
    }

    const mechKw = DCP.Util.sum(units, (u) => u.kw_draw || 0);
    const residualAirKw = state.mode === "water" && state.waterType === "dlc"
      ? state.itLoadKw * RESIDUAL_AIR_FRACTION
      : 0;

    return {
      mode: state.mode,
      water_type: state.waterType,
      units,
      runs,
      notes: state.notes,
      per_rack_cap_kw: state.perRackCapKw,
      capacity_kw: DCP.Util.round(state.capacity_kw, 1),
      it_load_kw: DCP.Util.round(state.itLoadKw, 1),
      mechanical_kw: DCP.Util.round(mechKw, 1),
      residual_air_kw: DCP.Util.round(residualAirKw, 1),
      supply_c: design.cooling.supply_c,
      return_c: design.cooling.return_c,
      delta_t: design.cooling.return_c - design.cooling.supply_c,
      // Secondary-loop flow at the modeled ΔT, from the same helper that sizes
      // the hose -- one definition, so the schedule and the summary agree.
      flow_lpm: DCP.Util.round(
        state.mode === "water" ? C.flowLpm(state.itLoadKw, deltaT) : 0, 1),
      redundancy: design.cooling.redundancy,
      containment: design.cooling.containment,
    };
  }

  DCP.Cooling = { plan, DLC_RACK_CAP_KW, RESIDUAL_AIR_FRACTION };
})(typeof globalThis !== "undefined" ? globalThis : this);
