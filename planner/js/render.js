/**
 * Rendering: floor plan (SVG, metre-space), rack elevations, cable schedule,
 * and the report panels.
 *
 * The floor plan draws in real metres -- the SVG viewBox *is* the room -- so
 * every rectangle is to scale and dragging maps straight back to coordinates
 * without a pixel-to-metre fudge factor anywhere.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const ROLE_COLOR = {
    compute: "#76b900", network: "#ff9800", storage: "#00bcd4", mgmt: "#ce93d8",
  };
  const EQUIP_COLOR = {
    cdu: "#4dd0e1", crah: "#90a4ae", rdhx: "#26a69a", manifold: "transparent",
    ups: "#ffb74d", rpp: "#a1887f", busway: "#8d6e63", entrance: "#ef5350",
    switchboard: "#f06292",
  };

  /** Blue → amber → red ramp for fill and density overlays. */
  function ramp(t) {
    const x = Math.max(0, Math.min(1, t));
    if (x < 0.5) {
      const k = x / 0.5;
      return `rgb(${Math.round(61 + k * 179)}, ${Math.round(156 + k * 24)}, ${Math.round(240 - k * 199)})`;
    }
    const k = (x - 0.5) / 0.5;
    return `rgb(${Math.round(240)}, ${Math.round(180 - k * 133)}, ${Math.round(41 + k * 79)})`;
  }

  /* ---------------------------------------------------------- floor plan -- */

  function renderFloor(svg, model, opts = {}) {
    const { design, floor, racks, equipment } = model;
    const W = design.room.width_m;
    const D = design.room.depth_m;
    const pad = 1.2;
    svg.setAttribute("viewBox", `${-pad} ${-pad} ${W + pad * 2} ${D + pad * 2}`);

    const parts = [];
    const t = (x, y, text, size = 0.3, cls = "") =>
      `<text x="${x}" y="${y}" font-size="${size}" fill="currentColor" class="${cls}" text-anchor="middle" dominant-baseline="middle" style="font-family:var(--mono);pointer-events:none">${esc(text)}</text>`;

    // Shell + keep-clear.
    parts.push(`<rect x="0" y="0" width="${W}" height="${D}" fill="#0d131b" stroke="#3a4556" stroke-width="0.08"/>`);
    parts.push(`<rect x="${design.room.perimeter_m}" y="${design.room.perimeter_m}"
      width="${Math.max(0, W - 2 * design.room.perimeter_m)}" height="${Math.max(0, D - 2 * design.room.perimeter_m)}"
      fill="none" stroke="#243041" stroke-width="0.03" stroke-dasharray="0.25 0.2"/>`);

    // Aisles: cold in front, hot between the backs.
    for (const aisle of floor.aisles) {
      parts.push(`<rect x="${floor.usable.x0}" y="${aisle.y0}" width="${Math.max(0, floor.usable.x1 - floor.usable.x0)}"
        height="${aisle.y1 - aisle.y0}" fill="${aisle.type === "cold" ? "#12243c" : "#2c1c1c"}" opacity="0.75"/>`);
    }

    // Service zones.
    const z = floor.zones;
    if (z.electrical) {
      parts.push(`<rect x="${z.electrical.x0}" y="${z.electrical.y0}" width="${z.electrical.x1 - z.electrical.x0}"
        height="${z.electrical.y1 - z.electrical.y0}" fill="#1a1508" stroke="#3d3419" stroke-width="0.03"/>`);
      parts.push(t((z.electrical.x0 + z.electrical.x1) / 2, z.electrical.y0 + 0.45, "ELECTRICAL", 0.26));
    }
    if (z.distribution) {
      parts.push(`<rect x="${z.distribution.x0}" y="${z.distribution.y0}" width="${z.distribution.x1 - z.distribution.x0}"
        height="${z.distribution.y1 - z.distribution.y0}" fill="#161110" stroke="#3a2e29" stroke-width="0.03"/>`);
    }

    // Tray overlay, drawn under the racks so labels stay readable.
    if (opts.overlay === "data" || opts.overlay === "power") {
      const g = model.graph[opts.overlay];
      for (const e of g.edges) {
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        if (a.kind === "drop" || b.kind === "drop") continue;
        const fill = e.cap > 0 ? e.used / e.cap : 0;
        if (fill <= 0) continue;
        parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
          stroke="${ramp(fill)}" stroke-width="${0.06 + Math.min(0.34, fill * 0.34)}"
          stroke-linecap="round" opacity="0.9"/>`);
      }
    }

    // Racks.
    const maxKw = Math.max(1, ...racks.map((r) => r.kw));
    for (const rack of racks) {
      if (rack.x === undefined) continue;
      const w = rack.frame.w_m;
      const d = rack.frame.d_m;
      const x = rack.x - w / 2;
      const y = rack.y - d / 2;
      const role = DCP.Catalog.RACK_LAYOUTS[rack.layout].role;
      const base = ROLE_COLOR[role] || "#607d8b";
      const fill = opts.overlay === "heat" ? ramp(rack.kw / maxKw) : base;
      const selected = opts.selected === rack.id;
      // Labels are drawn in metres, so they have to be fitted to the frame or a
      // 750 mm rack ends up wearing its neighbour's name.
      const nameSize = Math.min(0.2, (w * 0.88) / (rack.name.length * 0.58));
      const kwText = `${rack.kw.toFixed(0)}kW`;
      const kwSize = Math.min(0.17, (w * 0.8) / (kwText.length * 0.58));
      parts.push(`<g class="rack-shape" data-rack="${esc(rack.id)}">
        <rect x="${x}" y="${y}" width="${w}" height="${d}" rx="0.06"
          fill="${fill}" fill-opacity="${opts.overlay === "heat" ? 0.85 : 0.28}"
          stroke="${selected ? "#ffffff" : fill}" stroke-width="${selected ? 0.09 : 0.05}"/>
        <rect x="${x}" y="${rack.facing === "north" ? y : y + d - 0.08}" width="${w}" height="0.08" fill="${fill}"/>
        ${rack.pinned ? `<circle cx="${x + w - 0.12}" cy="${y + 0.12}" r="0.07" fill="#fff"/>` : ""}
        ${t(rack.x, rack.y - 0.16, rack.name, nameSize)}
        ${t(rack.x, rack.y + 0.14, kwText, kwSize)}
      </g>`);
    }

    // Plant.
    for (const eq of equipment) {
      const kind = eq.kind || (eq.kva ? "ups" : eq.capacity_kw !== undefined ? "rpp" : "entrance");
      const color = EQUIP_COLOR[kind] || "#78909c";
      if (kind === "manifold" || kind === "rdhx") continue; // mounted on a rack

      if (kind === "busway") {
        parts.push(`<line x1="${eq.x0}" y1="${eq.y}" x2="${eq.x1}" y2="${eq.y}"
          stroke="${color}" stroke-width="0.12" stroke-dasharray="0.5 0.25" opacity="0.9"/>`);
        continue;
      }
      const w = eq.w_m || 0.8;
      const d = eq.d_m || 0.8;
      const isEntrance = eq.id && String(eq.id).startsWith("entrance");
      // Mark the bypass section so a lineup that can be worked on live reads
      // differently from one that cannot.
      const bypass = kind === "switchboard" && eq.bypass
        ? `<rect x="${(eq.x || 0) - w / 2 + 0.06}" y="${(eq.y || 0) - d / 2 + 0.06}"
             width="${Math.max(0.05, w - 0.12)}" height="${Math.max(0.05, d - 0.12)}" rx="0.04"
             fill="none" stroke="${color}" stroke-width="0.04" stroke-dasharray="0.3 0.2"/>`
        : "";
      parts.push(`<g class="equip-shape" data-equip="${esc(eq.id)}">
        <rect x="${(eq.x || 0) - (isEntrance ? 0.2 : w / 2)}" y="${(eq.y || 0) - d / 2}"
          width="${isEntrance ? 0.4 : w}" height="${d}" rx="0.05"
          fill="${color}" fill-opacity="0.35" stroke="${color}" stroke-width="0.05"/>
        ${bypass}
        ${t(eq.x, eq.y, eq.name, 0.16)}
      </g>`);
    }

    svg.innerHTML = parts.join("\n");
    attachFloorInteractions(svg, model, opts);
  }

  /**
   * Click to select, drag to pin. Snapping happens against the same position
   * list the solver uses, so a dragged rack lands exactly where a solved one
   * would -- there is no "manual" coordinate space.
   */
  function attachFloorInteractions(svg, model, opts) {
    const toUser = (evt) => {
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX;
      pt.y = evt.clientY;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    };

    svg.querySelectorAll(".rack-shape").forEach((node) => {
      const rackId = node.dataset.rack;
      let dragging = false;
      let moved = false;

      node.addEventListener("pointerdown", (evt) => {
        dragging = true;
        moved = false;
        node.classList.add("dragging");
        node.setPointerCapture(evt.pointerId);
      });

      node.addEventListener("pointermove", (evt) => {
        if (!dragging) return;
        moved = true;
        const p = toUser(evt);
        node.setAttribute("transform",
          `translate(${p.x - (model.racks.find((r) => r.id === rackId)?.x ?? p.x)}, ${p.y - (model.racks.find((r) => r.id === rackId)?.y ?? p.y)})`);
      });

      node.addEventListener("pointerup", (evt) => {
        if (!dragging) return;
        dragging = false;
        node.classList.remove("dragging");
        node.removeAttribute("transform");
        if (!moved) {
          if (opts.onSelect) opts.onSelect(rackId);
          return;
        }
        const p = toUser(evt);
        const pos = DCP.Floor.nearestPosition(model.floor, p.x, p.y);
        if (pos && opts.onPin) opts.onPin(rackId, { x: pos.x, y: pos.y });
      });
    });

    svg.querySelectorAll(".equip-shape").forEach((node) => {
      node.addEventListener("click", () => {
        if (opts.onSelectEquip) opts.onSelectEquip(node.dataset.equip);
      });
    });
  }

  /* ---------------------------------------------------------- elevations -- */

  function renderElevations(el, model, selectedId) {
    const racks = selectedId ? model.racks.filter((r) => r.id === selectedId) : model.racks;
    const pdusByRack = DCP.Util.groupBy(model.power.rack_pdus, (p) => p.rack);
    const U_PX = 8;

    el.innerHTML = racks.map((rack) => {
      const height = rack.u_height;
      const slots = new Array(height + 1).fill(null);
      for (const dev of rack.devices) slots[dev.u] = dev;

      const rows = [];
      for (let u = 1; u <= height; u++) {
        const dev = slots[u];
        if (dev) {
          const color = dev.kind === "switch" ? "#ff9800"
            : dev.kind === "pdu" ? EQUIP_COLOR.rpp
            : ROLE_COLOR.compute;
          // A horizontal PDU is real estate like anything else in the frame, so
          // it is drawn in the stack rather than only as a chip underneath.
          const detail = dev.kind === "pdu" ? `${dev.amps}A ${dev.feed}` : `${dev.kw}kW`;
          rows.push(`<div class="u-dev" style="height:${dev.ru * U_PX}px;background:${dev.class === "nvlink" ? "#7e57c2" : color}"
            title="${esc(dev.name)} — ${esc(dev.model)} · U${dev.u}${dev.kind === "pdu" ? "" : ` · ${dev.kw} kW`}">
            <span>${esc(dev.name)}</span><span>${esc(detail)}</span></div>`);
          u += dev.ru - 1;
        } else {
          rows.push(`<div class="u-slot"></div>`);
        }
      }

      const pdus = pdusByRack.get(rack.name) || [];
      return `<div class="elevation">
        <h3>${esc(rack.name)}</h3>
        <div class="meta">${esc(DCP.Catalog.RACK_LAYOUTS[rack.layout].name)}<br/>
          ${rack.u_used}/${height}U · ${rack.kw} kW · ${rack.weight_kg} kg${rack.gpus ? ` · ${rack.gpus} GPU` : ""}</div>
        <div class="u-stack">${rows.join("")}</div>
        <div class="pdu-strip">${pdus.map((p) =>
          `<span class="pdu-chip ${p.feed.toLowerCase()}" title="${esc(p.model_name || p.model)} · ${p.usable_kw} kW usable · ${p.outlets} outlets (${p.outlets_c19} × C19) · ${esc(p.mount)}">${esc(p.name.replace(`PDU-${rack.name}-`, ""))} ${p.amps}A${p.ru ? ` ${p.ru}U` : ""}</span>`).join("")}</div>
      </div>`;
    }).join("");
  }

  /* ------------------------------------------------------ cable schedule -- */

  function renderCables(table, model, filter, search) {
    const q = (search || "").trim().toLowerCase();
    const rows = model.cables.filter((c) => {
      if (filter && filter !== "all" && c.class !== filter) return false;
      if (!q) return true;
      return `${c.label} ${c.a.device} ${c.a.port} ${c.b.device} ${c.b.port} ${c.media}`.toLowerCase().includes(q);
    });

    const head = `<thead><tr>
      <th>Label</th><th>Class</th><th>A device</th><th>A port</th>
      <th>B device</th><th>B port</th><th>Media</th><th class="num">m</th><th>Path</th>
    </tr></thead>`;

    const body = rows.slice(0, 2000).map((c) => `<tr>
      <td class="label">${esc(c.label)}</td>
      <td>${esc(c.class)}</td>
      <td>${esc(c.a.device)}</td><td>${esc(c.a.port)}</td>
      <td>${esc(c.b.device)}</td><td>${esc(c.b.port)}</td>
      <td>${esc(c.media)}</td>
      <td class="num">${c.length_m}</td>
      <td>${esc(c.bundle || c.pathway || "")}</td>
    </tr>`).join("");

    table.innerHTML = head + `<tbody>${body}</tbody>`;
    return { shown: Math.min(rows.length, 2000), total: rows.length };
  }

  /* --------------------------------------------------------- report/UI ---- */

  function renderStats(el, model) {
    const t = model.totals;
    const v = model.validation;
    const stat = (k, val, cls = "") => `<div class="stat ${cls}"><span class="k">${k}</span><span class="v">${val}</span></div>`;
    el.innerHTML = [
      stat("Racks", t.racks),
      stat("GPUs", t.gpus),
      stat("IT load", `${t.it_load_kw} kW`),
      stat("Cooling", t.cooling_mode),
      stat("Cables", t.cables),
      stat("Cable $", `${(t.cable_cost_usd / 1000).toFixed(0)}k`),
      stat("Errors", v.errors, v.errors ? "bad" : "good"),
      stat("Warnings", v.warnings, v.warnings ? "warn" : ""),
    ].join("");
  }

  function renderFindings(el, badge, model, onSelect) {
    const items = model.validation.items;
    const v = model.validation;
    badge.textContent = v.errors
      ? `${v.errors} error${v.errors > 1 ? "s" : ""}`
      : v.warnings
        ? `${v.warnings} warning${v.warnings > 1 ? "s" : ""}`
        : "clean";
    badge.className = `badge ${model.validation.errors ? "bad" : model.validation.warnings ? "warn" : ""}`;

    if (!items.length) {
      el.innerHTML = `<div class="finding info">No findings — the room is buildable as drawn.</div>`;
      return;
    }
    const order = { error: 0, warn: 1, info: 2 };
    el.innerHTML = [...items].sort((a, b) => order[a.severity] - order[b.severity])
      .map((i) => `<div class="finding ${i.severity}" data-subject="${esc(i.subject || "")}">
        <code>${esc(i.code)}</code>${esc(i.message)}</div>`).join("");

    el.querySelectorAll(".finding").forEach((node) => {
      node.addEventListener("click", () => {
        const rack = model.racks.find((r) => r.name === node.dataset.subject);
        if (rack && onSelect) onSelect(rack.id);
      });
    });
  }

  function renderReport(el, model) {
    const o = model.optimization;
    const t = model.totals;
    const kv = (k, v, cls = "") => `<div class="kv"><span>${k}</span><span class="${cls}">${v}</span></div>`;
    const pctText = (p) => (p > 0 ? `−${p}%` : `${-p}%`);

    el.innerHTML = [
      `<h4>Partitioning (KL/FM)</h4>`,
      kv("inter-rack demand", `${o.partition.cut_gbps} GB/s`),
      kv("vs sequential fill", pctText(o.partition.improvement_pct), o.partition.improvement_pct > 0 ? "win" : ""),
      kv("multilevel depth", o.partition.levels),

      `<h4>Placement (QAP)</h4>`,
      kv("method", `${o.placement.method}${o.placement.seed ? ` · ${o.placement.seed} seed` : ""}`),
      kv("inter-rack media", `$${o.placement.cost_usd.toLocaleString("en-US")}`),
      kv("vs baseline", pctText(o.placement.cost_improvement_pct), o.placement.cost_improvement_pct > 0 ? "win" : ""),
      kv("routed length", `${o.placement.length_m} m`),
      kv("vs baseline", pctText(o.placement.length_improvement_pct), o.placement.length_improvement_pct > 0 ? "win" : ""),
      o.placement.accepted !== undefined ? kv("moves accepted", `${o.placement.accepted} / ${o.placement.iters || "—"}`) : "",
      kv("objective mix", `${Math.round(o.placement.traffic_weight * 100)}% traffic`),

      // The honest part: how much of the bill any arrangement could have moved.
      `<h4>Placement leverage</h4>`,
      kv("rack spacing range", `${o.placement.span_m[0]}–${o.placement.span_m[1]} m`),
      kv("locked by reach", `$${o.placement.fixed_usd.toLocaleString("en-US")} · ${o.placement.pinned_groups} pairs`),
      kv("movable by layout", `$${o.placement.movable_usd.toLocaleString("en-US")} · ${o.placement.movable_groups} pairs`),
      kv("achievable range", `$${o.placement.leverage_usd.toLocaleString("en-US")}`,
        o.placement.leverage_usd > 0 ? "" : "muted"),
      kv("gap to lower bound", `${o.placement.gap_pct}%`),
      o.placement.leverage_usd === 0
        ? `<p class="hint">Every inter-rack run in this room lands on the same rung of the
           reach ladder, so no arrangement of racks can change what the optics cost.
           The levers here are fabric architecture and cable overhead, not placement.</p>`
        : "",
      ...(o.placement.unlock.length
        ? [`<h4>If every run were shorter</h4>`,
           ...o.placement.unlock.map((u) =>
             kv(`−${u.delta_m} m per link`,
                `save $${u.saving_usd.toLocaleString("en-US")} · ${u.links_reclassed} links`, "win"))]
        : []),
      o.placement.calibration && o.placement.calibration.cables
        ? kv("estimator error",
            `${o.placement.calibration.mean_error_m} m mean · ${o.placement.calibration.media_mismatch} mispriced`,
            o.placement.calibration.media_mismatch ? "warn" : "")
        : "",

      `<h4>Routing (A*)</h4>`,
      kv("data tray peak fill", `${(o.routing.data_tray.peak_fill * 100).toFixed(0)}%`),
      kv("power tray peak fill", `${(o.routing.power_tray.peak_fill * 100).toFixed(0)}%`),
      kv("congestion weight", o.routing.congestion_weight),
      kv("bend penalty", `${o.routing.bend_penalty_m} m`),

      `<h4>Bundling (Steiner)</h4>`,
      kv("trunks", o.bundling.trunks),
      kv("shared pathway", `${o.bundling.trunk_length_m} m`),

      `<h4>Material</h4>`,
      kv("total cable", `${t.cable_length_m} m`),
      kv("estimated cost", `$${t.cable_cost_usd.toLocaleString("en-US")}`),
      ...Object.entries(t.cables_by_media).map(([m, s]) => kv(m, `${s.count} × ${s.length_m} m`)),
    ].join("");
  }

  function renderSelection(el, model, rackId) {
    const rack = model.racks.find((r) => r.id === rackId);
    if (!rack) {
      el.innerHTML = "Nothing selected.";
      return;
    }
    const cables = model.cables.filter((c) => c.a.rack === rack.name || c.b.rack === rack.name);
    const byClass = DCP.Util.groupBy(cables, (c) => c.class);
    const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
    const pdus = model.power.rack_pdus.filter((p) => p.rack === rack.name);
    const feeds = [...new Set(pdus.map((p) => p.feed))];

    el.innerHTML = [
      `<h4>${esc(rack.name)}</h4>`,
      kv("layout", DCP.Catalog.RACK_LAYOUTS[rack.layout].name),
      kv("position", rack.position ? `row ${rack.row} · slot ${rack.slot}` : "unplaced"),
      kv("coordinates", rack.x !== undefined ? `${rack.x.toFixed(2)}, ${rack.y.toFixed(2)} m` : "—"),
      kv("pinned", rack.pinned ? "yes" : "no (solver-placed)"),
      kv("RU used", `${rack.u_used} / ${rack.u_height}`),
      kv("load", `${rack.kw} kW`),
      kv("weight", `${rack.weight_kg} kg`),
      kv("GPUs", rack.gpus || 0),
      `<h4>Power</h4>`,
      kv("feeds", feeds.join(" / ") || "—"),
      kv("PDUs per side", rack.pdus_per_side || 0),
      ...feeds.map((f) => kv(`${f} capacity`,
        `${DCP.Util.round(DCP.Util.sum(pdus.filter((p) => p.feed === f), (p) => p.usable_kw), 1)} kW`)),
      `<h4>Cables (${cables.length})</h4>`,
      ...[...byClass.entries()].map(([cls, list]) =>
        kv(cls, `${list.length} · ${DCP.Util.round(DCP.Util.sum(list, (c) => c.length_m), 1)} m`)),
    ].join("");
  }

  function legendFor(overlay) {
    if (overlay === "data" || overlay === "power") {
      return `<span><i style="background:${ramp(0.1)}"></i>light</span>
        <span><i style="background:${ramp(0.6)}"></i>busy</span>
        <span><i style="background:${ramp(1)}"></i>at capacity</span>`;
    }
    if (overlay === "heat") {
      return `<span><i style="background:${ramp(0.1)}"></i>low kW</span>
        <span><i style="background:${ramp(1)}"></i>highest kW</span>`;
    }
    return Object.entries(ROLE_COLOR)
      .map(([k, v]) => `<span><i style="background:${v}"></i>${k}</span>`).join("")
      + `<span><i style="background:${EQUIP_COLOR.cdu}"></i>CDU</span>`
      + `<span><i style="background:${EQUIP_COLOR.switchboard}"></i>switchboard + bypass</span>`
      + `<span><i style="background:${EQUIP_COLOR.ups}"></i>UPS</span>`
      + `<span><i style="background:${EQUIP_COLOR.rpp}"></i>RPP</span>`
      + `<span><i style="background:${EQUIP_COLOR.entrance}"></i>service</span>`;
  }

  DCP.Render = {
    renderFloor, renderElevations, renderCables, renderStats,
    renderFindings, renderReport, renderSelection, legendFor, ramp,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
