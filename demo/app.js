/**
 * AIDataCenter live bootstrap demo
 * Simulates NetBox → seed → switches → CAPI cluster → Flux platform
 * Views: rack topology, live cabling map (169 cables), streaming terminal.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHASES = [
  { id: "netbox", name: "NetBox SoT", desc: "Import site seed, export inventory" },
  { id: "seed", name: "Seed host", desc: "DHCP / DNS / NTP / iPXE" },
  { id: "switches", name: "Provision switches", desc: "OOB + spines + leaves + EVPN overlay" },
  { id: "capi", name: "Metal3 + CAPI", desc: "CP ×3 bare-metal" },
  { id: "gpu", name: "GPU cluster", desc: "8× B200 workers" },
  { id: "flux", name: "Flux platform", desc: "GitOps apps & operators" },
  { id: "model", name: "Model deploy", desc: "Kimi K2 Thinking · TP=8 ×4" },
  { id: "api", name: "API online", desc: "VIP · gateway · scheduler · tokens" },
  { id: "ready", name: "Cluster ready", desc: "64 GPUs · serving · smoke checks" },
];

const APPS = [
  { id: "core", name: "platform-core", detail: "cert-manager, node classes" },
  { id: "security", name: "platform-security", detail: "Vault HA + External Secrets" },
  { id: "netbox", name: "platform-netbox", detail: "Production NetBox DCIM/IPAM" },
  { id: "registry", name: "platform-registry", detail: "Harbor container registry" },
  { id: "obs", name: "platform-observability", detail: "Prometheus, Loki, Alloy" },
  { id: "bus", name: "platform-bus", detail: "Redpanda inference archive bus" },
  { id: "gpu", name: "platform-gpu", detail: "GPU Operator + Network Operator" },
  { id: "serving", name: "platform-serving", detail: "KServe + KubeRay" },
  { id: "models", name: "platform-models", detail: "Kimi K2 Thinking InferenceService" },
  { id: "api", name: "platform-api", detail: "MetalLB, Envoy GW, EPP scheduler, archive tap" },
];

function makeDevice(partial) {
  return { status: "planned", logs: [], ...partial };
}

function buildInventory() {
  const devices = [];

  devices.push(
    makeDevice({ id: "seed01", name: "seed01", role: "seed", type: "Bootstrap utility",
      rack: "BOOT", ru: 36, ip: "10.10.0.10", bmc: "—", meta: "dnsmasq" })
  );

  for (let i = 1; i <= 3; i++) {
    devices.push(
      makeDevice({ id: `cp0${i}`, name: `cp0${i}`, role: "cp", type: "K8s control plane",
        rack: "BOOT", ru: 35 - i, ip: `10.10.0.2${i}`, bmc: `10.20.0.2${i}`, meta: "etcd" })
    );
  }

  for (let i = 1; i <= 3; i++) {
    devices.push(
      makeDevice({ id: `util0${i}`, name: `util0${i}`, role: "util", type: "Utility / platform",
        rack: "BOOT", ru: 32 - i, ip: `10.10.0.3${i}`, bmc: `10.20.0.3${i}`, meta: "svc" })
    );
  }

  devices.push(
    makeDevice({ id: "spine1", name: "spine1", role: "spine", type: "Arista 7060DX5-64S",
      rack: "BOOT", ru: 20, ip: "mgmt via OOB", bmc: "—", meta: "spine", ports: 64 }),
    makeDevice({ id: "spine2", name: "spine2", role: "spine", type: "Arista 7060DX5-64S",
      rack: "BOOT", ru: 18, ip: "mgmt via OOB", bmc: "—", meta: "spine", ports: 64 })
  );

  const workerRu = [30, 24, 18, 12];
  for (let i = 1; i <= 8; i++) {
    const rack = i <= 4 ? "GPU-1" : "GPU-2";
    devices.push(
      makeDevice({ id: `worker0${i}`, name: `worker0${i}`, role: "gpu", type: "Dell PowerEdge XE9680",
        rack, ru: workerRu[(i - 1) % 4], ip: `10.10.0.${100 + i}`, bmc: `10.20.0.${100 + i}`,
        meta: "8×B200", gpus: 8, rails: 8, workerIndex: i })
    );
  }

  for (let r = 0; r < 8; r++) {
    devices.push(
      makeDevice({ id: `leaf-rail${r}`, name: `leaf-rail${r}`, role: "leaf", type: "Arista 7060DX5-32",
        rack: r < 4 ? "GPU-1" : "GPU-2", ru: 42 - (r % 4), ip: "mgmt via OOB", bmc: "—",
        meta: `rail ${r}`, rail: r, ports: 32 })
    );
  }

  devices.push(
    makeDevice({ id: "oob-sw1", name: "oob-sw1", role: "oob", type: "Arista 7010TX-48",
      rack: "GPU-1", ru: 48, ip: "10.20.0.2", bmc: "—", meta: "OOB" }),
    makeDevice({ id: "oob-sw2", name: "oob-sw2", role: "oob", type: "Arista 7010TX-48",
      rack: "GPU-2", ru: 48, ip: "10.20.0.3", bmc: "—", meta: "OOB" })
  );

  for (let i = 1; i <= 4; i++) {
    devices.push(
      makeDevice({ id: `stor0${i}`, name: `stor0${i}`, role: "stor",
        type: i <= 2 ? "Hot model FS" : "Archive object", rack: "STOR", ru: 30 - i * 4,
        ip: `10.40.0.1${i}`, bmc: `10.20.0.5${i}`, meta: i <= 2 ? "NVMe" : "obj" })
    );
  }

  return devices;
}

/**
 * Cable model — matches docs/cabling.md / site.yaml cabling_policy:
 *  - 64 host↔leaf:  workerN.rail{r} → leaf-rail{r}.Ethernet{N}   (DAC 400G, teal)
 *  - 64 leaf↔spine: leaf-rail{r}.Ethernet{17+u} → spine{u%2+1}    (AOC 400G, orange)
 *  - 41 OOB/mgmt:   14 BMC (VLAN20) + 15 mgmt0 (VLAN10) + 10 Ma1 (ZTP) + 2 MLAG peer (cat6/DAC, brown)
 */
function buildCables() {
  const cables = [];
  for (let w = 1; w <= 8; w++) {
    for (let r = 0; r < 8; r++) {
      cables.push({
        id: `R${r}-W0${w}`, cls: "hl",
        a: `worker0${w}`, b: `leaf-rail${r}`,
        label: `R${r}-W0${w}`,
        desc: `worker0${w}.rail${r} → leaf-rail${r}.Ethernet${w}`,
        media: "dac-qsfpdd-400g",
      });
    }
  }
  for (let r = 0; r < 8; r++) {
    for (let u = 0; u < 8; u++) {
      const s = (u % 2) + 1;
      cables.push({
        id: `L${r}S${s}-U${u + 1}`, cls: "ls",
        a: `leaf-rail${r}`, b: `spine${s}`,
        label: `L${r}S${s}-U${u + 1}`,
        desc: `leaf-rail${r}.Ethernet${17 + u} → spine${s}`,
        media: "aoc-qsfpdd-400g",
      });
    }
  }
  // 14 BMC cables: cp×3 + util×3 (BOOT → oob-sw1) + 8 workers per rack
  const oobHosts = [
    ["cp01", "oob-sw1"], ["cp02", "oob-sw1"], ["cp03", "oob-sw1"],
    ["util01", "oob-sw1"], ["util02", "oob-sw1"], ["util03", "oob-sw1"],
    ["worker01", "oob-sw1"], ["worker02", "oob-sw1"], ["worker03", "oob-sw1"], ["worker04", "oob-sw1"],
    ["worker05", "oob-sw2"], ["worker06", "oob-sw2"], ["worker07", "oob-sw2"], ["worker08", "oob-sw2"],
  ];
  for (const [host, sw] of oobHosts) {
    cables.push({
      id: `OOB-${host}`, cls: "oob",
      a: host, b: sw, label: `OOB-${host}`,
      desc: `${host}.bmc → ${sw} (VLAN 20)`, media: "cat6",
    });
  }
  // 15 mgmt0 cables (VLAN 10, OS/PXE): seed01 + cp×3 + util×3 (BOOT → oob-sw1) + 8 workers
  const mgmtHosts = [["seed01", "oob-sw1"], ...oobHosts];
  for (const [host, sw] of mgmtHosts) {
    cables.push({
      id: `MGMT-${host}`, cls: "oob",
      a: host, b: sw, label: `MGMT-${host}`,
      desc: `${host}.mgmt0 → ${sw} (VLAN 10)`, media: "cat6",
    });
  }
  // 10 switch Ma1 cables (VLAN 20, ZTP): spines (BOOT) + rail leaves per rack
  const ma1Hosts = [
    ["spine1", "oob-sw1"], ["spine2", "oob-sw1"],
    ["leaf-rail0", "oob-sw1"], ["leaf-rail1", "oob-sw1"], ["leaf-rail2", "oob-sw1"], ["leaf-rail3", "oob-sw1"],
    ["leaf-rail4", "oob-sw2"], ["leaf-rail5", "oob-sw2"], ["leaf-rail6", "oob-sw2"], ["leaf-rail7", "oob-sw2"],
  ];
  for (const [host, sw] of ma1Hosts) {
    cables.push({
      id: `MA1-${host}`, cls: "oob",
      a: host, b: sw, label: `MA1-${host}`,
      desc: `${host}.Management1 → ${sw} (VLAN 20, ZTP)`, media: "cat6",
    });
  }
  // 2 MLAG peer-link cables oob-sw1 ↔ oob-sw2
  for (const p of [49, 50]) {
    cables.push({
      id: `OOB-PEER-${p - 48}`, cls: "oob",
      a: "oob-sw1", b: "oob-sw2", label: `OOB-PEER-${p - 48}`,
      desc: `oob-sw1.Ethernet${p} ↔ oob-sw2.Ethernet${p} (MLAG peer)`, media: "dac-25g-5m",
    });
  }
  return cables;
}

const state = {
  phaseIndex: -1,
  running: false,
  paused: false,
  abort: false,
  selectedId: null,
  devices: buildInventory(),
  apps: APPS.map((a) => ({ ...a, status: "planned" })),
  rails: Array.from({ length: 8 }, (_, i) => ({ id: i, status: "planned" })),
  cables: buildCables(),
  model: { staged: false, replicas: 0 },
  view: "topology",
  speed: 1.5,
  stepResolve: null,
  mode: "idle", // idle | auto | step
};

// ---------- helpers ----------

function $(id) { return document.getElementById(id); }

function devById(id) { return state.devices.find((d) => d.id === id); }

function wait(ms) { return sleep(ms / state.speed); }

// ---------- event log ----------

function log(msg, cls = "info") {
  const el = $("log");
  const t = new Date().toISOString().slice(11, 19);
  const line = document.createElement("div");
  line.className = `line ${cls}`;
  line.innerHTML = `<span class="ts">${t}</span> ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ---------- terminal ----------

const term = {
  el: null,
  maxLines: 400,

  init() { this.el = $("term"); },

  _trim() {
    while (this.el.children.length > this.maxLines) this.el.firstChild.remove();
  },

  _scroll() { this.el.scrollTop = this.el.scrollHeight; },

  write(html, cls = "t-out") {
    const div = document.createElement("div");
    div.className = `tline ${cls}`;
    div.innerHTML = html;
    this.el.appendChild(div);
    this._trim();
    this._scroll();
  },

  /** Type a command like a human at the prompt. */
  async cmd(text, host = "workstation") {
    const div = document.createElement("div");
    div.className = "tline";
    div.innerHTML = `<span class="prompt">operator@${host}:~$ </span><span class="cmdline"></span><span class="cursor"></span>`;
    this.el.appendChild(div);
    this._trim();
    const span = div.querySelector(".cmdline");
    for (const ch of text) {
      if (state.abort) return;
      span.textContent += ch;
      this._scroll();
      await sleep(Math.max(4, 22 / state.speed));
    }
    div.querySelector(".cursor")?.remove();
    await wait(120);
  },

  /** Stream stdout lines. */
  async out(lines, cls = "t-out", gap = 60) {
    for (const line of lines) {
      if (state.abort) return;
      this.write(line, cls);
      await wait(gap);
    }
  },

  /** Stream a completion token-by-token onto one line (API demo). */
  async stream(text, cls = "t-out") {
    const div = document.createElement("div");
    div.className = `tline ${cls}`;
    div.innerHTML = `<span class="streamed"></span><span class="cursor"></span>`;
    this.el.appendChild(div);
    this._trim();
    const span = div.querySelector(".streamed");
    for (const tok of text.split(/(?<=\s)/)) {
      if (state.abort) return;
      span.textContent += tok;
      this._scroll();
      await sleep(Math.max(12, 55 / state.speed));
    }
    div.querySelector(".cursor")?.remove();
  },

  /** Remote device session header. */
  async ssh(host, banner) {
    this.write(`<span class="t-dim">── ssh redfish-console ${host} ── ${banner}</span>`, "t-dim");
    await wait(150);
  },

  clear() { this.el.innerHTML = ""; },
};

// ---------- state mutations ----------

function setDevice(id, patch) {
  const d = devById(id);
  if (!d) return;
  Object.assign(d, patch);
  renderDevice(d);
  renderCabling();
  if (state.selectedId === id) renderDetail(d);
  updateStats();
}

function setApp(id, status) {
  const a = state.apps.find((x) => x.id === id);
  if (!a) return;
  a.status = status;
  renderApps();
  updateStats();
}

function setRail(i, status) {
  state.rails[i].status = status;
  renderFabric();
}

function cableState(c) {
  const a = devById(c.a);
  const b = devById(c.b);
  if (!a || !b) return "planned";
  const up = (s) => s === "ready";
  const hot = (s) => s === "provisioning";
  if (up(a.status) && up(b.status)) return "connected";
  if (hot(a.status) || hot(b.status)) return "provisioning";
  // OOB cables come up when the switch is up (BMCs are always wired)
  if (c.cls === "oob" && up(b.status) && a.status !== "planned") return "connected";
  if (c.cls === "oob" && up(b.status)) return "provisioning";
  return "planned";
}

// ---------- phases bar ----------

function renderPhases() {
  $("phases").innerHTML = PHASES.map((p, i) => {
    let cls = "phase";
    if (i < state.phaseIndex) cls += " done";
    if (i === state.phaseIndex) cls += " active";
    const pct = i < state.phaseIndex ? 100 : i === state.phaseIndex ? 40 : 0;
    return `<div class="${cls}" data-phase="${i}">
      <div class="pid">Phase ${i === 0 ? "−1" : i - 1}</div>
      <div class="pname">${p.name}</div>
      <div class="pbar"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join("");
}

// ---------- racks ----------

function renderRacks() {
  const racks = [
    { id: "GPU-1", power: "~46 kW" },
    { id: "GPU-2", power: "~46 kW" },
    { id: "BOOT", power: "~3–8 kW" },
    { id: "STOR", power: "~5–15 kW" },
  ];
  const root = $("racks");
  root.innerHTML = racks
    .map((r) => {
      const units = state.devices
        .filter((d) => d.rack === r.id)
        .sort((a, b) => b.ru - a.ru);
      return `<div class="rack" data-rack="${r.id}">
        <div class="rack-head"><h3>${r.id}</h3><span>${r.power}</span></div>
        <div class="rack-body" id="rack-${r.id}">
          ${units.map((d) => unitHtml(d)).join("")}
        </div>
      </div>`;
    })
    .join("");

  root.querySelectorAll(".unit").forEach((el) => {
    el.addEventListener("click", () => select(el.dataset.id));
  });
}

function unitHtml(d) {
  const sel = state.selectedId === d.id ? " selected" : "";
  return `<div class="unit role-${d.role} ${d.status}${sel}" data-id="${d.id}" id="unit-${d.id}">
    <span class="ru">U${d.ru}</span>
    <span class="name"><span class="dot"></span>${d.name}</span>
    <span class="meta">${d.meta}</span>
  </div>`;
}

function renderDevice(d) {
  const el = document.getElementById(`unit-${d.id}`);
  if (el) {
    el.className = `unit role-${d.role} ${d.status}${state.selectedId === d.id ? " selected" : ""}`;
    el.querySelector(".meta").textContent =
      d.status === "ready" && d.role === "gpu"
        ? "8 GPU"
        : d.status === "provisioning"
          ? "…"
          : d.meta;
  }
  renderFabricNodes();
}

// ---------- fabric strip ----------

function renderFabric() {
  renderFabricNodes();
}

function renderFabricNodes() {
  const root = $("fabric");
  if (!root.dataset.init) {
    const workers = state.devices.filter((d) => d.role === "gpu");
    const leaves = state.devices.filter((d) => d.role === "leaf").sort((a, b) => a.rail - b.rail);
    const spines = state.devices.filter((d) => d.role === "spine");
    root.innerHTML = `
      <div class="fabric-col workers">
        <div class="fab-label">Workers</div>
        ${workers.map((w) => `<div class="fab-node" data-id="${w.id}" id="fab-${w.id}">${w.name}</div>`).join("")}
      </div>
      <div>
        <div class="fab-label">Rail 0–7 · host ↔ leaf ↔ spine</div>
        <div class="rails">
          ${state.rails.map((r, i) => `
            <div class="rail">
              <span>r${i}</span>
              <div class="rail-wire" id="wire-${i}" title="rail ${i}"></div>
              <span class="fab-node" data-id="${leaves[i].id}" id="fab-${leaves[i].id}" style="padding:0.1rem;cursor:pointer">${leaves[i].name.replace("leaf-", "")}</span>
            </div>`).join("")}
        </div>
      </div>
      <div class="fabric-col">
        <div class="fab-label">Spines</div>
        ${spines.map((s) => `<div class="fab-node" data-id="${s.id}" id="fab-${s.id}">${s.name}</div>`).join("")}
      </div>`;
    root.dataset.init = "1";
    root.querySelectorAll("[data-id]").forEach((el) => {
      el.addEventListener("click", () => select(el.dataset.id));
    });
  }

  // light-weight state refresh
  for (const d of state.devices) {
    const el = document.getElementById(`fab-${d.id}`);
    if (!el) continue;
    el.className = `fab-node ${d.status}${state.selectedId === d.id ? " selected" : ""}`;
  }
  state.rails.forEach((r, i) => {
    const wire = document.getElementById(`wire-${i}`);
    if (wire) wire.className = `rail-wire ${r.status === "ready" ? "on" : r.status === "provisioning" ? "provisioning" : ""}`;
  });
}

// ---------- cabling map ----------

const CAB = {
  workerX: 40, workerW: 110,
  leafX: 430, leafW: 110,
  spineX: 820, spineW: 120,
  oobY: 575,
  nodeH: 26,
  miniH: 18,
  workerY: (i) => 40 + i * 48,      // i = 0..7
  leafY: (r) => 40 + r * 48,        // r = 0..7
  bootY: (i) => 434 + i * 22,       // BOOT mini nodes (cp/util)
  spineY: (s) => (s === 1 ? 110 : 300),
};

function renderCabling() {
  const svg = $("cabling-svg");
  if (!svg) return;

  const workers = state.devices.filter((d) => d.role === "gpu").sort((a, b) => a.workerIndex - b.workerIndex);
  const leaves = state.devices.filter((d) => d.role === "leaf").sort((a, b) => a.rail - b.rail);
  const spines = state.devices.filter((d) => d.role === "spine");
  const oobs = state.devices.filter((d) => d.role === "oob");
  const bootNodes = state.devices.filter((d) => ["cp", "util"].includes(d.role));

  const nodePos = new Map();
  workers.forEach((w, i) => nodePos.set(w.id, { x: CAB.workerX, y: CAB.workerY(i), w: CAB.workerW, h: CAB.nodeH }));
  leaves.forEach((l, r) => nodePos.set(l.id, { x: CAB.leafX, y: CAB.leafY(r), w: CAB.leafW, h: CAB.nodeH }));
  spines.forEach((s) => nodePos.set(s.id, { x: CAB.spineX, y: CAB.spineY(s.name === "spine1" ? 1 : 2), w: CAB.spineW, h: CAB.nodeH }));
  bootNodes.forEach((b, i) => nodePos.set(b.id, { x: CAB.workerX, y: CAB.bootY(i), w: CAB.workerW, h: CAB.miniH }));
  nodePos.set("oob-sw1", { x: 240, y: CAB.oobY, w: 130, h: CAB.nodeH });
  nodePos.set("oob-sw2", { x: 600, y: CAB.oobY, w: 130, h: CAB.nodeH });

  const pathFor = (c) => {
    const A = nodePos.get(c.a);
    const B = nodePos.get(c.b);
    if (!A || !B) return "";
    const hA = A.h || CAB.nodeH;
    if (c.cls === "hl") {
      const x1 = A.x + A.w, y1 = A.y + hA / 2;
      const x2 = B.x, y2 = B.y + CAB.nodeH / 2;
      const mx = (x1 + x2) / 2;
      return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    }
    if (c.cls === "ls") {
      const u = parseInt(c.id.split("-U")[1], 10) - 1; // 0..7
      const x1 = A.x + A.w, y1 = A.y + CAB.nodeH / 2;
      const x2 = B.x, y2 = B.y + 6 + (u % 4) * 4;
      const mx = (x1 + x2) / 2 + (u % 2 ? 14 : -14);
      return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    }
    // oob: from bottom of node down to OOB switch
    const x1 = A.x + A.w / 2, y1 = A.y + hA;
    const x2 = B.x + B.w / 2 + (c.a.endsWith("1") || c.a.endsWith("3") ? -14 : 14), y2 = B.y;
    const my = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
  };

  const counts = { hl: 0, ls: 0, oob: 0 };
  const cablesSvg = state.cables
    .map((c) => {
      const st = cableState(c);
      if (st === "connected") counts[c.cls]++;
      const cls = st === "connected" ? `cable ${c.cls} connected flow` : st === "provisioning" ? `cable ${c.cls} provisioning` : `cable ${c.cls}`;
      return `<path class="${cls}" d="${pathFor(c)}"><title>${c.label} · ${c.desc} · ${c.media}</title></path>`;
    })
    .join("");

  const nodeSvg = (d, pos, sub, mini = false) => `
    <g class="cab-node ${mini ? "mini" : ""} ${d.status}${state.selectedId === d.id ? " selected" : ""}" data-id="${d.id}">
      <rect x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h || CAB.nodeH}"></rect>
      <text x="${pos.x + pos.w / 2}" y="${pos.y + (mini ? 12 : 16)}" text-anchor="middle">${d.name}</text>
      ${sub ? `<text class="sub" x="${pos.x + pos.w / 2}" y="${pos.y + (pos.h || CAB.nodeH) + 10}" text-anchor="middle">${sub}</text>` : ""}
    </g>`;

  svg.innerHTML = `
    ${cablesSvg}
    ${workers.map((w) => nodeSvg(w, nodePos.get(w.id), `10.10.0.${100 + w.workerIndex}`)).join("")}
    ${leaves.map((l) => nodeSvg(l, nodePos.get(l.id), `rail ${l.rail} · 7060DX5-32`)).join("")}
    ${spines.map((s) => nodeSvg(s, nodePos.get(s.id), "7060DX5-64S · BOOT")).join("")}
    ${oobs.map((o) => nodeSvg(o, nodePos.get(o.id), "7010TX-48 · BMC")).join("")}
    <text class="cab-group" x="${CAB.workerX}" y="${CAB.bootY(0) - 8}">BOOT cp/util (BMC → oob-sw1)</text>
    ${bootNodes.map((b) => nodeSvg(b, nodePos.get(b.id), null, true)).join("")}
  `;

  svg.querySelectorAll(".cab-node").forEach((el) => {
    el.addEventListener("click", () => select(el.dataset.id));
  });

  $("cable-count").textContent = `${counts.hl + counts.ls + counts.oob}/169`;
  $("cable-legend").innerHTML = `
    <span><span class="sw" style="background:#009688"></span>host ↔ leaf · DAC 400G <span class="n">${counts.hl}/64</span></span>
    <span><span class="sw" style="background:#ff9800"></span>leaf ↔ spine · AOC 400G <span class="n">${counts.ls}/64</span></span>
    <span><span class="sw" style="background:#795548"></span>OOB/mgmt · cat6+DAC <span class="n">${counts.oob}/41</span></span>
    <span class="muted">click a node to inspect · hover a cable for its label</span>`;
}

// ---------- platform apps ----------

function renderApps() {
  const root = $("apps");
  root.innerHTML = state.apps
    .map((a) => {
      const sel = state.selectedId === `app:${a.id}` ? " selected" : "";
      return `<div class="app-row ${a.status}${sel}" data-app="${a.id}">
        <span>${a.name}</span>
        <span class="st">${a.status}</span>
      </div>`;
    })
    .join("");
  root.querySelectorAll(".app-row").forEach((el) => {
    el.addEventListener("click", () => selectApp(el.dataset.app));
  });
}

// ---------- selection / inspector ----------

function clearSelected() {
  document.querySelectorAll(".unit.selected, .fab-node.selected, .app-row.selected, .cab-node.selected")
    .forEach((el) => el.classList.remove("selected"));
}

function select(id) {
  state.selectedId = id;
  clearSelected();
  document.getElementById(`unit-${id}`)?.classList.add("selected");
  document.querySelectorAll(`[data-id="${id}"]`).forEach((el) => el.classList.add("selected"));
  renderDetail(devById(id));
}

function selectApp(id) {
  state.selectedId = `app:${id}`;
  clearSelected();
  document.querySelector(`.app-row[data-app="${id}"]`)?.classList.add("selected");
  const a = state.apps.find((x) => x.id === id);
  $("detail").className = "detail";
  $("detail").innerHTML = `
    <h3>${a.name}</h3>
    <span class="badge ${a.status}">${a.status}</span>
    <dl>
      <dt>Layer</dt><dd>Flux Kustomization</dd>
      <dt>Path</dt><dd>bootstrap/platform/apps/…</dd>
      <dt>Detail</dt><dd style="font-family:inherit">${a.detail}</dd>
    </dl>
    <div class="actions">
      <button type="button" data-act="force-app" ${a.status === "planned" ? "" : "disabled"}>Force reconcile</button>
    </div>`;
  $("detail").querySelector("[data-act=force-app]")?.addEventListener("click", async () => {
    if (state.running) return;
    setApp(id, "provisioning");
    log(`flux reconcile ks ${a.name}`, "cmd");
    await term.cmd(`flux reconcile kustomization ${a.name} --with-source`);
    await wait(600);
    setApp(id, "ready");
    await term.out([`✔ ${a.name} Ready`], "t-ok");
    log(`${a.name} Ready`, "ok");
    selectApp(a.id);
  });
}

function renderDetail(d) {
  if (!d) {
    $("detail").className = "detail empty";
    $("detail").innerHTML = "<p>Click any device, switch, cable endpoint, or platform app to inspect it.</p>";
    return;
  }
  $("detail").className = "detail";
  const extras =
    d.role === "gpu"
      ? `<dt>GPUs</dt><dd>${d.gpus || 8} × B200</dd><dt>NICs</dt><dd>8× 400GbE rail</dd>`
      : d.role === "leaf" || d.role === "spine"
        ? `<dt>EOS</dt><dd>Arista EOS (sim)</dd><dt>Ports</dt><dd>${d.ports || "—"}</dd>`
        : d.role === "oob"
          ? `<dt>Role</dt><dd>BMC / Management1</dd>`
          : "";

  const cables = state.cables.filter((c) => c.a === d.id || c.b === d.id);
  const conn = cables.filter((c) => cableState(c) === "connected").length;
  const cableRows = cables.length
    ? `<dt>Cables</dt><dd>${conn}/${cables.length} connected</dd>` : "";

  $("detail").innerHTML = `
    <h3>${d.name}</h3>
    <span class="badge ${d.status}">${d.status}</span>
    <dl>
      <dt>Type</dt><dd>${d.type}</dd>
      <dt>Rack</dt><dd>${d.rack} · RU ${d.ru}</dd>
      <dt>Mgmt IP</dt><dd>${d.ip}</dd>
      <dt>BMC</dt><dd>${d.bmc}</dd>
      ${extras}
      ${cableRows}
    </dl>
    <div class="actions">
      <button type="button" data-act="provision" ${d.status === "planned" || d.status === "failed" ? "" : "disabled"}>
        Provision now
      </button>
      <button type="button" data-act="reboot" ${d.status === "ready" ? "" : "disabled"}>Reboot</button>
      <button type="button" data-act="fail" ${d.status === "ready" || d.status === "provisioning" ? "" : "disabled"}>Inject fail</button>
    </div>`;

  $("detail").querySelector("[data-act=provision]")?.addEventListener("click", () => manualProvision(d.id));
  $("detail").querySelector("[data-act=reboot]")?.addEventListener("click", async () => {
    log(`redfish reset ${d.name}`, "cmd");
    await term.cmd(`redfish -H ${d.bmc} power cycle`, "seed01");
    setDevice(d.id, { status: "provisioning" });
    await wait(900);
    setDevice(d.id, { status: "ready" });
    await term.out([`${d.name}: power cycle complete, POST ok`], "t-ok");
    log(`${d.name} back online`, "ok");
  });
  $("detail").querySelector("[data-act=fail]")?.addEventListener("click", async () => {
    setDevice(d.id, { status: "failed" });
    await term.out([`<span class="t-err">${d.name}: fault injected — BMC unreachable</span>`], "t-err");
    log(`${d.name} fault injected`, "warn");
  });
}

// ---------- stats ----------

function updateStats() {
  const gpus = state.devices
    .filter((d) => d.role === "gpu" && d.status === "ready")
    .reduce((n, d) => n + (d.gpus || 8), 0);
  const nodes = state.devices.filter((d) =>
    ["gpu", "cp", "util", "seed"].includes(d.role) && d.status === "ready"
  ).length;
  const sw = state.devices.filter((d) =>
    ["leaf", "spine", "oob"].includes(d.role) && d.status === "ready"
  ).length;
  const apps = state.apps.filter((a) => a.status === "ready").length;
  const cablesUp = state.cables.filter((c) => cableState(c) === "connected").length;
  $("stat-gpus").textContent = `${gpus} / 64`;
  $("stat-nodes").textContent = `${nodes} ready`;
  $("stat-sw").textContent = `${sw} / 12`;
  $("stat-apps").textContent = `${apps} / 10`;
  $("stat-cables").textContent = `${cablesUp} / 169`;
  $("stat-model").textContent = state.model.replicas > 0
    ? `K2 ×${state.model.replicas} TP8`
    : state.model.staged ? "staged" : "—";
}

// ---------- simulation engine ----------

async function gate() {
  while (state.paused && !state.abort) await sleep(80);
  if (state.abort) throw new Error("aborted");
  if (state.mode === "step") {
    await new Promise((resolve) => { state.stepResolve = resolve; });
    state.stepResolve = null;
  }
}

async function setPhase(i) {
  state.phaseIndex = i;
  renderPhases();
  // theater: surface the cabling view while switches provision
  if (i === 2) switchView("cabling");
  if (i === 4) switchView("topology");
  await gate();
}

async function provisionList(ids, opts = {}) {
  const { stagger = 200, duration = 900, label = "provisioning", console: useConsole = false } = opts;
  for (const id of ids) {
    await gate();
    const d = devById(id);
    log(`${label} ${d.name}…`, "run");
    setDevice(id, { status: "provisioning" });
    if (d.role === "leaf") setRail(d.rail, "provisioning");
    if (useConsole) {
      await term.out([`[metal3] ${d.name}: registering → inspecting → <span class="t-warn">provisioning</span> (ubuntu-24.04)`], "t-out", 40);
    }
    await wait(stagger);
  }
  await wait(duration);
  for (const id of ids) {
    await gate();
    const d = devById(id);
    setDevice(id, { status: "ready" });
    if (d.role === "leaf") setRail(d.rail, "ready");
    log(`${d.name} ready`, "ok");
    if (useConsole) {
      await term.out([`<span class="t-ok">[metal3] ${d.name}: provisioned</span> · ${d.ip}`], "t-ok", 30);
    }
    if (state.selectedId === id) renderDetail(d);
  }
}

async function runPipeline() {
  state.running = true;
  state.abort = false;
  $("btn-run").disabled = true;
  $("btn-step").disabled = state.mode === "auto";
  $("btn-pause").disabled = false;

  try {
    // ── Phase −1: NetBox SoT ────────────────────────────────
    await setPhase(0);
    log("cd bootstrap/netbox && docker compose up -d", "cmd");
    await term.cmd("cd bootstrap/netbox && docker compose up -d");
    await term.out([
      "[+] Running 3/3",
      " ✔ Container netbox-postgres  <span class='t-ok'>Started</span>",
      " ✔ Container netbox-redis     <span class='t-ok'>Started</span>",
      " ✔ Container netbox           <span class='t-ok'>Started</span>",
    ], "t-out", 90);
    await term.cmd("python3 scripts/import_seed.py  # NETBOX_URL=http://127.0.0.1:8081");
    await term.out([
      "site: lab",
      "racks: GPU-1 GPU-2 BOOT STOR",
      "devices: 8× poweredge-xe9680 · 8× 7060dx5-32 · 2× 7060dx5-64s · 2× 7010tx-48 · cp/util/storage",
      "cables: 64 fabric + 64 leaf-spine + 41 oob/mgmt = <span class='t-ok'>169</span>",
    ], "t-out", 70);
    log("NetBox: racks GPU-1, GPU-2, BOOT, STOR → active", "ok");
    await term.cmd("bash ../scripts/netbox-sync.sh");
    await term.out(["wrote inventory/cluster.yaml · inventory/ipam.yaml · seed/generated/dhcp-hosts.conf"], "t-out");
    log("Exported 8 workers · 3 CP · 3 util · fabric rails=8", "ok");

    // ── Phase 0: seed host ──────────────────────────────────
    await setPhase(1);
    await term.cmd("sudo bash scripts/00-seed-host.sh");
    await provisionList(["seed01"], { duration: 700, label: "configuring" });
    await term.out([
      "[seed] apt install -y dnsmasq chrony matchbox",
      "[seed] render dnsmasq.conf ← NetBox export (14 static leases)",
      "[seed] systemctl enable --now dnsmasq chrony matchbox",
      "<span class='t-ok'>[ok]</span> DHCP 10.10.0.0/24 · DNS *.ai.local · NTP · iPXE chainload",
    ], "t-out", 80);
    log("dnsmasq DHCP/DNS · chrony NTP · matchbox iPXE listening", "ok");

    // ── Phase 1: switches ───────────────────────────────────
    await setPhase(2);
    log("ZTP / CloudVision-style switch bring-up (simulated)", "run");
    await term.out(["<span class='t-dim'>── ZTP via DHCP option 67 → http://seed/boot.ipxe ──</span>"], "t-dim");

    await term.ssh("oob-sw1", "Arista 7010TX-48");
    await provisionList(["oob-sw1", "oob-sw2"], { stagger: 150, duration: 600, label: "OOB ZTP" });
    await term.out([
      "oob-sw1> <span class='t-ok'>EOS 4.32.0F</span> loaded · Management1 10.20.0.2/24",
      "oob-sw2> <span class='t-ok'>EOS 4.32.0F</span> loaded · Management1 10.20.0.3/24",
      "oob-sw1# show lldp neighbors | count → 11 BMC neighbors",
    ], "t-out", 70);
    log("BMC plane reachable via 7010TX-48 ×2", "ok");

    await term.ssh("spine1", "Arista 7060DX5-64S");
    await provisionList(["spine1", "spine2"], { stagger: 200, duration: 800, label: "spine EOS" });
    await term.out([
      "spine1# bgp underlay ASN 65000 · router-id 10.30.0.1 · VTEP Lo1 10.30.32.1",
      "spine2# bgp underlay ASN 65000 · router-id 10.30.0.2 · VTEP Lo1 10.30.32.2",
      "spine1# show bgp evpn summary → <span class='t-ok'>waiting for leaf peers</span>",
    ], "t-out", 70);

    await provisionList(
      [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `leaf-rail${i}`),
      { stagger: 120, duration: 1000, label: "rail leaf ZTP" }
    );
    await term.out([
      "leaf-rail0..7# Ethernet1-8 DAC QSFP-DD detected · Ethernet17-24 AOC up",
      "leaf-rail0# show bgp summary → 8× underlay sessions <span class='t-ok'>Established</span> (AS 65101↔65000)",
      "<span class='t-ok'>64× host↔leaf + 64× leaf↔spine cables verified against NetBox</span>",
    ], "t-out", 80);
    log("64× leaf↔spine uplinks + 64× host-rail ports ready", "ok");

    // EVPN/VXLAN overlay (docs/overlay.md) — rendered into the same ZTP configs
    await term.out([
      "<span class='t-dim'>── EVPN/VXLAN overlay (docs/overlay.md) — part of the rendered ZTP configs ──</span>",
      "leaf-rail0# show bgp evpn summary → spine1, spine2 <span class='t-ok'>Established</span> (16 overlay sessions fabric-wide)",
      "leaf-rail0# show vxlan vtep → <span class='t-ok'>9 remote VTEPs</span> (Lo1 10.30.32.0/24)",
      "vrf <span class='t-ok'>storage</span> L3VNI 50200 · VLAN 200 · VARP gw 10.40.64.1 — stor p2p isolated",
      "vrf <span class='t-ok'>edge</span>    L3VNI 50050 · VLAN 50  · VARP gw 10.50.64.1 — API ingress path",
      "spine1(vrf edge)# border eBGP AS 65500 <span class='t-ok'>up</span> — default in · 10.50.0.0/24 out",
    ], "t-out", 80);
    log("EVPN overlay up: vrf storage + vrf edge · border to campus (AS 65500)", "ok");

    log("STOR nodes powered (vrf storage p2p, deferred CSI)", "info");
    await provisionList(["stor01", "stor02", "stor03", "stor04"], {
      stagger: 80, duration: 500, label: "power-on",
    });

    // ── Phase 2: CAPI control plane ─────────────────────────
    await setPhase(3);
    await term.cmd("bash scripts/01-install-capi-metal3.sh");
    await wait(300);
    await term.out([
      "clusterctl init --infrastructure metal3 --ipam metal3",
      "✔ ironic + baremetal-operator + capi-controller ready (seed k3s)",
    ], "t-out", 80);
    await term.cmd("BMC_USERNAME=*** BMC_PASSWORD=*** bash scripts/02-apply-cluster.sh");
    await provisionList(["cp01", "cp02", "cp03"], {
      stagger: 350, duration: 1400, label: "Redfish inspect + ironic deploy", console: true,
    });
    await term.out([
      "kubeadmcontrolplane/ai-cluster → <span class='t-ok'>initialized</span>",
      "API VIP 10.10.0.20:6443 (kube-vip) <span class='t-ok'>serving</span>",
    ], "t-ok", 70);
    log("KubeadmControlPlane ai-cluster — API VIP 10.10.0.20:6443", "ok");
    await provisionList(["util01", "util02", "util03"], {
      stagger: 200, duration: 900, label: "utility machine", console: true,
    });

    // ── Phase 3: GPU workers ────────────────────────────────
    await setPhase(4);
    log("MachineDeployment gpu-workers (8) applying…", "run");
    await term.cmd("kubectl apply -f capi/workers-gpu.yaml  # machinedeployment gpu-workers ×8");
    await provisionList(["worker01", "worker02", "worker03", "worker04"], {
      stagger: 280, duration: 1600, label: "BareMetalHost GPU-1", console: true,
    });
    await provisionList(["worker05", "worker06", "worker07", "worker08"], {
      stagger: 280, duration: 1600, label: "BareMetalHost GPU-2", console: true,
    });
    await term.out([
      "worker01..08: 8× ConnectX-7 400G rails link-up · GPUDirect topology ok",
      "<span class='t-ok'>8 GPU nodes Ready</span> (taint nvidia.com/gpu=true:NoSchedule — waiting GPU Operator)",
    ], "t-out", 70);
    log("8 GPU nodes Ready (drivers pending GPU Operator)", "ok");

    // ── Phase 4: Flux platform ──────────────────────────────
    await setPhase(5);
    await term.cmd("GIT_URL=https://git.example.com/org/super.git bash scripts/03-install-flux.sh");
    await wait(300);
    await term.out(["✔ flux installed · GitRepository ai-cluster synced <span class='t-dim'>main@sha1:7f3a9c2</span>"], "t-out");
    for (const a of state.apps.filter((x) => !["models", "api"].includes(x.id))) {
      await gate();
      setApp(a.id, "provisioning");
      log(`flux: ${a.name} progressing`, "run");
      await term.out([`kustomization/${a.name} … <span class='t-warn'>Progressing</span>`], "t-out", 30);
      await wait(a.id === "gpu" ? 1400 : a.id === "serving" ? 1000 : 700);
      setApp(a.id, "ready");
      await term.out([`kustomization/${a.name} … <span class='t-ok'>Ready</span>`], "t-ok", 30);
      log(`${a.name} Ready`, "ok");
      if (a.id === "gpu") {
        for (const w of state.devices.filter((d) => d.role === "gpu")) {
          w.meta = "8 GPU";
          renderDevice(w);
        }
        await term.out([
          "gpu-operator: driver 570.x · container-toolkit · dcgm-exporter deployed",
          "network-operator: OFED + rdma-shared-dp on 8 rails",
          "<span class='t-ok'>nvidia.com/gpu Capacity = 8 × 8 = 64</span>",
        ], "t-out", 70);
        log("nvidia.com/gpu Capacity = 8 × 8 = 64", "ok");
      }
    }

    // ── Phase 5: model deploy (docs/serving.md) ─────────────
    await setPhase(6);
    setApp("models", "provisioning");
    log("flux: platform-models progressing — Kimi K2 Thinking", "run");
    await term.cmd("kubectl -n inference get job kimi-k2-thinking-download -w");
    await term.out([
      "hf download moonshotai/Kimi-K2-Thinking → /models/kimi-k2-thinking/v2026-07-19.partial",
      "  62 shards · <span class='t-warn'>594 GB</span> native INT4 QAT · via registry.ai.local HF proxy",
      "  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 594/594 GB · 41.2 GB/s (hot FS §6.4 target met)",
      "  sha256 CHECKSUMS … <span class='t-ok'>62/62 verified</span>",
      "  <span class='t-ok'>promoted kimi-k2-thinking → v2026-07-19</span> (atomic `current` symlink)",
    ], "t-out", 90);
    state.model.staged = true;
    updateStats();
    log("Weights staged: 594 GB INT4 · CHECKSUMS ok · current → v2026-07-19", "ok");

    await term.cmd("kubectl -n inference get isvc kimi-k2-thinking -w");
    await term.out(["inferenceservice/kimi-k2-thinking <span class='t-warn'>Loading</span> — 4 replicas · TP=8 over NVLink · 1 per XE9680"], "t-out");
    for (let r = 1; r <= 4; r++) {
      await gate();
      const w = devById(`worker0${r}`);
      w.meta = "K2 TP=8";
      renderDevice(w);
      state.model.replicas = r;
      updateStats();
      await term.out([
        `replica-${r} (worker0${r}): weights → HBM 594 GB · KV headroom ~750 GB · <span class='t-ok'>/health 200</span>`,
      ], "t-out", 60);
      log(`kimi-k2-thinking replica-${r} ready on worker0${r}`, "ok");
      await wait(350);
    }
    setApp("models", "ready");
    await term.out([
      "<span class='t-ok'>inferenceservice/kimi-k2-thinking Ready — 4/4 replicas (32 GPUs)</span> · worker05-08 = Ray/research pool",
    ], "t-ok");
    log("platform-models Ready — Kimi K2 Thinking 4× TP=8 replicas", "ok");

    // ── Phase 6: API online (gateway · scheduler · archive) ──
    await setPhase(7);
    setApp("api", "provisioning");
    log("flux: platform-api progressing — MetalLB, Envoy GW, EPP, archive tap", "run");
    await term.cmd("flux reconcile kustomization platform-api --with-source");
    await term.out([
      "metallb: VIP <span class='t-ok'>10.50.0.10</span> announced → leaf-rail0/7 (vrf edge · AS 65200 → 65101/65108)",
      "envoy-gateway: 2/2 proxies Ready · TLS inference.ai.local (issuer: internal-ca)",
      "security: api-key auth (Vault → ESO, 42 keys) · rate limit 120 req/min/key",
      "inferencepool/kimi-k2-thinking: EPP scheduler Ready — <span class='t-ok'>4 endpoints</span> (queue/KV/prefix scoring)",
      "archive-tap: ALS stream → redpanda inference.records · compactor cron hourly",
    ], "t-out", 90);
    setApp("api", "ready");
    log("platform-api Ready — https://inference.ai.local/v1 reachable from campus", "ok");

    await term.cmd('curl -s https://inference.ai.local/v1/models -H "x-api-key: ***"');
    await term.out(['{"data":[{"id":"<span class=\'t-ok\'>kimi-k2-thinking</span>","max_model_len":262144}]}'], "t-out");
    await term.cmd('openai chat -m kimi-k2-thinking "Why is my MoE all-to-all slow on rail 3?" --stream');
    await term.out(["<span class='t-dim'>EPP → replica-2 (queue 0 · kv 31% · prefix hit) · TTFT 412 ms</span>"], "t-dim");
    await term.stream(
      "⟨reasoning⟩ Rail 3 carries GPU3↔GPU3 expert traffic for every node; a slow rail is usually PFC pause or an ECN threshold problem, not NCCL. ⟨/reasoning⟩ Check leaf-rail3 for TC3 ECN marks vs PFC pauses first: `show qos interfaces Ethernet1-8` — marks are healthy, pauses are not (network.md §6.3). If pauses > 0, look for one host asserting pause: the PFC watchdog will errdisable it…",
      "t-ok"
    );
    await term.out([
      "<span class='t-dim'>usage: 41 in · 118 out · TPOT 24 tok/s · request_id req_8f31…c2 → inference.records → parquet (lag 4 s)</span>",
    ], "t-dim");
    log("First tokens served via VIP — captured to 1-year archive (lag 4 s)", "ok");

    // ── Phase 7: acceptance ─────────────────────────────────
    await setPhase(8);
    await term.cmd("bash scripts/04-smoke.sh");
    await wait(400);
    await term.out([
      "[<span class='t-ok'>PASS</span>] 3 CP Ready · API VIP 6443",
      "[<span class='t-ok'>PASS</span>] 8 workers Ready · nvidia.com/gpu = 64",
      "[<span class='t-ok'>PASS</span>] DCGM exporter scraped by Prometheus",
      "[<span class='t-ok'>PASS</span>] Harbor push/pull from GPU node",
      "[<span class='t-ok'>PASS</span>] Vault unsealed · raft peers = 3",
      "[<span class='t-ok'>PASS</span>] Redpanda kafka reachable from inference ns",
      "[<span class='t-ok'>PASS</span>] EVPN overlay: 16 sessions · 10 VTEPs · vrf storage/edge isolated",
      "[<span class='t-ok'>PASS</span>] kimi-k2-thinking 4/4 replicas · EPP spread balanced (100-prompt probe)",
      "[<span class='t-ok'>PASS</span>] auth: no key 401 · revoked 401 ≤ 5 min · over-quota 429",
      "[<span class='t-ok'>PASS</span>] archive: tagged request found in parquet ≤ 60 s",
    ], "t-out", 110);
    log("Smoke: CP · workers 8/8 · overlay · serving · auth · archive — all PASS", "ok");
    await term.out(["<span class='t-ok'>══ ai-cluster ACCEPTANCE PASS — 64× B200 online · Kimi K2 Thinking serving at https://inference.ai.local/v1 ══</span>"], "t-ok");
    log("ACCEPTANCE PASS — 64× B200 · Kimi K2 Thinking live", "ok");
    renderPhases();
    document.querySelectorAll(".phase").forEach((el) => {
      el.classList.add("done");
      el.classList.remove("active");
    });
  } catch (e) {
    if (e.message !== "aborted") log(`Error: ${e.message}`, "warn");
    else log("Simulation stopped", "warn");
  } finally {
    state.running = false;
    state.paused = false;
    state.mode = "idle";
    $("btn-run").disabled = false;
    $("btn-step").disabled = false;
    $("btn-pause").disabled = true;
    $("btn-pause").textContent = "Pause";
    updateStats();
  }
}

async function manualProvision(id) {
  if (state.running) {
    log("Pause/stop the automated run before manual provision", "warn");
    return;
  }
  const d = devById(id);
  if (!d || d.status === "ready") return;
  log(`manual provision ${d.name}`, "cmd");
  await term.cmd(`scripts/provision-one.sh ${d.name}  # manual`, "seed01");
  setDevice(id, { status: "provisioning" });
  if (d.role === "leaf") setRail(d.rail, "provisioning");
  await wait(1000);
  setDevice(id, { status: "ready" });
  if (d.role === "leaf") setRail(d.rail, "ready");
  await term.out([`<span class='t-ok'>${d.name}: provisioned</span>`], "t-ok");
  log(`${d.name} ready`, "ok");
}

// ---------- view / reset ----------

function switchView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  $("view-topology").classList.toggle("hidden", view !== "topology");
  $("view-cabling").classList.toggle("hidden", view !== "cabling");
  if (view === "cabling") renderCabling();
}

function reset() {
  state.abort = true;
  if (state.stepResolve) state.stepResolve();
  state.running = false;
  state.paused = false;
  state.mode = "idle";
  state.phaseIndex = -1;
  state.selectedId = null;
  state.devices = buildInventory();
  state.apps = APPS.map((a) => ({ ...a, status: "planned" }));
  state.rails = Array.from({ length: 8 }, (_, i) => ({ id: i, status: "planned" }));
  state.cables = buildCables();
  state.model = { staged: false, replicas: 0 };
  $("log").innerHTML = "";
  $("btn-run").disabled = false;
  $("btn-step").disabled = false;
  $("btn-pause").disabled = true;
  $("btn-pause").textContent = "Pause";
  renderAll();
  term.clear();
  term.write("<span class='t-dim'>terminal ready — Run all or Step to begin bring-up</span>", "t-dim");
  log("Demo reset — press Run all or Step through phases", "info");
}

function renderAll() {
  renderPhases();
  renderRacks();
  renderFabric();
  renderApps();
  renderCabling();
  updateStats();
  $("detail").className = "detail empty";
  $("detail").innerHTML = "<p>Click any device, switch, cable endpoint, or platform app to inspect it.</p>";
}

function bindControls() {
  $("speed").addEventListener("input", (e) => {
    state.speed = parseFloat(e.target.value);
  });

  $("btn-run").addEventListener("click", () => {
    if (state.running) return;
    state.mode = "auto";
    runPipeline();
  });

  $("btn-step").addEventListener("click", () => {
    if (!state.running) {
      state.mode = "step";
      runPipeline();
      return;
    }
    if (state.stepResolve) state.stepResolve();
  });

  $("btn-pause").addEventListener("click", () => {
    if (!state.running) return;
    state.paused = !state.paused;
    $("btn-pause").textContent = state.paused ? "Resume" : "Pause";
    log(state.paused ? "Paused" : "Resumed", "warn");
  });

  $("btn-reset").addEventListener("click", reset);

  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => switchView(t.dataset.view));
  });

  $("term-clear").addEventListener("click", () => term.clear());
}

// boot
term.init();
bindControls();
renderAll();
term.write("<span class='t-dim'>AIDataCenter bootstrap terminal — simulated</span>", "t-dim");
log("AIDataCenter bootstrap demo ready", "ok");
log("Inventory seeded from site.yaml · offline NetBox SoT", "info");
log("Flow: NetBox → seed → switches+overlay → CAPI CP → GPU workers → Flux → Kimi K2 → API", "info");
