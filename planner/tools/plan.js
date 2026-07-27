#!/usr/bin/env node
/**
 * Headless planner: design JSON → source-of-truth YAML.
 *
 * The browser app and this script run the *same* modules, so anything you can
 * draw in the UI you can also produce in CI:
 *
 *   node planner/tools/plan.js                          # default design
 *   node planner/tools/plan.js my-design.json -o dc.yml
 *   node planner/tools/plan.js --set room.width_m=32 --set cooling.mode=air
 *   node planner/tools/plan.js --report                 # summary, no YAML
 *
 * Exit code is 1 when validation reports an error, so a bad design fails a
 * pipeline instead of quietly shipping.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const MODULES = [
  "util.js", "catalog.js", "design.js", "floor.js", "graph.js",
  "partition.js", "pathways.js", "cost.js", "constraints.js", "pod.js",
  "placement.js", "fabric.js",
  "cooling.js", "power.js", "validate.js", "build.js", "yaml.js",
];

for (const m of MODULES) require(path.join(__dirname, "..", "js", m));
const DCP = globalThis.DCP;

function parseArgs(argv) {
  const out = { sets: [], input: null, output: null, report: false, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--output") out.output = argv[++i];
    else if (a === "--set") out.sets.push(argv[++i]);
    else if (a === "--report") out.report = true;
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else out.input = a;
  }
  return out;
}

/**
 * Fill a loaded design out to the current schema.
 *
 * The design object doubles as the save file, so a file written before a knob
 * existed simply has no opinion about it. Without this, that absence silently
 * became a *different* default from the one `defaultDesign()` documents -- a
 * saved design would quietly run with one utility pass instead of three and
 * nothing would say so. Merging over the defaults keeps old files working and
 * keeps "the default" a single definition.
 *
 * Arrays are taken from the file wholesale rather than merged element-wise: the
 * rack list is the design, and a positional merge with the default racks would
 * be nonsense.
 */
function withDefaults(loaded) {
  const merge = (base, over) => {
    if (Array.isArray(over) || over === null) return over;
    if (typeof over !== "object" || typeof base !== "object" || base === null) {
      return over === undefined ? base : over;
    }
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
      out[k] = k in base ? merge(base[k], v) : v;
    }
    return out;
  };
  return merge(DCP.Design.defaultDesign(), loaded);
}

function setPath(obj, dotted, raw) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in cur)) throw new Error(`unknown design path: ${dotted}`);
    cur = cur[parts[i]];
  }
  const key = parts[parts.length - 1];
  if (!(key in cur)) throw new Error(`unknown design key: ${dotted}`);
  let value = raw;
  if (raw === "true") value = true;
  else if (raw === "false") value = false;
  else if (raw !== "" && !Number.isNaN(Number(raw))) value = Number(raw);
  cur[key] = value;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^.*?\/\*\*/s, ""));
    return 0;
  }

  const design = args.input
    ? withDefaults(JSON.parse(fs.readFileSync(args.input, "utf8")))
    : DCP.Design.defaultDesign();

  for (const s of args.sets) {
    const idx = s.indexOf("=");
    if (idx < 0) throw new Error(`--set expects key=value, got ${s}`);
    setPath(design, s.slice(0, idx), s.slice(idx + 1));
  }

  const t0 = Date.now();
  const model = DCP.Build.build(design);
  const ms = Date.now() - t0;

  // --json and --report are both "summary" modes: YAML only goes to stdout when
  // neither is set, otherwise it would corrupt the machine-readable output.
  const summaryMode = args.report || args.json;
  if (summaryMode) {
    const summary = {
      elapsed_ms: ms,
      totals: model.totals,
      optimization: model.optimization,
      validation: {
        ok: model.validation.ok,
        errors: model.validation.errors,
        warnings: model.validation.warnings,
        items: model.validation.items,
      },
    };
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printReport(model, ms);
    }
  }

  if (!summaryMode || args.output) {
    const yaml = DCP.Yaml.toYaml(model);
    if (args.output) {
      fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
      fs.writeFileSync(args.output, yaml);
      if (!args.json) console.error(`wrote ${args.output} (${yaml.length} bytes)`);
    } else if (!summaryMode) {
      process.stdout.write(yaml);
    }
  }

  return model.validation.errors > 0 ? 1 : 0;
}

function printReport(model, ms) {
  const t = model.totals;
  const o = model.optimization;
  const line = (k, v) => console.log(`  ${String(k).padEnd(26)} ${v}`);

  console.log(`\nAIDataCenter planner — ${model.design.meta.name} / ${model.design.meta.room}   (${ms} ms)`);
  console.log("\nROOM");
  line("area", `${t.room_area_m2} m²  (${model.design.room.width_m} × ${model.design.room.depth_m} m)`);
  line("rack positions", `${t.rack_positions} available, ${t.racks} used`);
  line("cooling", `${t.cooling_mode} — ${t.cooling_capacity_kw} kW capacity`);
  line("IT load", `${t.it_load_kw} kW  (${t.power_density_kw_m2} kW/m²)`);
  line("facility load", `${t.facility_load_kw} kW`);

  console.log("\nBUILD");
  line("racks / GPUs / servers", `${t.racks} / ${t.gpus} / ${t.servers}`);
  line("switches", t.switches);
  line("rack PDUs", t.rack_pdus);
  line("cables", `${t.cables}  (${t.cable_length_m} m, $${t.cable_cost_usd.toLocaleString("en-US")})`);
  for (const [cls, s] of Object.entries(t.cables_by_class)) {
    line(`  ${cls}`, `${s.count} × ${s.length_m} m`);
  }
  for (const [m, s] of Object.entries(t.cables_by_media)) {
    line(`  ${m}`, `${s.count} × ${s.length_m} m  $${s.cost_usd.toLocaleString("en-US")}`);
  }

  console.log("\nOPTIMIZATION");
  line("partition cut", `${o.partition.cut_gbps} GB/s (baseline ${o.partition.baseline_cut_gbps}, −${o.partition.improvement_pct}%)`);
  const p = o.placement;
  const usd = (v) => `$${(v || 0).toLocaleString("en-US")}`;
  const pctOf = (base, now) => (base > 0 ? Math.round(((base - now) / base) * 1000) / 10 : 0);
  line("placement method", `${p.method}${p.seed ? ` · ${p.seed} seed` : ""}${p.iters ? ` · ${p.iters} iters · ${p.accepted} accepted` : ""}`);
  line("inter-rack media", `${usd(p.cost_usd)} (baseline ${usd(p.baseline_cost_usd)}, −${p.cost_improvement_pct}%)`);
  line("routed length", `${p.length_m} m (baseline ${p.baseline_length_m} m, −${p.length_improvement_pct}%)`);
  line("rack spacing range", `${p.span_m[0]}–${p.span_m[1]} m`);
  line("locked by reach", `${usd(p.fixed_usd)} over ${p.pinned_groups} rack pairs`);
  line("movable by layout", `${usd(p.movable_usd)} over ${p.movable_groups} rack pairs`);
  line("placement leverage", `${usd(p.leverage_usd)} · gap to bound ${p.gap_pct}%`);
  if (p.leverage_usd === 0) {
    line("", "every inter-rack run sits on one rung of the reach ladder —");
    line("", "no arrangement of racks can change what the optics cost");
  }
  for (const u of p.unlock) {
    line(`  −${u.delta_m} m per link`, `would save ${usd(u.saving_usd)} (${u.links_reclassed} links reclassed)`);
  }
  if (p.calibration && p.calibration.cables) {
    line("estimator error", `${p.calibration.mean_error_m} m mean · ${p.calibration.max_error_m} m max · ${p.calibration.media_mismatch} mispriced`);
  }

  // Every term the objective weighed, so the total can be checked by hand.
  const term = p.terms || {};
  const baseTerm = p.baseline_terms || {};
  const delta = (now, was) => (was ? ` (baseline ${usd(was)}, ${now <= was ? "−" : "+"}${Math.abs(pctOf(was, now))}%)` : "");
  console.log("\nOBJECTIVE TERMS");
  line("cable — material", usd(term.cable_material_usd));
  line("cable — pull labour", usd(term.cable_pull_usd));
  line("power — whips", `${usd(term.power_whip_usd)}${delta(term.power_whip_usd, baseTerm.power_whip_usd)}`);
  line("coolant — hoses", `${usd(term.coolant_hose_usd)}${delta(term.coolant_hose_usd, baseTerm.coolant_hose_usd)}`);
  line("maintenance — access", `${usd(term.maintenance_usd)}${delta(term.maintenance_usd, baseTerm.maintenance_usd)}`);
  if (term.expansion_usd) line("expansion — reserve", usd(term.expansion_usd));
  line("structural — overload", usd(term.structural_usd));
  line("traffic — locality", usd(term.traffic_usd));
  line("weighted objective", `${usd(term.objective_usd)} (baseline ${usd(baseTerm.objective_usd)}, −${p.objective_improvement_pct}%)`);

  const uc = o.utility_convergence;
  if (uc) {
    line("utility fixed point", `${uc.passes} pass(es) of ${uc.max_passes} · ` +
      (uc.converged ? "converged" : "still moving at the last pass") +
      ` · kept pass ${uc.kept_pass}`);
    for (const h of uc.history) {
      line(`  pass ${h.pass}${h.pass === uc.kept_pass ? " ←" : "  "}`,
        `${h.racks_moved === null ? "seed" : `${h.racks_moved} rack(s) moved`}` +
        ` · whips ${usd(h.power_usd)} · hoses ${usd(h.coolant_usd)}`);
    }
  }

  const c = o.constraints;
  if (c) {
    console.log("\nCONSTRAINTS");
    line("hard violations", `${c.hard_violations}`);
    line("distributed floor load", `peak ${c.bay.peak_kg_m2} kg/m² of ${c.bay.capacity_kg_m2} ` +
      `over ${c.bay.bay_size_m} m bays · ${c.bay.bays_over} bay(s) over`);
    line("heavy-rack haul", `> ${c.crane_required_kg} kg within ${c.max_haul_m} m of ` +
      `the door at (${c.access_door.x_m}, ${c.access_door.y_m})`);
    if (c.reserve) {
      line("expansion reserve", `${Math.round(c.reserve.fraction * 100)}% of depth beyond ` +
        `y=${c.reserve.y0_m} m · ${c.reserve.racks_inside} rack(s) inside it`);
    }
  }

  const pods = o.pods;
  if (pods && pods.enabled) {
    console.log("\nPODS");
    for (const pod of pods.list) {
      const bb = pod.bounds;
      line(pod.name, `${pod.racks} racks · ${pod.kw} kW · ${pod.positions} positions` +
        (bb ? ` · x ${bb.x0}–${bb.x1} m, y ${bb.y0}–${bb.y1} m` : ""));
    }
  }

  console.log("");
  line("trunks (Steiner)", `${o.bundling.trunks} · ${o.bundling.trunk_length_m} m of shared pathway`);
  line("data tray fill", `peak ${(o.routing.data_tray.peak_fill * 100).toFixed(0)}% · mean ${(o.routing.data_tray.mean_fill * 100).toFixed(0)}%`);
  line("power tray fill", `peak ${(o.routing.power_tray.peak_fill * 100).toFixed(0)}% · mean ${(o.routing.power_tray.mean_fill * 100).toFixed(0)}%`);

  console.log(`\nVALIDATION — ${model.validation.errors} error(s), ${model.validation.warnings} warning(s)`);
  for (const item of model.validation.items) {
    const tag = { error: "ERROR", warn: " WARN", info: " INFO" }[item.severity];
    console.log(`  ${tag}  [${item.code}] ${item.message}`);
  }
  console.log("");
}

process.exit(main());
