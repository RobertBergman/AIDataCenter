/**
 * YAML emitter and the source-of-truth document shape.
 *
 * Two jobs:
 *  1. a small deterministic YAML writer (no dependency, works in the browser),
 *  2. `toDocument(model)` — the schema everything downstream consumes.
 *
 * The document is the deliverable. It carries the room, the cooling and power
 * plant, every rack elevation, every device, and every cable with its label,
 * medium, routed length and pathway — enough to order material, print labels,
 * and hand an installer a schedule, and enough for `tools/validate_design.py`
 * to re-derive the checks independently.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  const NEEDS_QUOTE = /^$|^[\s&*?|\-<>=!%@`{}[\],#]|[:#]\s|\s$|^(true|false|null|yes|no|on|off|~)$|^-?\d/i;

  function scalar(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return "null";
      return String(Number.isInteger(v) ? v : DCP.Util.round(v, 3));
    }
    if (typeof v === "boolean") return v ? "true" : "false";
    const s = String(v);
    if (NEEDS_QUOTE.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    if (/^-?\d+(\.\d+)?$/.test(s) && typeof v === "string") return `"${s}"`;
    return s;
  }

  const isScalar = (v) => v === null || v === undefined || typeof v !== "object";

  /** Short all-scalar maps are emitted inline, matching the repo's SoT files. */
  function flowMap(obj) {
    const parts = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      parts.push(`${k}: ${scalar(v)}`);
    }
    return `{ ${parts.join(", ")} }`;
  }

  function canFlow(obj, opts) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    const entries = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null);
    if (entries.length === 0 || entries.length > (opts.flowMax || 5)) return false;
    return entries.every(([, v]) => isScalar(v) && String(v).length < 40);
  }

  function dump(value, opts = {}) {
    const lines = [];
    write(value, 0, lines, opts);
    return lines.join("\n") + "\n";
  }

  function write(value, depth, lines, opts) {
    const pad = "  ".repeat(depth);
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines[lines.length - 1] += " []";
        return;
      }
      for (const item of value) {
        if (isScalar(item)) {
          lines.push(`${pad}- ${scalar(item)}`);
        } else if (canFlow(item, opts)) {
          lines.push(`${pad}- ${flowMap(item)}`);
        } else {
          lines.push(`${pad}-`);
          const start = lines.length;
          writeMap(item, depth + 1, lines, opts);
          // Fold the first key up onto the dash for readability.
          if (lines.length > start) {
            lines[start - 1] = `${pad}- ${lines[start].trim()}`;
            lines.splice(start, 1);
          }
        }
      }
      return;
    }
    writeMap(value, depth, lines, opts);
  }

  function writeMap(obj, depth, lines, opts) {
    const pad = "  ".repeat(depth);
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (opts.comments && opts.comments[k] && depth === 0) {
        lines.push("");
        for (const c of opts.comments[k].split("\n")) lines.push(`# ${c}`);
      }
      if (isScalar(v)) {
        lines.push(`${pad}${k}: ${scalar(v)}`);
      } else if (Array.isArray(v)) {
        lines.push(`${pad}${k}:`);
        write(v, depth + 1, lines, opts);
      } else if (canFlow(v, opts)) {
        lines.push(`${pad}${k}: ${flowMap(v)}`);
      } else {
        lines.push(`${pad}${k}:`);
        writeMap(v, depth + 1, lines, opts);
      }
    }
  }

  /* ------------------------------------------------------------ document -- */

  const LABEL_CONVENTIONS = {
    "R{rail}-{server}": "host NIC → rail leaf (rail-optimized fabric)",
    "H{nic}-{server}": "host NIC → ToR / EoR leaf",
    "L{leaf}S{spine}-U{n}": "leaf → spine uplink",
    "S{spine}X{super}-U{n}": "spine → super-spine uplink",
    "PEER-{switch}-{n}": "MLAG peer-link",
    "OOB-{device}": "BMC → OOB switch",
    "MGMT-{device}": "server mgmt0 → OOB switch",
    "MA1-{device}": "switch Management1 → OOB switch (ZTP)",
    "OOBU-{switch}-{n}": "OOB switch uplink to OOB aggregation",
    "PE-{feed}-{ups}": "utility entrance → UPS",
    "PF-{feed}-{unit}": "UPS → RPP or busway",
    "PW-{feed}{n}-{rack}": "RPP breaker → rack PDU whip",
    "PT-{feed}{n}-{rack}": "busway tap-off → rack PDU",
    "PC-{feed}-{device}-P{n}": "rack PDU outlet → device PSU",
    "CW-{S|R}-{rack}": "rack coolant manifold → CDU (secondary loop)",
    "CF-{S|R}-{unit}": "CDU / CRAH → facility loop (primary)",
  };

  function toDocument(model) {
    const R = DCP.Util.round;
    const { design, floor, racks, cables, cooling, power, fabric, totals, optimization, validation } = model;

    const doc = {};

    doc.schema_version = 1;
    doc.generator = {
      tool: "AIDataCenter planner",
      pipeline: "partition(KL/FM) → QAP(anneal) → elevate → site → route(A*/Steiner)",
      seed: design.optimizer.seed,
      deterministic: true,
    };

    doc.site = {
      name: design.meta.name,
      room: design.meta.room,
      tenant: design.meta.tenant,
      description: design.meta.description,
    };

    doc.room = {
      width_m: design.room.width_m,
      depth_m: design.room.depth_m,
      area_m2: floor.area_m2,
      clear_height_m: design.room.clear_height_m,
      raised_floor: design.room.raised_floor,
      tile_m: design.room.tile_m,
      perimeter_keep_clear_m: design.room.perimeter_m,
      cold_aisle_m: design.room.cold_aisle_m,
      hot_aisle_m: design.room.hot_aisle_m,
      row_pitch_m: R(floor.pitch, 3),
      row_depth_m: R(floor.rowDepth, 3),
      rows: floor.rows.length,
      slots_per_row: floor.slotsPerRow,
      rack_positions: floor.capacity,
      positions_used: racks.filter((r) => r.position).length,
      floor_capacity_kg_m2: design.room.floor_capacity_kg_m2,
      pathways: {
        data_tray_height_m: design.room.tray_height_m,
        power_tray_height_m: design.room.power_tray_height_m,
        separation: "power and data on separate tiers; coolant on its own run",
      },
    };

    doc.cooling = {
      mode: cooling.mode,
      type: cooling.water_type || "contained-air",
      containment: cooling.containment,
      redundancy: cooling.redundancy,
      per_rack_cap_kw: cooling.per_rack_cap_kw,
      capacity_kw: cooling.capacity_kw,
      it_load_kw: cooling.it_load_kw,
      mechanical_kw: cooling.mechanical_kw,
      residual_air_kw: cooling.residual_air_kw,
      supply_c: cooling.supply_c,
      return_c: cooling.return_c,
      delta_t_k: cooling.delta_t,
      secondary_flow_lpm: cooling.flow_lpm,
      units: cooling.units.map((u) => ({
        name: u.name,
        kind: u.kind,
        model: u.model,
        capacity_kw: u.kw_capacity,
        draw_kw: R(u.kw_draw, 2),
        x_m: u.x,
        y_m: u.y,
        position: u.position,
        mounted_on: u.mounted_on,
        serves: Array.isArray(u.serves) ? u.serves.length : u.serves,
      })),
    };

    doc.power = {
      volts: design.power.volts,
      phases: design.power.phases,
      feeds: power.feeds,
      breaker_derate: power.totals.derate,
      pue_target: power.totals.pue_target,
      it_load_kw: power.totals.it_load_kw,
      facility_load_kw: power.totals.facility_kw,
      entrances: power.entrances.map((e) => ({
        name: e.name, feed: e.feed, side: e.side,
        capacity_kw: e.capacity_kw, volts: e.volts, phases: e.phases,
        x_m: e.x, y_m: e.y,
      })),
      ups: {
        model: design.power.ups_model,
        redundancy: design.power.ups_redundancy,
        modules_per_feed: power.totals.ups_modules_per_feed,
        capacity_per_feed_kw: power.totals.ups_capacity_per_feed_kw,
        firm_capacity_per_feed_kw: power.totals.ups_firm_capacity_per_feed_kw,
        units: power.ups.map((u) => ({
          name: u.name, feed: u.feed, kva: u.kva, usable_kw: u.usable_kw,
          spare: u.spare, x_m: u.x, y_m: u.y,
        })),
      },
      distribution: {
        method: design.power.distribution,
        units: power.distribution.map((d) => ({
          name: d.name, kind: d.kind, feed: d.feed, model: d.model,
          capacity_kw: d.capacity_kw, load_kw: d.load_kw,
          poles: d.poles, poles_used: d.poles_used,
          row: d.row, x_m: d.x, y_m: d.y,
          serves: Array.isArray(d.serves) ? d.serves.length : undefined,
        })),
      },
      rack_pdus: power.rack_pdus.map((p) => ({
        name: p.name, rack: p.rack, feed: p.feed, model: p.model, mount: p.mount,
        amps: p.amps, volts: p.volts, phases: p.phases,
        kva: p.kva, usable_kw: p.usable_kw, load_kw: p.load_kw, outlets: p.outlets,
      })),
    };

    doc.fabric = {
      architecture: fabric.arch,
      description: DCP.Catalog.FABRIC_ARCHS[fabric.arch].desc,
      oversubscription_requested: `${design.fabric.oversubscription}:1`,
      oversubscription_achieved: `${R(fabric.split.down / fabric.split.up, 2)}:1`,
      tiers: design.fabric.tiers,
      rails: fabric.rails,
      leaf_model: design.fabric.leaf_model,
      spine_model: design.fabric.spine_model,
      leaf_port_split: { downlinks: fabric.split.down, uplinks: fabric.split.up },
      counts: fabric.totals,
    };

    doc.racks = racks.map((rack) => ({
      name: rack.name,
      layout: rack.layout,
      role: DCP.Catalog.RACK_LAYOUTS[rack.layout].role,
      frame: {
        type: rack.rack_type,
        u_height: rack.u_height,
        width_m: rack.frame.w_m,
        depth_m: rack.frame.d_m,
      },
      position: rack.position
        ? { row: rack.row, slot: rack.slot, x_m: rack.x, y_m: rack.y, facing: rack.facing, pinned: !!rack.pinned }
        : null,
      totals: {
        u_used: rack.u_used,
        u_free: rack.u_height - rack.u_used,
        kw: rack.kw,
        gpus: rack.gpus,
        weight_kg: rack.weight_kg,
        pdus_per_side: rack.pdus_per_side,
      },
      elevation: rack.devices.map((d) => ({
        u: d.u, ru: d.ru, name: d.name, model: d.model, role: d.role, kw: d.kw,
      })),
    }));

    doc.devices = [];
    for (const rack of racks) {
      for (const d of rack.devices) {
        doc.devices.push({
          name: d.name, role: d.role, kind: d.kind, model: d.model, sku: d.sku,
          rack: rack.name, u: d.u, ru: d.ru, kw: d.kw,
          gpus: d.gpus || undefined,
          nics: d.nics || undefined,
          nic_speed_gbps: d.nic_speed || undefined,
          ports: d.ports || undefined,
          rail: d.rail,
          power: d.busbar_powered ? "busbar" : `${d.psus || 0}× PSU A/B`,
        });
      }
    }

    doc.cables = cables.map((c) => ({
      label: c.label,
      class: c.class,
      media: c.media,
      length_m: c.length_m,
      speed_gbps: c.speed_gbps || undefined,
      feed: c.feed,
      rail: c.rail,
      bundle: c.bundle,
      bends: c.bends || undefined,
      in_rack: c.in_rack || undefined,
      a: c.a,
      b: c.b,
      status: "planned",
    }));

    // Media actually used, with their reach limits, so a consumer can re-check
    // "does this cable fit its medium?" without the JS catalog in hand.
    doc.media = {};
    for (const key of [...new Set(cables.map((c) => c.media))].sort()) {
      const spec = DCP.Catalog.MEDIA[key] || DCP.Catalog.POWER_MEDIA[key] || DCP.Catalog.COOLANT_MEDIA[key];
      if (!spec) continue;
      doc.media[key] = {
        name: spec.name,
        max_m: spec.max_m,
        speed_gbps: spec.speed_gbps,
        amps: spec.amps,
        dn: spec.dn,
        od_mm: spec.od_mm,
        cost_usd: spec.cost_usd,
      };
    }

    doc.bundles = model.bundles.map((b) => ({
      id: b.id, cables: b.cables, tray_segments: b.segments, trunk_length_m: b.tree_length_m,
    }));

    doc.labels = { conventions: LABEL_CONVENTIONS };

    doc.optimization = optimization;

    doc.totals = totals;

    doc.validation = {
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
      items: validation.items.map((i) => ({ severity: i.severity, code: i.code, subject: i.subject, message: i.message })),
    };

    return doc;
  }

  const HEADER = [
    "# Source of truth: room, racks, power, cooling, and the cable schedule.",
    "#",
    "# GENERATED by the AIDataCenter planner. Do not hand-edit: change the design",
    "# and re-export, or this file and the room stop agreeing with each other.",
    "#",
    "# Cable lengths are ROUTED lengths -- rack rise + tray run + drop + slack --",
    "# not straight-line distances, which is why the medium column is trustworthy.",
    "#",
    "# Labels: print both ends. Conventions are listed under `labels.conventions`.",
  ].join("\n");

  function toYaml(model) {
    return `${HEADER}\n\n${dump(toDocument(model), { flowMax: 6 })}`;
  }

  DCP.Yaml = { dump, toDocument, toYaml, LABEL_CONVENTIONS };
})(typeof globalThis !== "undefined" ? globalThis : this);
