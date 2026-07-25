/**
 * Hardware, media, and cost catalog.
 *
 * Every number here is a *planning* figure: nameplate or typical-sustained values good
 * enough to size a room, a feed, and a cable order. They are not a substitute for a
 * vendor's site-prep guide at procurement time.
 *
 * Units are explicit in the key name: `_kw`, `_m`, `_kg`, `_usd`, `_mm`.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  /* ---------------------------------------------------------------- media --
   * `max_m` is the *routed* reach budget, not the straight-line rack gap. The
   * router computes true pathway length (rack rise + tray run + drop + slack)
   * and the media selector picks the cheapest entry that still reaches.
   *
   * `cost_usd` is installed cost for the whole link, both ends included: for
   * optical entries that means the pair of transceivers plus the fiber.
   */
  const MEDIA = {
    "dac-400g": {
      name: "DAC QSFP-DD 400G", kind: "copper", speed_gbps: 400,
      max_m: 3, cost_usd: 260, od_mm: 8.4, weight_kg_per_m: 0.28, trunkable: false,
    },
    "aec-400g": {
      name: "AEC active copper 400G", kind: "copper", speed_gbps: 400,
      max_m: 5, cost_usd: 690, od_mm: 6.1, weight_kg_per_m: 0.16, trunkable: false,
    },
    "aoc-400g": {
      name: "AOC QSFP-DD 400G", kind: "optical", speed_gbps: 400,
      max_m: 30, cost_usd: 1450, od_mm: 3.0, weight_kg_per_m: 0.011, trunkable: false,
    },
    "smf-400g": {
      name: "400G DR4 optics + MPO-12 SMF", kind: "optical", speed_gbps: 400,
      max_m: 500, cost_usd: 2600, od_mm: 3.0, weight_kg_per_m: 0.011, trunkable: true,
    },
    "dac-25g": {
      name: "DAC SFP28 25G", kind: "copper", speed_gbps: 25,
      max_m: 5, cost_usd: 90, od_mm: 5.8, weight_kg_per_m: 0.10, trunkable: false,
    },
    "aoc-100g": {
      name: "AOC QSFP28 100G", kind: "optical", speed_gbps: 100,
      max_m: 30, cost_usd: 420, od_mm: 3.0, weight_kg_per_m: 0.011, trunkable: false,
    },
    "cat6a": {
      name: "Cat6A copper", kind: "copper", speed_gbps: 10,
      max_m: 90, cost_usd: 28, od_mm: 6.5, weight_kg_per_m: 0.05, trunkable: false,
    },
  };

  /** Ordered cheapest-first per speed; the media selector walks this. */
  const MEDIA_LADDER = {
    400: ["dac-400g", "aec-400g", "aoc-400g", "smf-400g"],
    100: ["dac-25g", "aoc-100g"],
    25: ["dac-25g", "aoc-100g"],
    10: ["cat6a"],
    1: ["cat6a"],
  };

  /* --------------------------------------------------------- power media --
   * Power runs are labeled and scheduled like data cables but live on a
   * physically separate pathway tier (see pathways.js `tier: "power"`).
   */
  const POWER_MEDIA = {
    "whip-3ph-60a": { name: "60A 415V 3ph whip (IEC 60309)", amps: 60, volts: 415, phases: 3, cost_usd: 340, od_mm: 21 },
    "whip-3ph-100a": { name: "100A 415V 3ph whip", amps: 100, volts: 415, phases: 3, cost_usd: 520, od_mm: 28 },
    "feeder-400a": { name: "400A 415V feeder", amps: 400, volts: 415, phases: 3, cost_usd: 4200, od_mm: 58 },
    "feeder-800a": { name: "800A 415V feeder", amps: 800, volts: 415, phases: 3, cost_usd: 7600, od_mm: 78 },
    "busway-tap": { name: "Busway tap-off box", amps: 60, volts: 415, phases: 3, cost_usd: 780, od_mm: 21 },
    "cord-c19": { name: "C19 rack cord", amps: 16, volts: 240, phases: 1, cost_usd: 18, od_mm: 9 },
    "cord-c21": { name: "C21 rack cord (high-temp)", amps: 20, volts: 240, phases: 1, cost_usd: 24, od_mm: 10 },
  };

  const COOLANT_MEDIA = {
    "hose-dn32": { name: "DN32 EPDM coolant hose", dn: 32, lpm: 120, cost_usd: 210, od_mm: 46 },
    "hose-dn50": { name: "DN50 coolant hose", dn: 50, lpm: 300, cost_usd: 340, od_mm: 66 },
    "pipe-dn100": { name: "DN100 facility loop pipe", dn: 100, lpm: 1200, cost_usd: 900, od_mm: 114 },
  };

  /* -------------------------------------------------------------- servers --
   * `cooling` lists the modes a SKU can be deployed under. An NVL72 tray has no
   * air-cooled variant, so selecting air cooling makes that layout illegal --
   * that is the constraint that makes the cooling choice load-bearing rather
   * than cosmetic.
   */
  const SERVERS = {
    xe9680: {
      vendor: "Dell", model: "PowerEdge XE9680", ru: 6, kw: 10.2, gpus: 8,
      fabric_nics: 8, nic_speed: 400, psus: 6, psu_kw: 2.8, weight_kg: 115,
      cooling: ["air", "water"], class: "gpu",
    },
    "hgx-b200-8u": {
      vendor: "Generic", model: "HGX B200 8U", ru: 8, kw: 10.4, gpus: 8,
      fabric_nics: 8, nic_speed: 400, psus: 6, psu_kw: 3.0, weight_kg: 120,
      cooling: ["air", "water"], class: "gpu",
    },
    "dgx-b200": {
      vendor: "NVIDIA", model: "DGX B200", ru: 10, kw: 14.3, gpus: 8,
      fabric_nics: 8, nic_speed: 400, psus: 6, psu_kw: 3.3, weight_kg: 130,
      cooling: ["air"], class: "gpu",
    },
    "hgx-b300-dlc": {
      vendor: "Generic", model: "HGX B300 4U direct-liquid", ru: 4, kw: 12.6, gpus: 8,
      fabric_nics: 8, nic_speed: 400, psus: 6, psu_kw: 3.3, weight_kg: 95,
      cooling: ["water"], class: "gpu", liquid_fraction: 0.9,
    },
    "gb200-tray": {
      vendor: "NVIDIA", model: "GB200 NVL72 compute tray", ru: 1, kw: 6.6, gpus: 4,
      fabric_nics: 4, nic_speed: 400, psus: 0, psu_kw: 0, weight_kg: 38,
      cooling: ["water"], class: "gpu", liquid_fraction: 0.95, busbar_powered: true,
    },
    "nvl-switch-tray": {
      vendor: "NVIDIA", model: "NVLink switch tray", ru: 1, kw: 2.0, gpus: 0,
      fabric_nics: 0, nic_speed: 0, psus: 0, psu_kw: 0, weight_kg: 30,
      cooling: ["water"], class: "nvlink", busbar_powered: true,
    },
    "cpu-2u": {
      vendor: "Generic", model: "2U CPU node", ru: 2, kw: 0.9, gpus: 0,
      fabric_nics: 2, nic_speed: 100, psus: 2, psu_kw: 1.6, weight_kg: 28,
      cooling: ["air", "water"], class: "cpu",
    },
    "jbof-2u": {
      vendor: "Generic", model: "2U NVMe JBOF", ru: 2, kw: 1.7, gpus: 0,
      fabric_nics: 2, nic_speed: 200, psus: 2, psu_kw: 2.0, weight_kg: 34,
      cooling: ["air", "water"], class: "storage",
    },
    "mgmt-1u": {
      vendor: "Generic", model: "1U management server", ru: 1, kw: 0.5, gpus: 0,
      fabric_nics: 2, nic_speed: 25, psus: 2, psu_kw: 0.8, weight_kg: 18,
      cooling: ["air", "water"], class: "mgmt",
    },
  };

  /* ------------------------------------------------------------- switches -- */
  const SWITCHES = {
    "7060dx5-32": {
      vendor: "Arista", model: "DCS-7060DX5-32", ports: 32, speed: 400,
      ru: 1, kw: 0.55, weight_kg: 11, tier: "leaf",
    },
    "7060dx5-64s": {
      vendor: "Arista", model: "DCS-7060DX5-64S", ports: 64, speed: 400,
      ru: 2, kw: 1.3, weight_kg: 18, tier: "spine",
    },
    "7800r4-128": {
      vendor: "Arista", model: "DCS-7800R4 (128× 400G)", ports: 128, speed: 400,
      ru: 8, kw: 4.2, weight_kg: 86, tier: "super",
    },
    "7010tx-48": {
      vendor: "Arista", model: "DCS-7010TX-48", ports: 48, speed: 1,
      uplink_ports: 4, uplink_speed: 25, ru: 1, kw: 0.15, weight_kg: 8, tier: "oob",
    },
  };

  /* ---------------------------------------------------------------- power --
   * The chain modeled end to end:
   *   utility entrance → UPS (A/B) → RPP or busway → rack PDU (A/B) → PSU cords
   */
  const UPS = {
    "ups-250": { model: "250 kVA modular UPS", kva: 250, pf: 0.95, w_m: 1.2, d_m: 1.0, efficiency: 0.96, weight_kg: 900 },
    "ups-500": { model: "500 kVA modular UPS", kva: 500, pf: 0.95, w_m: 1.8, d_m: 1.0, efficiency: 0.965, weight_kg: 1500 },
    "ups-1250": { model: "1250 kVA modular UPS", kva: 1250, pf: 0.95, w_m: 3.2, d_m: 1.2, efficiency: 0.97, weight_kg: 3200 },
  };

  const RPP = {
    "rpp-400a": { model: "RPP 400A 415V", amps: 400, volts: 415, phases: 3, poles: 42, w_m: 0.6, d_m: 0.9, weight_kg: 320 },
    "rpp-600a": { model: "RPP 600A 415V", amps: 600, volts: 415, phases: 3, poles: 84, w_m: 0.8, d_m: 0.9, weight_kg: 450 },
  };

  const BUSWAY = {
    "busway-630a": { model: "Overhead busway 630A 415V", amps: 630, volts: 415, phases: 3 },
    "busway-800a": { model: "Overhead busway 800A 415V", amps: 800, volts: 415, phases: 3 },
  };

  const RACK_PDU = {
    "pdu-3ph-32a": { model: "0U 3ph 32A 415/240V", amps: 32, volts: 415, phases: 3, outlets: 36, weight_kg: 9 },
    "pdu-3ph-60a": { model: "0U 3ph 60A 415/240V", amps: 60, volts: 415, phases: 3, outlets: 42, weight_kg: 12 },
    "pdu-3ph-100a": { model: "0U 3ph 100A 415/240V", amps: 100, volts: 415, phases: 3, outlets: 48, weight_kg: 16 },
  };

  /* -------------------------------------------------------------- cooling -- */
  const CRAH = {
    "crah-80": { model: "CRAH 80 kW", kw: 80, w_m: 1.8, d_m: 1.0, airflow_cmh: 24000, weight_kg: 700 },
    "crah-150": { model: "CRAH 150 kW", kw: 150, w_m: 2.4, d_m: 1.1, airflow_cmh: 42000, weight_kg: 1100 },
  };

  const CDU = {
    "cdu-inrow-700": { model: "In-row CDU 700 kW", kw: 700, w_m: 0.75, d_m: 1.2, in_row: true, lpm: 700, weight_kg: 800 },
    "cdu-inrow-1300": { model: "In-row CDU 1300 kW", kw: 1300, w_m: 0.9, d_m: 1.2, in_row: true, lpm: 1200, weight_kg: 1100 },
    "cdu-perimeter-2500": { model: "Perimeter CDU 2500 kW", kw: 2500, w_m: 2.2, d_m: 1.2, in_row: false, lpm: 2400, weight_kg: 2400 },
  };

  const RDHX = {
    "rdhx-60": { model: "Rear-door HX 60 kW", kw: 60, adds_depth_m: 0.20, weight_kg: 140 },
    "rdhx-100": { model: "Rear-door HX 100 kW (fan-assisted)", kw: 100, adds_depth_m: 0.25, weight_kg: 180, fan_kw: 1.2 },
  };

  /* ---------------------------------------------------------- rack frames -- */
  const RACK_TYPES = {
    "600-42u": { name: "600mm × 1070mm 42U", w_m: 0.6, d_m: 1.07, u: 42, weight_kg: 140, max_kw_air: 20 },
    "600-48u": { name: "600mm × 1200mm 48U", w_m: 0.6, d_m: 1.2, u: 48, weight_kg: 165, max_kw_air: 25 },
    "750-48u": { name: "750mm × 1200mm 48U (wide, cable-managed)", w_m: 0.75, d_m: 1.2, u: 48, weight_kg: 190, max_kw_air: 40 },
    "750-52u": { name: "750mm × 1200mm 52U (high)", w_m: 0.75, d_m: 1.2, u: 52, weight_kg: 210, max_kw_air: 40 },
    "nvl72-rack": { name: "NVL72 liquid rack (600mm × 1200mm)", w_m: 0.6, d_m: 1.2, u: 48, weight_kg: 700, max_kw_air: 0 },
  };

  /* ------------------------------------------------------- rack layouts --
   * A layout is a *template* for one rack: which server SKU fills it, how many
   * fit, and what network gear rides along. `cooling` gates legality against
   * the room's selected cooling mode.
   */
  const RACK_LAYOUTS = {
    "gpu-air-xe9680": {
      name: "GPU · XE9680 ×6 (air)", role: "compute", rack_type: "750-48u",
      server: "xe9680", default_servers: 6, max_servers: 6, cooling: ["air"],
    },
    "gpu-air-hgx8u": {
      name: "GPU · HGX B200 8U ×4 (air)", role: "compute", rack_type: "750-48u",
      server: "hgx-b200-8u", default_servers: 4, max_servers: 5, cooling: ["air"],
    },
    "gpu-air-dgx": {
      name: "GPU · DGX B200 ×4 (air)", role: "compute", rack_type: "750-48u",
      server: "dgx-b200", default_servers: 4, max_servers: 4, cooling: ["air"],
    },
    "gpu-dlc-b300": {
      name: "GPU · HGX B300 4U ×8 (direct liquid)", role: "compute", rack_type: "750-52u",
      server: "hgx-b300-dlc", default_servers: 8, max_servers: 10, cooling: ["water"],
    },
    "gpu-nvl72": {
      name: "GPU · GB200 NVL72 (18 trays + 9 NVLink, liquid)", role: "compute", rack_type: "nvl72-rack",
      server: "gb200-tray", default_servers: 18, max_servers: 18, cooling: ["water"],
      companions: [{ sku: "nvl-switch-tray", count: 9, source: "servers" }],
      busbar: true,
    },
    "cpu-general": {
      name: "CPU · 2U general compute ×16", role: "compute", rack_type: "600-48u",
      server: "cpu-2u", default_servers: 16, max_servers: 20, cooling: ["air", "water"],
    },
    "storage-nvme": {
      name: "Storage · 2U NVMe JBOF ×16", role: "storage", rack_type: "600-48u",
      server: "jbof-2u", default_servers: 16, max_servers: 20, cooling: ["air", "water"],
    },
    "mgmt-boot": {
      name: "Mgmt/boot · 1U servers ×12", role: "mgmt", rack_type: "600-48u",
      server: "mgmt-1u", default_servers: 12, max_servers: 24, cooling: ["air", "water"],
    },
    "network-spine": {
      name: "Network · spine / aggregation", role: "network", rack_type: "600-48u",
      server: null, default_servers: 0, max_servers: 0, cooling: ["air", "water"],
      hosts_spines: true,
    },
  };

  /* ----------------------------------------------------- fabric topology --
   * Where the leaf tier physically lives is the whole game for cable cost:
   *   rail-optimized → leaves in a network rack, NIC k of every node on leaf k
   *   tor            → leaf pair inside each compute rack (shortest host cables)
   *   eor            → leaf pair per row, in the row-end network rack
   */
  const FABRIC_ARCHS = {
    "rail-optimized": {
      name: "Rail-optimized (middle-of-row leaves)",
      leaf_placement: "network-rack",
      desc: "NIC k of every GPU node lands on leaf k. Rail identity is a correctness constraint.",
    },
    tor: {
      name: "Top-of-rack (MLAG pair per rack)",
      leaf_placement: "in-rack",
      desc: "Leaf pair in each compute rack; host cables stay inside the rack (DAC).",
    },
    eor: {
      name: "End-of-row (leaf pair per row)",
      leaf_placement: "row-end",
      desc: "One leaf pair serves an entire row from the row-end network rack.",
    },
  };

  /**
   * Cheapest media that spans `length_m` at `speed` Gbps.
   * Returns `null` when nothing in the ladder reaches -- validate.js turns that
   * into a hard error rather than silently emitting an unbuildable link.
   */
  function pickMedia(speed, length_m) {
    const ladder = MEDIA_LADDER[speed] || MEDIA_LADDER[400];
    for (const key of ladder) {
      if (MEDIA[key] && MEDIA[key].max_m >= length_m) return key;
    }
    return null;
  }

  DCP.Catalog = {
    MEDIA, MEDIA_LADDER, POWER_MEDIA, COOLANT_MEDIA,
    SERVERS, SWITCHES,
    UPS, RPP, BUSWAY, RACK_PDU,
    CRAH, CDU, RDHX,
    RACK_TYPES, RACK_LAYOUTS, FABRIC_ARCHS,
    pickMedia,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
