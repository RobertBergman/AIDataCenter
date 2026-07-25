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
      for (let i = 0; i < cduCount; i++) {
        units.push({
          id: `cdu${DCP.Util.pad(i + 1)}`, kind: "cdu", model: "cdu-perimeter-2500",
          name: `CDU-${DCP.Util.pad(i + 1)}`,
          x: DCP.Util.round(design.room.width_m - design.room.perimeter_m / 2, 2),
          y: DCP.Util.round(((i + 1) / (cduCount + 1)) * design.room.depth_m, 2),
          w_m: cdu.w_m, d_m: cdu.d_m, kw_capacity: cdu.kw, kw_draw: cdu.kw * 0.02,
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
      const pos = ctx.takeFreePosition(cx, cy);
      if (!pos) {
        notes.push(`no free floor position for CDU ${i + 1} — the room is full; grow the room or raise racks_per_cdu`);
        continue;
      }
      units.push({
        id: `cdu${DCP.Util.pad(i + 1)}`, kind: "cdu", model: cool.cdu_model,
        name: `CDU-${DCP.Util.pad(i + 1)}`, x: pos.x, y: pos.y, position: pos.id,
        w_m: cdu.w_m, d_m: cdu.d_m, kw_capacity: cdu.kw, kw_draw: cdu.kw * 0.02,
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
        const media = rack.kw > 60 ? "hose-dn50" : "hose-dn32";
        const port = (manifoldPort.get(cdu.id) || 0) + 1;
        manifoldPort.set(cdu.id, port);
        for (const side of ["S", "R"]) {
          runs.push({
            label: `CW-${side}-${rack.name}`,
            class: "coolant",
            media,
            a: { device: rackEnd(units, rack), port: side === "S" ? "supply" : "return", rack: rack.name },
            b: { device: cdu.name, port: `secondary-${side === "S" ? "supply" : "return"}-${port}`, rack: cdu.name },
            from_key: `rack:${rack.id}`,
            to_key: `equip:${cdu.id}`,
          });
        }
      }
    }

    // Facility (primary) loop into every CDU / CRAH, one header tap each.
    let headerTap = 0;
    for (const u of units) {
      if (u.kind !== "cdu" && u.kind !== "crah") continue;
      headerTap++;
      for (const side of ["S", "R"]) {
        runs.push({
          label: `CF-${side}-${u.name}`,
          class: "coolant",
          media: "pipe-dn100",
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
      // Rough secondary-loop flow at the modeled ΔT: Q = m·cp·ΔT, water cp ≈ 4.19 kJ/kg·K
      flow_lpm: DCP.Util.round(
        state.mode === "water"
          ? (state.itLoadKw * 60) / (4.19 * Math.max(1, design.cooling.return_c - design.cooling.supply_c))
          : 0, 1),
      redundancy: design.cooling.redundancy,
      containment: design.cooling.containment,
    };
  }

  DCP.Cooling = { plan, DLC_RACK_CAP_KW, RESIDUAL_AIR_FRACTION };
})(typeof globalThis !== "undefined" ? globalThis : this);
