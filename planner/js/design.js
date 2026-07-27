/**
 * Design state: everything the user can turn, and nothing that is derived.
 *
 * The build pipeline (build.js) is a pure function of this object plus the
 * catalog, so the design doubles as the save file: hand it to `tools/plan.js`
 * and you get the same YAML the browser produced.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  function defaultDesign() {
    return {
      meta: {
        name: "ai-dc-1",
        room: "Hall A",
        tenant: "research",
        description: "AI datacenter room — planner output",
      },

      /* Room geometry. Rows run along X; depth is Y. All metres. */
      room: {
        width_m: 24.0,
        depth_m: 16.0,
        clear_height_m: 4.5,
        tile_m: 0.6,
        perimeter_m: 1.2,       // keep-clear against every wall
        cold_aisle_m: 1.8,      // front-to-front service aisle
        hot_aisle_m: 1.2,       // back-to-back exhaust aisle
        raised_floor: false,
        floor_capacity_kg_m2: 1220,
        tray_height_m: 3.2,     // data tray tier above finished floor
        power_tray_height_m: 3.8, // power tier -- physically separated from data
        data_tray_runs: 2,      // parallel tray baskets per aisle, per tier
        power_tray_runs: 2,
        fluid_tray_runs: 1,
      },

      /* Air or water. `water_type` picks how the heat actually leaves the rack. */
      cooling: {
        mode: "water",          // "air" | "water"
        water_type: "dlc",      // "dlc" (direct-to-chip + in-row CDU) | "rdhx" (rear-door HX)
        crah_model: "crah-150",
        cdu_model: "cdu-inrow-1300",
        rdhx_model: "rdhx-100",
        redundancy: "N+1",      // "N" | "N+1" | "2N"
        supply_c: 32,
        return_c: 45,
        containment: "hot-aisle",
        racks_per_cdu: 8,
        air_kw_per_rack_cap: 40, // practical ceiling for contained air
      },

      /* Utility entrance → switchboard (+bypass) → UPS → RPP/busway → rack PDU. */
      power: {
        volts: 415,
        phases: 3,
        entrances: 2,            // A and B services
        entrance_kw: 1500,       // per entrance
        entrance_side: "west",   // wall the service lands on
        ups_model: "ups-500",
        ups_redundancy: "N+1",   // "N" | "N+1" | "2N"
        // The service lands once per feed on a switchboard lineup; the UPS
        // modules tap its bus and the RPP breakers live in its output section.
        // "auto" sizes the frame against the entrance. The maintenance bypass is
        // a section of this lineup, so it costs no feeder of its own.
        switchboard_model: "auto",
        maintenance_bypass: true,
        distribution: "rpp",     // "rpp" | "busway"
        // "spine" puts the RPP column inside the rack block, between the UPS and
        // the load. "wall" parks it on the far wall — tidier drawing, and every
        // feeder then crosses the room while every whip crosses back. "auto"
        // takes the spine only where the room has the slots to pay for it.
        rpp_siting: "auto",      // "auto" | "spine" | "wall"
        rpp_model: "rpp-400a",
        busway_model: "busway-800a",
        rack_pdu_model: "pdu-3ph-60a",
        pdus_per_rack: 2,        // A/B
        breaker_derate: 0.8,     // NEC continuous-load derate
        emit_device_cords: false, // per-PSU cords in the schedule (verbose)
        pue_target: 1.25,
      },

      /* Fabric shape. `oversubscription` is downlink:uplink at the leaf. */
      fabric: {
        arch: "rail-optimized",  // "rail-optimized" | "tor" | "eor"
        oversubscription: 1,     // 1 | 2 | 4
        tiers: 2,                // 2 = leaf/spine, 3 = + super-spine across pods
        leaf_model: "7060dx5-32",
        spine_model: "7060dx5-64s",
        super_model: "7800r4-128",
        oob_model: "7010tx-48",
        pod_racks: 8,            // racks per pod when tiers = 3
        emit_oob: true,
      },

      /* Drives the traffic matrix used by partitioning and QAP placement. */
      workload: {
        tp_size: 8,              // tensor-parallel GPUs (usually intra-node)
        pp_size: 2,              // pipeline stages -- adjacent-group traffic
        dp_replicas: 4,          // data-parallel replicas -- all-reduce ring
        collective: "all-reduce",
        base_affinity: 0.02,     // background any-to-any share
      },

      /* Which solvers run, and how hard. */
      optimizer: {
        seed: 20260725,
        partition: true,         // multilevel KL/FM server→rack assignment
        placement: "anneal",     // "anneal" | "greedy" | "sequential"
        anneal_iters: 24000,
        anneal_start_t: 1.0,
        anneal_end_t: 0.01,
        // Share of the placement objective spent on traffic locality rather than
        // on the cable bill. The solver converts it into a shadow price in
        // $ per GB/s·m against the baseline layout, so both halves of the
        // objective stay in units someone can argue with.
        objective_traffic_weight: 0.5,
        // Installed labour per metre pulled. Keeps distance worth minimising in
        // rooms where every layout buys the same media anyway.
        pull_cost_usd_per_m: 2.0,
        routing: "astar",        // congestion-aware A* over the pathway graph
        congestion_weight: 0.6,
        bend_penalty_m: 1.5,
        bundle: true,            // Steiner-tree trunking for leaf↔spine
        slack_m: 1.0,            // service loop per cable end
      },

      /* The rack list. Position is solver-assigned unless `pinned` is set. */
      racks: buildDefaultRacks(),
    };
  }

  function buildDefaultRacks() {
    const racks = [];
    for (let i = 1; i <= 8; i++) {
      racks.push(makeRack(`GPU-${DCP.Util.pad(i)}`, "gpu-dlc-b300"));
    }
    racks.push(makeRack("NET-01", "network-spine"));
    racks.push(makeRack("NET-02", "network-spine"));
    racks.push(makeRack("STOR-01", "storage-nvme"));
    racks.push(makeRack("BOOT-01", "mgmt-boot"));
    return racks;
  }

  let rackSeq = 0;
  function makeRack(name, layoutKey, overrides = {}) {
    const layout = DCP.Catalog.RACK_LAYOUTS[layoutKey];
    if (!layout) throw new Error(`unknown rack layout: ${layoutKey}`);
    return {
      id: `r${++rackSeq}`,
      name,
      layout: layoutKey,
      rack_type: layout.rack_type,
      servers: layout.default_servers,
      pinned: null, // { x, y } in metres, snapped to the tile grid
      ...overrides,
    };
  }

  /** Next free name for a layout family, e.g. GPU-09. */
  function nextName(design, layoutKey) {
    const prefix = {
      compute: DCP.Catalog.RACK_LAYOUTS[layoutKey].server === "jbof-2u" ? "STOR" : "GPU",
      storage: "STOR",
      network: "NET",
      mgmt: "BOOT",
    }[DCP.Catalog.RACK_LAYOUTS[layoutKey].role] || "RACK";
    const cpu = DCP.Catalog.RACK_LAYOUTS[layoutKey].server === "cpu-2u";
    const base = cpu ? "CPU" : prefix;
    let n = 1;
    const taken = new Set(design.racks.map((r) => r.name));
    while (taken.has(`${base}-${DCP.Util.pad(n)}`)) n++;
    return `${base}-${DCP.Util.pad(n)}`;
  }

  function addRack(design, layoutKey) {
    const rack = makeRack(nextName(design, layoutKey), layoutKey);
    design.racks.push(rack);
    return rack;
  }

  function removeRack(design, id) {
    const i = design.racks.findIndex((r) => r.id === id);
    if (i >= 0) design.racks.splice(i, 1);
  }

  /**
   * Cooling mode gates layouts. Rather than silently substituting hardware we
   * mark the offending racks and let validate.js report them -- the user asked
   * for air on a liquid-only SKU and deserves to be told, not corrected.
   */
  function layoutLegalUnder(layoutKey, coolingMode) {
    const layout = DCP.Catalog.RACK_LAYOUTS[layoutKey];
    if (!layout) return false;
    return layout.cooling.includes(coolingMode);
  }

  function legalLayouts(coolingMode) {
    return Object.entries(DCP.Catalog.RACK_LAYOUTS)
      .filter(([k]) => layoutLegalUnder(k, coolingMode))
      .map(([k, v]) => ({ key: k, ...v }));
  }

  DCP.Design = {
    defaultDesign, makeRack, addRack, removeRack, nextName,
    layoutLegalUnder, legalLayouts,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
