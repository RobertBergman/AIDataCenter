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
        name: "ai-factory-pod-1",
        room: "Hall A",
        tenant: "research",
        description:
          "AI factory reference pod — 8× Vera Rubin NVL144, 800G rail-optimized " +
          "fabric, direct-to-chip liquid, warm-water loop",
      },

      /* Room geometry. Rows run along X; depth is Y. All metres. */
      room: {
        width_m: 30.0,
        depth_m: 20.0,
        // AI halls run taller than legacy rooms: an Oberon rack is over 2.2 m
        // before the overhead busway, the fibre tray and the coolant header
        // stack above it.
        clear_height_m: 5.2,
        tile_m: 0.6,
        perimeter_m: 1.2,       // keep-clear against every wall
        cold_aisle_m: 1.8,      // front-to-front service aisle
        hot_aisle_m: 1.2,       // back-to-back exhaust aisle
        raised_floor: false,
        // Point load: one rack over its own footprint. A property of the rack,
        // identical wherever it stands, so placement cannot help it.
        //
        // 2500 kg/m² is an AI-hall number, not a legacy raised-floor one. A
        // populated Oberon rack is ~1.4 t on 0.72 m², a point load north of
        // 2000 kg/m², against the 1000-1220 kg/m² a traditional raised floor is
        // rated for. Purpose-built AI space is specified at 20-25 kN/m² on
        // reinforced slab, and a planner defaulting to the old figure would
        // reject every rack-scale design it is now meant to lay out.
        floor_capacity_kg_m2: 2500,
        // Distributed load: everything standing in one structural bay, aisles
        // included. This one *is* placement dependent -- it is what stops the
        // solver stacking every liquid rack into a single corner of the slab.
        floor_distributed_kg_m2: 1200,
        structural_bay_m: 6.0,    // column grid the distributed load is judged over
        access_side: "south",     // wall the loading door and service route land on
        crane_required_kg: 1200,  // above this a rack needs a lift, not a pallet jack
        max_haul_m: 45,           // how far such a rack may be moved from that door
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
        // Warm water. The point of running the loop this hot is that 35 °C
        // supply is above ambient wet-bulb almost everywhere, so the heat can be
        // rejected by dry coolers and the chillers — and their power, and their
        // water — come out of the design entirely. The wide ΔT is the other half
        // of the trade: 15 K instead of 13 K is ~13% less flow for the same
        // kilowatts, which is one bore size off every hose in the room.
        supply_c: 35,
        return_c: 50,
        containment: "hot-aisle",
        racks_per_cdu: 8,
        air_kw_per_rack_cap: 40, // practical ceiling for contained air
      },

      /* Utility entrance → switchboard (+bypass) → UPS → RPP/busway → rack PDU. */
      power: {
        volts: 415,
        phases: 3,
        entrances: 2,            // A and B services
        // Each feed carries the whole hall alone, so this is sized against the
        // full IT load rather than half of it.
        entrance_kw: 2000,       // per entrance
        entrance_side: "west",   // wall the service lands on
        ups_model: "ups-1250",
        ups_redundancy: "N+1",   // "N" | "N+1" | "2N"
        // The service lands once per feed on a switchboard lineup; the UPS
        // modules tap its bus and the RPP breakers live in its output section.
        // "auto" sizes the frame against the entrance. The maintenance bypass is
        // a section of this lineup, so it costs no feeder of its own.
        switchboard_model: "auto",
        maintenance_bypass: true,
        // Overhead busway is what the current reference designs actually build:
        // the run hangs over its own row and each cabinet takes a drop tap
        // directly above it, so there is no horizontal whip to pull, re-pull, or
        // trip over when a rack moves. The planner can see that too -- the whip
        // distance term in the placement objective goes to zero under busway.
        distribution: "busway",  // "rpp" | "busway"
        // "spine" puts the RPP column inside the rack block, between the UPS and
        // the load. "wall" parks it on the far wall — tidier drawing, and every
        // feeder then crosses the room while every whip crosses back. "auto"
        // takes the spine only where the room has the slots to pay for it.
        rpp_siting: "auto",      // "auto" | "spine" | "wall"
        // A 400 A panel is 230 kW derated -- under two Oberon racks. At this
        // density the 600 A frame is the entry point, not the upgrade.
        rpp_model: "rpp-600a",
        busway_model: "busway-800a",
        rack_pdu_model: "pdu-3ph-60a",
        pdus_per_rack: 2,        // A/B
        breaker_derate: 0.8,     // NEC continuous-load derate
        emit_device_cords: false, // per-PSU cords in the schedule (verbose)
        pue_target: 1.25,
      },

      /* Fabric shape. `oversubscription` is downlink:uplink at the leaf.
       *
       * 800G end to end. ConnectX-8 presents 800G per port, so a 400G leaf would
       * halve every GPU's fabric bandwidth at the first hop -- the most
       * expensive bottleneck in the building, bought to save the cheapest line
       * item. Non-blocking, because a rail-optimized training fabric that
       * oversubscribes is one that stalls on the all-reduce. */
      fabric: {
        arch: "rail-optimized",  // "rail-optimized" | "tor" | "eor"
        oversubscription: 1,     // 1 | 2 | 4
        tiers: 2,                // 2 = leaf/spine, 3 = + super-spine across pods
        leaf_model: "7060x6-32pe",
        spine_model: "7060x6-64pe",
        super_model: "7800r4-128x800",
        oob_model: "7010tx-48",
        pod_racks: 8,            // racks per pod when tiers = 3
        emit_oob: true,
      },

      /* The pod as a physical block of floor, not just a fabric grouping.
       * "auto" turns it on once there is enough for two real pods -- below that
       * the hierarchy is bookkeeping with no locality to win. */
      pods: {
        enabled: "auto",         // "auto" | true | false
        racks_per_pod: 8,
      },

      /* Floor held back for the next phase, taken from the far end of the room. */
      expansion: {
        reserve_fraction: 0,     // 0 = build the whole room now
        penalty_usd_per_rack: 25000,
      },

      /* Drives the traffic matrix used by partitioning and QAP placement.
       *
       * Sized to fill the pod: 8 racks × 18 trays = 144 trays, and
       * pp × dp = 4 × 36 = 144. Tensor parallel is 8-wide because a Vera Rubin
       * tray presents 8 GPU dies, so TP rides NVLink inside the tray and never
       * reaches the fabric -- which is the entire reason to buy a rack-scale
       * unit. Push tp_size past 8 and the planner starts reporting TP links
       * crossing rack boundaries: that warning is the job outgrowing the
       * machine, not a layout defect. */
      workload: {
        tp_size: 8,              // tensor-parallel GPUs -- one Vera Rubin tray
        pp_size: 4,              // pipeline stages -- adjacent-group traffic
        dp_replicas: 36,         // data-parallel replicas -- all-reduce ring
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
        /**
         * What the objective is allowed to care about, and how much.
         *
         * Every term is already in dollars, so 1.0 means "charge this at face
         * value" and the weighted sum is a real number someone can hold you to.
         * Moving one off 1.0 is a deliberate statement that this project values
         * the thing differently from what it costs -- turn `coolant` up on a
         * site where plumbing labour is scarce, turn `maintenance` up on a hall
         * that will be run by two people.
         *
         * Setting one to 0 does not make the term free, only invisible: it will
         * still be built and still be paid for, just not optimised.
         */
        weights: {
          power: 1.0,        // whip copper from the RPP column
          coolant: 1.0,      // supply and return hose from the CDU
          maintenance: 1.0,  // technician walk from the service door
          expansion: 1.0,    // eating into the growth reserve
          structural: 1.0,   // distributed floor load over a bay
        },
        access_usd_per_m: 90,      // annualised cost of a metre of that walk
        overload_usd_per_kg: 40,   // price on a kilogram over the bay's rating
        // Placement is solved against where the CDUs and panels are, but those
        // are sited against where the racks ended up. Iterate until it settles.
        utility_passes: 3,
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

  /**
   * The reference pod: one repeatable building block of an AI factory.
   *
   * Eight rack-scale GPU units is a pod because that is what the fabric wants --
   * 8 racks of 18 trays is 144 endpoints per rail, which a 64-port 800G spine
   * layer serves non-blocking without a third tier. Everything else in the list
   * is what has to sit beside them for the pod to stand up on its own: two
   * network racks for the leaf/spine layer, a storage rack to stage datasets
   * into, and a management rack for the boot, OOB and telemetry plane.
   *
   * Scale out by repeating the whole block, not by adding GPU racks to this one.
   */
  function buildDefaultRacks() {
    const racks = [];
    for (let i = 1; i <= 8; i++) {
      racks.push(makeRack(`GPU-${DCP.Util.pad(i)}`, "gpu-vr-nvl144"));
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
