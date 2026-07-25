/**
 * UI wiring. Every control writes into `state.design` and asks for a re-solve;
 * nothing here computes anything about the room itself. That keeps the browser
 * and `tools/plan.js` producing byte-identical YAML from the same design.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});
  const $ = (id) => document.getElementById(id);

  const state = {
    design: DCP.Design.defaultDesign(),
    model: null,
    yaml: null,
    view: "floor",
    overlay: "none",
    selected: null,
    cableFilter: "all",
    search: "",
  };

  /* -------------------------------------------------------------- solve -- */

  let solveTimer = null;
  function requestSolve(delay = 160) {
    $("solve-state").textContent = "solving…";
    $("solve-state").classList.add("busy");
    clearTimeout(solveTimer);
    solveTimer = setTimeout(solveNow, delay);
  }

  function solveNow() {
    const t0 = performance.now();
    try {
      state.model = DCP.Build.build(state.design);
      state.yaml = null; // regenerated lazily
    } catch (err) {
      $("solve-state").textContent = "failed";
      $("findings").innerHTML =
        `<div class="finding error"><code>internal</code>${String(err && err.message || err)}</div>`;
      console.error(err);
      return;
    }
    const ms = Math.round(performance.now() - t0);
    $("solve-state").textContent = `${ms} ms`;
    $("solve-state").classList.remove("busy");
    renderAll();
  }

  /* ------------------------------------------------------------- render -- */

  function renderAll() {
    const model = state.model;
    DCP.Render.renderStats($("stats"), model);
    DCP.Render.renderFindings($("findings"), $("validation-badge"), model, select);
    DCP.Render.renderReport($("report"), model);
    DCP.Render.renderSelection($("selection"), model, state.selected);
    renderRackList();
    renderHints();

    if (state.view === "floor") {
      DCP.Render.renderFloor($("floorplan"), model, {
        overlay: state.overlay,
        selected: state.selected,
        onSelect: select,
        onPin: pinRack,
      });
      $("floor-legend").innerHTML = DCP.Render.legendFor(state.overlay);
    } else if (state.view === "elevation") {
      DCP.Render.renderElevations($("elevations"), model, state.selected);
    } else if (state.view === "cables") {
      renderCableFilters();
      const r = DCP.Render.renderCables($("cable-table"), model, state.cableFilter, state.search);
      $("cable-summary").textContent =
        `${r.total} cables · ${model.totals.cable_length_m} m total${r.shown < r.total ? ` (showing ${r.shown})` : ""}`;
    } else if (state.view === "yaml") {
      const yaml = getYaml();
      $("yaml-out").textContent = yaml;
      $("yaml-size").textContent = `${(yaml.length / 1024).toFixed(1)} KB · ${model.totals.cables} cables`;
    }
  }

  /** The document is large; only build it when something actually wants it. */
  function getYaml() {
    if (!state.yaml) state.yaml = DCP.Yaml.toYaml(state.model);
    return state.yaml;
  }

  function renderHints() {
    const m = state.model;
    $("room-hint").textContent =
      `${m.floor.rows.length} rows × ${m.floor.slotsPerRow} slots = ${m.floor.capacity} positions · ` +
      `${m.totals.racks} used · row pitch ${DCP.Util.round(m.floor.pitch, 2)} m`;

    const c = m.cooling;
    $("cooling-hint").textContent =
      `${c.capacity_kw} kW capacity for ${c.it_load_kw} kW IT · ceiling ${c.per_rack_cap_kw} kW/rack` +
      (c.mode === "water" ? ` · ${c.flow_lpm} L/min at ΔT ${c.delta_t} K` : "");

    const p = m.power.totals;
    $("power-hint").textContent =
      `${p.facility_kw} kW facility · UPS firm ${p.ups_firm_capacity_per_feed_kw} kW/feed · ` +
      `${p.distribution_units} distribution units · ${p.rack_pdu_count} rack PDUs`;

    $("arch-hint").textContent = DCP.Catalog.FABRIC_ARCHS[state.design.fabric.arch].desc;
    $("rack-count").textContent = `${state.design.racks.length} racks`;
    $("water-type-field").style.display = state.design.cooling.mode === "water" ? "" : "none";
    $("rpp-model").parentElement.style.display = "";
  }

  function renderRackList() {
    const list = $("rack-list");
    const mode = state.design.cooling.mode;
    list.innerHTML = state.design.racks.map((rack) => {
      const layout = DCP.Catalog.RACK_LAYOUTS[rack.layout];
      const built = state.model.racks.find((r) => r.id === rack.id);
      const legal = DCP.Design.layoutLegalUnder(rack.layout, mode);
      const color = { compute: "#76b900", network: "#ff9800", storage: "#00bcd4", mgmt: "#ce93d8" }[layout.role];
      return `<div class="rack-row ${state.selected === rack.id ? "selected" : ""} ${legal ? "" : "illegal"}"
          data-rack="${rack.id}" style="border-left-color:${color}">
        <div><span class="nm">${rack.name}</span>
          <span class="sub">${layout.name}${built ? ` · ${built.kw} kW` : ""}${legal ? "" : " · needs " + layout.cooling.join("/")}</span></div>
        ${layout.max_servers > 0
          ? `<input type="number" min="0" max="${layout.max_servers}" value="${rack.servers}" data-servers="${rack.id}" title="servers"/>`
          : "<span></span>"}
        <button data-remove="${rack.id}" title="remove">×</button>
      </div>`;
    }).join("");

    list.querySelectorAll("[data-rack]").forEach((node) =>
      node.addEventListener("click", (e) => {
        if (e.target.dataset.remove || e.target.dataset.servers) return;
        select(node.dataset.rack);
      }));
    list.querySelectorAll("[data-remove]").forEach((node) =>
      node.addEventListener("click", () => {
        DCP.Design.removeRack(state.design, node.dataset.remove);
        if (state.selected === node.dataset.remove) state.selected = null;
        requestSolve(0);
      }));
    list.querySelectorAll("[data-servers]").forEach((node) =>
      node.addEventListener("change", () => {
        const rack = state.design.racks.find((r) => r.id === node.dataset.servers);
        if (rack) rack.servers = Math.max(0, Number(node.value) || 0);
        requestSolve(0);
      }));
  }

  function renderCableFilters() {
    const classes = ["all", ...new Set(state.model.cables.map((c) => c.class))];
    const bar = $("cable-filter");
    if (bar.dataset.classes === classes.join(",")) return;
    bar.dataset.classes = classes.join(",");
    bar.innerHTML = classes.map((c) =>
      `<button type="button" data-value="${c}" class="${c === state.cableFilter ? "active" : ""}">${c}</button>`).join("");
    bar.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        state.cableFilter = b.dataset.value;
        bar.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
        renderAll();
      }));
  }

  function select(rackId) {
    state.selected = state.selected === rackId ? null : rackId;
    renderAll();
  }

  function pinRack(rackId, xy) {
    const rack = state.design.racks.find((r) => r.id === rackId);
    if (!rack) return;
    rack.pinned = xy;
    state.selected = rackId;
    requestSolve(0);
  }

  /* ------------------------------------------------------------- inputs -- */

  function get(path) {
    return path.split(".").reduce((o, k) => o[k], state.design);
  }
  function set(path, value) {
    const parts = path.split(".");
    const last = parts.pop();
    parts.reduce((o, k) => o[k], state.design)[last] = value;
  }

  /** Two-way bind one control to one design path. */
  function bind(id, path, opts = {}) {
    const el = $(id);
    if (!el) return;
    const kind = el.type === "checkbox" ? "checkbox" : el.tagName === "SELECT" ? "select" : el.type;

    const write = () => {
      let v;
      if (kind === "checkbox") v = el.checked;
      else if (kind === "number" || kind === "range") v = Number(el.value);
      else v = opts.number ? Number(el.value) : el.value;
      set(path, v);
      if (opts.after) opts.after(v);
      const out = $(`${id}-v`);
      if (out) out.textContent = opts.format ? opts.format(v) : v;
      requestSolve(kind === "range" ? 200 : 0);
    };

    const initial = get(path);
    if (kind === "checkbox") el.checked = !!initial;
    else el.value = initial;
    const out = $(`${id}-v`);
    if (out) out.textContent = opts.format ? opts.format(initial) : initial;

    el.addEventListener(kind === "range" ? "input" : "change", write);
  }

  function fillSelect(id, entries, selected) {
    const el = $(id);
    if (!el) return;
    el.innerHTML = entries.map(([value, label]) =>
      `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`).join("");
  }

  function segmented(id, path, after) {
    const bar = $(id);
    if (!bar) return;
    const sync = () => bar.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.value === String(get(path))));
    bar.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        set(path, b.dataset.value);
        sync();
        if (after) after(b.dataset.value);
        requestSolve(0);
      }));
    sync();
  }

  function bindAll() {
    const C = DCP.Catalog;

    bind("room-width", "room.width_m", { format: (v) => `${v.toFixed(1)} m` });
    bind("room-depth", "room.depth_m", { format: (v) => `${v.toFixed(1)} m` });
    bind("room-height", "room.clear_height_m", { format: (v) => `${v.toFixed(1)} m` });
    bind("cold-aisle", "room.cold_aisle_m");
    bind("hot-aisle", "room.hot_aisle_m");
    bind("raised-floor", "room.raised_floor");

    segmented("cooling-mode", "cooling.mode", refreshLayoutOptions);
    bind("water-type", "cooling.water_type");
    bind("cool-redundancy", "cooling.redundancy");
    bind("racks-per-cdu", "cooling.racks_per_cdu");
    bind("supply-c", "cooling.supply_c");
    bind("return-c", "cooling.return_c");

    bind("entrances", "power.entrances", { number: true });
    bind("entrance-kw", "power.entrance_kw");
    fillSelect("ups-model", Object.entries(C.UPS).map(([k, v]) => [k, v.model]), state.design.power.ups_model);
    bind("ups-model", "power.ups_model");
    bind("ups-redundancy", "power.ups_redundancy");
    bind("distribution", "power.distribution", { after: refreshDistributionOptions });
    bind("rack-pdu", "power.rack_pdu_model");
    fillSelect("rack-pdu", Object.entries(C.RACK_PDU).map(([k, v]) => [k, v.model]), state.design.power.rack_pdu_model);
    bind("rack-pdu", "power.rack_pdu_model");
    bind("device-cords", "power.emit_device_cords");
    refreshDistributionOptions(state.design.power.distribution);

    fillSelect("arch", Object.entries(C.FABRIC_ARCHS).map(([k, v]) => [k, v.name]), state.design.fabric.arch);
    bind("arch", "fabric.arch");
    bind("oversub", "fabric.oversubscription", { number: true });
    bind("tiers", "fabric.tiers", { number: true });
    fillSelect("leaf-model",
      Object.entries(C.SWITCHES).filter(([, v]) => v.tier === "leaf" || v.tier === "spine").map(([k, v]) => [k, v.model]),
      state.design.fabric.leaf_model);
    bind("leaf-model", "fabric.leaf_model");
    fillSelect("spine-model",
      Object.entries(C.SWITCHES).filter(([, v]) => v.tier === "spine" || v.tier === "super").map(([k, v]) => [k, v.model]),
      state.design.fabric.spine_model);
    bind("spine-model", "fabric.spine_model");

    bind("tp", "workload.tp_size");
    bind("pp", "workload.pp_size");
    bind("dp", "workload.dp_replicas");

    bind("placement", "optimizer.placement");
    bind("iters", "optimizer.anneal_iters");
    bind("obj-weight", "optimizer.objective_traffic_weight", {
      format: (v) => `${Math.round(v * 100)}% traffic`,
    });
    bind("do-partition", "optimizer.partition");
    bind("do-bundle", "optimizer.bundle");
    bind("seed", "optimizer.seed");

    refreshLayoutOptions();
    $("btn-add-rack").addEventListener("click", () => {
      DCP.Design.addRack(state.design, $("add-layout").value);
      requestSolve(0);
    });

    // Selects whose option set depends on another control.
    function refreshDistributionOptions(mode) {
      const entries = mode === "busway"
        ? Object.entries(C.BUSWAY).map(([k, v]) => [k, v.model])
        : Object.entries(C.RPP).map(([k, v]) => [k, v.model]);
      const path = mode === "busway" ? "power.busway_model" : "power.rpp_model";
      fillSelect("rpp-model", entries, get(path));
      const el = $("rpp-model");
      el.onchange = () => {
        set(path, el.value);
        requestSolve(0);
      };
    }

    function refreshLayoutOptions() {
      const mode = state.design.cooling.mode;
      fillSelect("add-layout", Object.entries(C.RACK_LAYOUTS).map(([k, v]) =>
        [k, v.cooling.includes(mode) ? v.name : `${v.name} — needs ${v.cooling.join("/")}`]));
    }

    // Tabs and overlays.
    document.querySelectorAll(".tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
        state.view = tab.dataset.view;
        document.querySelectorAll(".view").forEach((v) =>
          v.classList.toggle("active", v.id === `view-${state.view}`));
        renderAll();
      }));

    $("overlay-mode").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        state.overlay = b.dataset.value;
        $("overlay-mode").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
        renderAll();
      }));

    $("cable-search").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderAll();
    });

    $("btn-resolve").addEventListener("click", () => requestSolve(0));
    $("btn-reset").addEventListener("click", () => {
      state.design = DCP.Design.defaultDesign();
      state.selected = null;
      bindAll();
      requestSolve(0);
    });
    $("btn-download").addEventListener("click", download);
    $("btn-download2").addEventListener("click", download);
    $("btn-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(getYaml());
        $("btn-copy").textContent = "Copied";
        setTimeout(() => ($("btn-copy").textContent = "Copy"), 1200);
      } catch {
        $("btn-copy").textContent = "Copy failed";
      }
    });
  }

  function download() {
    const blob = new Blob([getYaml()], { type: "text/yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.design.meta.name}-${state.design.meta.room.replace(/\s+/g, "-").toLowerCase()}.yml`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  document.addEventListener("DOMContentLoaded", () => {
    solveNow();     // model first: the rack list renders against it
    bindAll();
    renderAll();
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
