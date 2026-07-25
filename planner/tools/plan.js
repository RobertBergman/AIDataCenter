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
  "partition.js", "placement.js", "pathways.js", "fabric.js",
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
    ? JSON.parse(fs.readFileSync(args.input, "utf8"))
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
  line("placement objective", `${o.placement.objective} (baseline ${o.placement.baseline_objective}, −${o.placement.improvement_pct}%)`);
  line("placement method", `${o.placement.method}${o.placement.iters ? ` · ${o.placement.iters} iters · ${o.placement.accepted} accepted` : ""}`);
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
