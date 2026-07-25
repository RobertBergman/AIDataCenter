// GENERATED from planner\SPEC.md — do not edit. Regenerate: python3 docs/md2pdf.py
#import "../docs/template.typ": *
#show: doc.with(title: "AI Datacenter Room Planner — Software Specification", kicker: "AIDATACENTER — PLANNER SPECIFICATION", rev: "0.1 · 2026-07-25")

#strong[Status:] Draft #strong[Component:] `planner/` #strong[Applies
to:] planner v0.1 #strong[Parent specification:]
#link("../SPEC.pdf")[SPEC.md] (the 64× B200 facility this tool
generalises) #strong[Audience:] datacenter architects, network
engineers, facility engineers, and the developers maintaining this
component

#horizontalrule

= Purpose and Scope
<purpose-and-scope>
== Purpose
<purpose>
The planner is a #strong[design-time] tool. It converts a set of
facility decisions --- room size, cooling medium, rack population,
switching architecture, power topology --- into a
#strong[machine-readable rack and cable labeling source of truth] that
can be used to order material, print labels, and drive a build.

== Relationship to sibling components
<relationship-to-sibling-components>
#figure(
  align(center)[#table(
    columns: (32.14%, 67.86%),
    align: (auto,auto,),
    table.header([Component], [Question it answers],),
    table.hline(),
    [#link("../SPEC.pdf")[SPEC.md]], [What is the 64× B200 cluster? (a
    fixed, hand-authored design)],
    [`planner/`], [#strong[What should we build, and what does it cost
    in cable and kW?]],
    [#link("../demo/")[`demo/`]], [How does a built cluster come up?],
    [#link("../bootstrap/netbox/")[`bootstrap/netbox/`]], [What is the
    authoritative record once it is built?],
  )]
  , kind: table
  )

The planner is upstream of NetBox: it produces the design intent that a
seed import consumes. It does #strong[not] talk to hardware and has no
runtime role.

== In scope
<in-scope>
Room geometry, aisle layout and rack positioning; cooling mode selection
and plant sizing; power chain from utility entrance to PSU cord; fabric
topology and port budgeting; pathway routing and cable length
derivation; media selection and costing; label generation; design
validation; YAML export.

== Out of scope
<out-of-scope>
Explicitly #strong[not] provided, and not to be inferred from the
output:

#figure(
  align(center)[#table(
    columns: (47.06%, 52.94%),
    align: (auto,auto,),
    table.header([Excluded], [Rationale],),
    table.hline(),
    [CFD / airflow simulation], [Cooling is modeled as a kW and ΔT
    budget only],
    [Hydraulic pressure, pump curves], [Flow is derived from
    `Q = ṁ·cp·ΔT`, nothing more],
    [Short-circuit, coordination, arc-flash study], [Power sizing is
    capacity and derate only],
    [Code compliance (NEC/IEC/NFPA), seismic, fire suppression], [A
    licensed engineer signs the drawing],
    [Structural floor analysis], [Floor loading is a flat kg/m²
    comparison],
    [Procurement pricing], [Catalog costs are planning figures, not
    quotes],
    [Runtime/telemetry integration], [The tool is design-time only],
  )]
  , kind: table
  )

#horizontalrule

= Definitions
<definitions>
#figure(
  align(center)[#table(
    columns: (36.36%, 63.64%),
    align: (auto,auto,),
    table.header([Term], [Meaning],),
    table.hline(),
    [#strong[Position]], [A discrete legal rack location on the floor
    grid (row + slot)],
    [#strong[Layout]], [A template describing what fills one rack
    (server SKU, count, companions)],
    [#strong[Rail]], [In a rail-optimized fabric, NIC index #emph[k] on
    every GPU node],
    [#strong[Routed length]], [Rack rise + tray run + drop + slack ---
    not straight-line distance],
    [#strong[Pathway tier]], [An independent tray network: `data`,
    `power`, or `fluid`],
    [#strong[Trunk]], [A shared pathway run carrying many cables,
    derived by Steiner tree],
    [#strong[Feed]], [One side (A or B) of the dual power distribution],
    [#strong[Firm capacity]], [Capacity remaining after the loss of one
    redundant unit],
    [#strong[Cut]], [Total demand (GB/s) crossing a rack boundary],
    [#strong[SoT]], [Source of truth --- the exported YAML document],
  )]
  , kind: table
  )

#horizontalrule

= Stakeholders and Primary Use Cases
<stakeholders-and-primary-use-cases>
#figure(
  align(center)[#table(
    columns: (13.33%, 33.33%, 53.33%),
    align: (auto,auto,auto,),
    table.header([ID], [Actor], [Use case],),
    table.hline(),
    [UC-1], [Datacenter architect], [Size a hall for a target GPU count
    and see whether it fits],
    [UC-2], [Facility engineer], [Compare air vs water cooling for the
    same fleet],
    [UC-3], [Electrical engineer], [Size entrances, UPS, and
    distribution; confirm A/B survival],
    [UC-4], [Network engineer], [Compare rail-optimized vs ToR vs EoR on
    cable cost and reach],
    [UC-5], [Install contractor], [Receive a labeled, length-bearing
    cable schedule],
    [UC-6], [Platform engineer], [Feed design intent into NetBox / CI as
    a versioned artifact],
  )]
  , kind: table
  )

#horizontalrule

= Requirements
<requirements>
Verification method: #strong[T] = automated test/tool, #strong[D] =
demonstration in UI, #strong[I] = inspection of output, #strong[A] =
analysis.

== Functional requirements
<functional-requirements>
#figure(
  align(center)[#table(
    columns: (4.88%, 26.83%, 19.51%, 14.63%, 34.15%),
    align: (auto,auto,auto,auto,auto,),
    table.header([ID], [Requirement], [Priority], [Verify], [Implementation],),
    table.hline(),
    [FR-1], [The room's width and depth SHALL be user-variable, and the
    legal rack grid SHALL be re-derived from
    them], [Must], [D,T], [`js/floor.js`],
    [FR-2], [Cold and hot aisle widths, perimeter keep-clear, and clear
    height SHALL be user-variable], [Must], [D], [`js/floor.js`],
    [FR-3], [The system SHALL report the number of available rack
    positions and reject a design with more racks than
    positions], [Must], [T], [`room.capacity`],
    [FR-4], [The user SHALL select cooling as #strong[air] or
    #strong[water]\; water SHALL offer direct-to-chip (DLC) and
    rear-door (RDHx) variants], [Must], [D], [`js/cooling.js`],
    [FR-5], [The cooling selection SHALL impose a per-rack kW ceiling
    and SHALL flag every rack exceeding
    it], [Must], [T], [`cooling.rack_cap`],
    [FR-6], [The cooling selection SHALL gate which rack layouts are
    legal; illegal combinations SHALL be reported, never silently
    substituted], [Must], [T], [`cooling.layout`],
    [FR-7], [Cooling plant (CRAH / CDU / RDHx / manifold) SHALL be
    sized, placed with coordinates, and included in the
    export], [Must], [I], [`js/cooling.js`],
    [FR-8], [In-row CDUs SHALL consume real floor positions; failure to
    place one SHALL be reported], [Must], [T], [`js/cooling.js`],
    [FR-9], [The user SHALL add and remove racks individually, and set
    the server count per rack], [Must], [D], [`js/design.js`,
    `js/app.js`],
    [FR-10], [Rack layout SHALL be selectable per rack from a catalog of
    server SKUs], [Must], [D], [`RACK_LAYOUTS`],
    [FR-11], [Rack elevations SHALL be generated U-by-U with no overlap
    and within frame height], [Must], [T], [`rack.overlap`, `rack.ru`],
    [FR-12], [Switching architecture SHALL be selectable:
    rail-optimized, top-of-rack,
    end-of-row], [Must], [D,T], [`js/fabric.js`],
    [FR-13], [Oversubscription and tier count (2 or 3) SHALL be
    selectable, and the achieved ratio reported when it cannot be met
    exactly], [Must], [T], [`fabric.oversubscription`],
    [FR-14], [Switch port budgets SHALL be enforced; a design exceeding
    them SHALL error rather than truncate the cable
    list], [Must], [T], [`fabric.ports`],
    [FR-15], [In a rail-optimized fabric, NIC #emph[k] SHALL land on a
    rail-#emph[k] leaf for every host], [Must], [T], [`fabric.rail`
    (Python)],
    [FR-16], [Utility entrances SHALL be user-variable in count and
    capacity, and placed on the floor
    plan], [Must], [D,I], [`js/power.js`],
    [FR-17], [UPS model and redundancy (N, N+1, 2N) SHALL be selectable;
    modules SHALL be sized and placed], [Must], [D,I], [`js/power.js`],
    [FR-18], [Distribution SHALL be selectable between RPP panels and
    overhead busway, sized, and placed], [Must], [D,I], [`js/power.js`],
    [FR-19], [Each rack SHALL receive A and B rack PDUs sized so that
    #strong[either side alone] carries the full rack load at the derated
    rating], [Must], [T], [`power.rack_pdu`],
    [FR-20], [Every power connection from entrance to rack PDU SHALL be
    emitted as a labeled cable; per-PSU cords SHALL be
    optional], [Must], [I], [`js/power.js`],
    [FR-21], [A and B power runs SHALL be routed to minimise shared
    pathway segments; residual sharing SHALL be
    reported], [Should], [T], [`power.diversity`],
    [FR-22], [Cable lengths SHALL be #strong[routed] lengths derived
    from room geometry, not straight-line
    distances], [Must], [A,I], [`js/pathways.js`],
    [FR-23], [Cable medium SHALL be selected as the cheapest option
    whose reach covers the routed length; unreachable links SHALL
    error], [Must], [T], [`cable.reach`],
    [FR-24], [Every cable SHALL carry a unique label; duplicates SHALL
    error], [Must], [T], [`cable.duplicate_label`],
    [FR-25], [No port SHALL be cabled more than
    once], [Must], [T], [`fabric.port_conflict`],
    [FR-26], [The export SHALL be a single YAML document containing
    room, cooling, power, fabric, racks with elevations, devices,
    cables, media, bundles, label conventions, optimization report,
    totals, and validation], [Must], [I], [`js/yaml.js`],
    [FR-27], [Rack placement SHALL be solver-assigned, and the user
    SHALL be able to pin any rack by dragging
    it], [Must], [D], [`js/placement.js`, `js/render.js`],
    [FR-28], [The tool SHALL report what each solver achieved against a
    stated baseline], [Must], [I], [`optimization`],
    [FR-29], [The same pipeline SHALL be runnable headlessly and produce
    identical output to the UI], [Must], [T], [`tools/plan.js`],
    [FR-30], [An independent validator SHALL re-derive the checks from
    the exported YAML alone], [Must], [T], [`tools/validate_design.py`],
  )]
  , kind: table
  )

== Non-functional requirements
<non-functional-requirements>
#figure(
  align(center)[#table(
    columns: (8%, 44%, 24%, 24%),
    align: (auto,auto,auto,auto,),
    table.header([ID], [Requirement], [Target], [Verify],),
    table.hline(),
    [NFR-1], [#strong[Determinism] --- identical design produces
    byte-identical YAML], [Always], [T (`cmp` of two runs)],
    [NFR-2], [#strong[Interactivity] --- a re-solve at reference scale
    completes fast enough to feel live], [≤ 250 ms at 12 racks], [T
    (measured 60 ms)],
    [NFR-3], [#strong[Scale] --- usable at hall scale], [≤ 3 s at 48
    racks], [T (measured 1.2 s)],
    [NFR-4], [#strong[Zero build step] --- no bundler, transpiler, or
    package install to run the UI], [Absolute], [D],
    [NFR-5], [#strong[Zero runtime dependencies] --- browser only;
    headless needs Node ≥ 18, validator needs Python ≥ 3.9 +
    PyYAML], [Absolute], [I],
    [NFR-6], [#strong[Offline] --- the UI SHALL function from `file://`
    with no network access], [Absolute], [D],
    [NFR-7], [#strong[Portability] --- Linux, macOS, Windows], [All
    three], [T (developed on Windows)],
    [NFR-8], [#strong[Auditability] --- every emitted number traceable
    to a catalog figure or a stated formula], [Absolute], [I],
    [NFR-9], [#strong[Honest failure] --- an infeasible design SHALL be
    built and reported, never silently corrected], [Absolute], [T],
    [NFR-10], [#strong[Independence of verification] --- the two
    validators SHALL NOT share code], [Absolute], [I],
  )]
  , kind: table
  )

== Constraints
<constraints>
#figure(
  align(center)[#table(
    columns: (16.67%, 83.33%),
    align: (auto,auto,),
    table.header([ID], [Constraint],),
    table.hline(),
    [C-1], [Implementation is ES2020 JavaScript with no modules (plain
    `<script>` tags) so `file://` works],
    [C-2], [Modules attach to a single `DCP` global namespace; no
    bundler-specific syntax],
    [C-3], [All randomness derives from `optimizer.seed`\; no solver may
    call `Math.random()`],
    [C-4], [Catalog values are planning figures; changing them is a
    catalog edit, not a code change],
    [C-5], [The YAML emitter is hand-rolled --- no dependency is
    permitted in the browser path],
    [C-6], [Row pitch is uniform per design (the widest frame in use),
    matching how a real row is framed],
  )]
  , kind: table
  )

== Assumptions
<assumptions>
#figure(
  align(center)[#table(
    columns: (16.67%, 83.33%),
    align: (auto,auto,),
    table.header([ID], [Assumption],),
    table.hline(),
    [A-1], [Rows are laid out back-to-back around a hot aisle,
    front-to-front on cold aisles],
    [A-2], [Overhead pathway; data, power, and coolant occupy separate
    tiers],
    [A-3], [Cross-aisle tray ladders exist at row ends and every 6 slot
    columns],
    [A-4], [IT load is on UPS; mechanical plant is on the
    utility/generator, not the UPS],
    [A-5], [Dual-corded IT: A and B share load normally, each sized for
    100%],
    [A-6], [Power factor ≈ 1.0 for modern IT PSUs],
  )]
  , kind: table
  )

#horizontalrule

= Architecture
<architecture>
== Module decomposition
<module-decomposition>
#figure(
  align(center)[#table(
    columns: (20%, 46.67%, 33.33%),
    align: (auto,auto,auto,),
    table.header([Module], [Responsibility], [Depends on],),
    table.hline(),
    [`util.js`], [Seeded PRNG, min-heap, rounding, grouping], [---],
    [`catalog.js`], [Hardware, media, cost, layout, architecture
    tables], [---],
    [`design.js`], [Design state, defaults, rack add/remove,
    legality], [catalog, util],
    [`floor.js`], [Room geometry → row grid → legal
    positions], [catalog, util],
    [`graph.js`], [Logical topology and traffic matrix], [util],
    [`partition.js`], [Multilevel KL/FM partitioning], [util],
    [`placement.js`], [QAP placement (SA / GA)], [util],
    [`pathways.js`], [Tray graph, A\*, Yen, Steiner, tray fill], [util],
    [`fabric.js`], [Switch sizing, port budgets, logical
    links], [catalog, util],
    [`cooling.js`], [Cooling plant sizing, siting, coolant
    runs], [catalog, util],
    [`power.js`], [Power chain sizing, siting, power runs], [catalog,
    util],
    [`validate.js`], [In-process constraint checking], [catalog, util,
    design],
    [`build.js`], [#strong[Pipeline orchestration]], [all of the above],
    [`yaml.js`], [Document assembly and YAML emission], [catalog, util],
    [`render.js`], [SVG floor plan, elevations, tables,
    reports], [catalog, util, floor],
    [`app.js`], [Control binding, state, events], [all],
  )]
  , kind: table
  )

#strong[Dependency rule:] solver modules (`graph`, `partition`,
`placement`, `pathways`) SHALL NOT depend on `catalog`, `design`, or any
rendering module. They operate on plain numeric structures and are
independently testable.

`build.js` is a pure function of `(design) → model`. No stage mutates an
earlier stage's output.

== Pipeline
<pipeline>
```
design
  │
  ├─▶ floor.plan .................. room → rows → legal positions
  ├─▶ graph.buildFleet ............ racks → logical servers
  ├─▶ graph.trafficMatrix ......... TP/PP/DP → demand edges
  ├─▶ partition.partition ......... servers → racks           (minimise cut)
  ├─▶ fabric.plan ................. switches, ports, links
  ├─▶ elevate ..................... U assignment, kW, weight
  ├─▶ placement.place ............. racks → positions          (minimise Σ F·D)
  ├─▶ cooling.plan ................ plant sizing + siting
  ├─▶ power.plan .................. entrance→UPS→dist→PDU
  ├─▶ pathways .................... Steiner trunks, then A* for the rest
  ├─▶ media selection + costing
  ├─▶ validate.check
  └─▶ yaml.toDocument
```

#strong[Ordering constraints (normative):]

- Partitioning MUST precede fabric construction (server homing sets leaf
  demand).
- Fabric construction MUST precede placement (the cable-count matrix is
  an input to the placement objective).
- Elevation MUST precede OOB cabling (port demand depends on the device
  list).
- Placement MUST precede cooling and power siting (both need
  coordinates).
- Trunk (Steiner) routing MUST precede point-to-point routing, so trunks
  receive uncongested pathway.
- A-feed routing MUST precede B-feed routing (diversity is computed
  against A).

== Execution environments
<execution-environments>
#figure(
  align(center)[#table(
    columns: (52.38%, 23.81%, 23.81%),
    align: (auto,auto,auto,),
    table.header([Environment], [Entry], [Notes],),
    table.hline(),
    [Browser], [`index.html`], [Plain scripts, `file://` capable],
    [Node ≥ 18], [`tools/plan.js`], [Requires the same `js/` modules; no
    shims],
    [Python ≥ 3.9], [`tools/validate_design.py`], [Reads YAML only;
    shares no code with the JS],
  )]
  , kind: table
  )

#horizontalrule

= Data Design
<data-design>
== Design input (`design`)
<design-input-design>
Persisted as JSON; accepted by `tools/plan.js` as its input file.

#figure(
  align(center)[#table(
    columns: (55.56%, 44.44%),
    align: (auto,auto,),
    table.header([Group], [Keys],),
    table.hline(),
    [`meta`], [`name`, `room`, `tenant`, `description`],
    [`room`], [`width_m`, `depth_m`, `clear_height_m`, `tile_m`,
    `perimeter_m`, `cold_aisle_m`, `hot_aisle_m`, `raised_floor`,
    `floor_capacity_kg_m2`, `tray_height_m`, `power_tray_height_m`,
    `data_tray_runs`, `power_tray_runs`, `fluid_tray_runs`],
    [`cooling`], [`mode`, `water_type`, `crah_model`, `cdu_model`,
    `rdhx_model`, `redundancy`, `supply_c`, `return_c`, `containment`,
    `racks_per_cdu`, `air_kw_per_rack_cap`],
    [`power`], [`volts`, `phases`, `entrances`, `entrance_kw`,
    `entrance_side`, `ups_model`, `ups_redundancy`, `distribution`,
    `rpp_model`, `busway_model`, `rack_pdu_model`, `breaker_derate`,
    `emit_device_cords`, `pue_target`],
    [`fabric`], [`arch`, `oversubscription`, `tiers`, `leaf_model`,
    `spine_model`, `super_model`, `oob_model`, `pod_racks`, `emit_oob`],
    [`workload`], [`tp_size`, `pp_size`, `dp_replicas`, `collective`,
    `base_affinity`],
    [`optimizer`], [`seed`, `partition`, `placement`, `anneal_iters`,
    `anneal_start_t`, `anneal_end_t`, `objective_traffic_weight`,
    `routing`, `congestion_weight`, `bend_penalty_m`, `bundle`,
    `slack_m`],
    [`racks[]`], [`id`, `name`, `layout`, `rack_type`, `servers`,
    `pinned`],
  )]
  , kind: table
  )

== Output document (normative)
<output-document-normative>
`schema_version: 1`. Top-level keys, in emission order:

#figure(
  align(center)[#table(
    columns: (20%, 26.67%, 53.33%),
    align: (auto,auto,auto,),
    table.header([Key], [Type], [Contents],),
    table.hline(),
    [`schema_version`], [int], [Document version; consumers MUST reject
    unknown majors],
    [`generator`], [map], [Tool, pipeline summary, seed, determinism
    flag],
    [`site`], [map], [Name, room, tenant, description],
    [`room`], [map], [Dimensions, aisles, row grid, positions, floor
    rating, pathway tiers],
    [`cooling`], [map], [Mode, ceiling, capacity, ΔT, flow, `units[]`
    with coordinates],
    [`power`], [map], [`entrances[]`, `ups`, `distribution`,
    `rack_pdus[]`],
    [`fabric`], [map], [Architecture, port split, oversubscription
    requested vs achieved, counts],
    [`racks[]`], [list], [Frame, position, totals, `elevation[]` (U, RU,
    name, model, role, kW)],
    [`devices[]`], [list], [Flat index: name, role, model, rack, U, kW,
    ports, rail, power source],
    [`cables[]`], [list], [#strong[Normative build artifact] --- see
    6.3],
    [`media`], [map], [Reach, OD, and cost of each medium used, so the
    file re-checks itself],
    [`bundles[]`], [list], [Trunk id, cable count, tray segments, trunk
    length],
    [`labels.conventions`], [map], [Pattern → meaning],
    [`optimization`], [map], [Per-solver achieved vs baseline],
    [`totals`], [map], [Rollups by class and by medium, loads,
    densities],
    [`validation`], [map], [`ok`, counts, and every finding],
  )]
  , kind: table
  )

Cable record:

```yaml
- label: R0-worker001        # unique across the document
  class: fabric              # fabric | oob | mgmt | power | coolant
  media: aoc-400g            # key into `media`
  length_m: 24.7             # routed, includes slack
  speed_gbps: 400
  feed: A                    # power only
  rail: 0                    # fabric only
  bundle: T-spine1           # trunk group, if any
  bends: 3
  a: { device: worker001, port: rail0, rack: GPU-01 }
  b: { device: leaf-rail0, port: Ethernet1, rack: NET-01 }
  status: planned
```

#strong[Invariants (normative):]

+ `label` is unique across `cables[]`.
+ `(device, port)` appears at most once across all cable endpoints.
+ Every endpoint `device` resolves to `devices[]`, a `rack_pdus[]`
  entry, a cooling/power plant unit, or the reserved name
  `facility-loop`.
+ `length_m ≤ media[media].max_m` where a reach limit is defined.
+ `sum(cables[].length_m) == totals.cable_length_m` (±0.5 m).
+ `len(cables) == totals.cables`.
+ `sum(racks[].elevation)` device count `== len(devices)`.
+ `sum(racks[].totals.kw) == totals.it_load_kw` (±0.5 kW).

== Label grammar (normative)
<label-grammar-normative>
```
fabric-host   := "R" rail "-" server            ; rail-optimized
               | "H" nic  "-" server            ; ToR / EoR
leaf-spine    := "L" leaf-tag "S" spine "-U" n
spine-super   := "S" spine "X" super "-U" n
peer          := "PEER-" switch "-" n
oob           := "OOB-" device                  ; BMC
mgmt          := "MGMT-" device                 ; server mgmt0
switch-mgmt   := "MA1-" device                  ; Management1 / ZTP
oob-uplink    := "OOBU-" switch "-" n
power-entry   := "PE-" feed "-" ups
power-feeder  := "PF-" feed "-" unit
power-whip    := "PW-" feed n "-" rack
power-tap     := "PT-" feed n "-" rack          ; busway
power-cord    := "PC-" feed "-" device "-P" n
coolant-sec   := "CW-" ("S"|"R") "-" rack
coolant-pri   := "CF-" ("S"|"R") "-" unit

leaf-tag      := rail                           ; one leaf per rail
               | rail "g" group                 ; rail split across leaves
               | rack "t" n                     ; ToR
               | "r" row "n" n                  ; EoR
               | "u" n                          ; utility leaf
```

Labels extend the family already used in
#link("../docs/cabling.pdf")[`docs/cabling.md`]\; the
single-leaf-per-rail case is byte-compatible with it.

#horizontalrule

= Algorithm Specification
<algorithm-specification>
All solvers are seeded from `optimizer.seed`. All are heuristic; each
reports its achieved objective against a stated baseline (NFR-8).

== Traffic matrix --- `graph.js`
<traffic-matrix-graph.js>
#strong[Input:] workload plan, fleet. #strong[Output:] sparse undirected
edges (GB/s).

#figure(
  align(center)[#table(
    columns: (34.48%, 20.69%, 44.83%),
    align: (auto,right,auto,),
    table.header([Edge class], [Weight], [Justification],),
    table.hline(),
    [TP peers (same tensor-parallel group)], [400], [All-to-all every
    layer],
    [PP stage boundary], [40], [Activations, point to point],
    [DP replica ring], [120], [Gradient / KV all-reduce],
    [Background ring], [`base_affinity × 400`], [Storage, checkpoint,
    management],
  )]
  , kind: table
  )

A job consumes `TP × PP × DP` GPUs; a larger fleet runs
`floor(ranks / servers_per_job)` instances. Background is a ring, not a
clique, to keep the edge set O(n).

== Partitioning --- `partition.js`
<partitioning-partition.js>
#strong[Objective:] minimise edge cut subject to per-rack slot capacity.
#strong[Method:] multilevel --- heavy-edge matching coarsening →
capacity-aware greedy graph growing → FM refinement with best-prefix
rollback at each uncoarsening level. Because racks are typically filled
exactly, refinement also performs KL-style swaps with gain
`D_v(t) + D_u(p) − 2·c(v,u)`. #strong[Baseline:] sequential round-robin
fill. #strong[Complexity:] O(passes × V × B) per level, B = boundary
size. #strong[Note:] when a TP group fits inside one server the cut is
already minimal and the reported improvement is legitimately 0%.

== Placement --- `placement.js`
<placement-placement.js>
#strong[Objective (QAP):]

```
minimize  Σ_{i,k} Σ_{j,l}  F_ik · D_jl · X_ij · X_kl
```

`F` is the normalised weighted sum of the #strong[traffic] matrix and
the #strong[cable-count] matrix, mixed by `objective_traffic_weight`.
The cable term is included because `Σ F_cable · D` is total cable
length, making the same solver a cable-length minimiser.

`D` is Manhattan with a 1.35× penalty on cross-row travel.

#strong[Method:] greedy constructive seed (busiest rack to the most
central position, then highest-affinity-to-placed) → simulated annealing
over swaps and relocations, geometric cooling from `anneal_start_t` to
`anneal_end_t`, temperature normalised against the objective's own
scale. Optional order-crossover GA with tournament selection and
elitism, always followed by an anneal polish. Pinned racks are frozen
and applied last. #strong[Delta evaluation:] O(n) per candidate move.
#strong[Baseline:] sequential assignment.

== Pathway routing --- `pathways.js`
<pathway-routing-pathways.js>
#strong[Graph:] per tier --- a node per (aisle, slot column),
cross-aisle rungs at row ends and every 6 columns, plus a drop per
rack/equipment attached to its two nearest aisles. Drop length includes
the rise from frame top to tray height.

#strong[Edge cost:]

```
w = length · (1 + congestion_weight · fill) + bend_penalty  [if axis changes]
```

#strong[Search:] A\* over `(node, direction)` states so bends are
chargeable; heuristic is Manhattan distance (admissible; scaled when
trunk-discount edges are in play).

#strong[Capacity:] each tier has a tray cross-section
(`w × h × fill_factor × tray_runs`); each routed cable reserves
`π/4·OD²`. Fill is committed immediately, making routing order-dependent
as in a real install.

#strong[A/B diversity:] the A feed routes first; Yen's K-shortest (K=4)
generates candidates for B, scored `shared_segments × 1000 + length`.
Residual sharing is reported, not hidden.

#strong[Trunking:] per spine, a Steiner tree over the tray graph via the
shortest-path heuristic --- grow from the root, repeatedly splice in the
nearest unconnected terminal via multi-source Dijkstra, with existing
tree segments priced at 5% so reuse dominates.

== Port budgeting --- `fabric.js`
<port-budgeting-fabric.js>
Leaf split: the largest even downlink count `d` with
`d + ceil(d/os) ≤ P`. Spine count: the smallest
`s ≥ ceil(total_uplinks / spine_downlink_ports)` that divides
`uplinks_per_leaf` evenly, #strong[capped at `uplinks_per_leaf`] --- a
leaf cannot stripe across more spines than it has uplink ports. When the
cap binds, the spine port overflow is reported so the user adds a tier,
adds pods, or fits a larger spine.

In a 3-tier fabric, spines reserve 25% of their ports for super-spine
uplinks before any leaf is attached.

OOB switches per rack are sized from actual port demand
(`2 × servers + switches`, plus uplink terminations in the mgmt rack),
so access ports never run into the uplink cages.

== Media selection
<media-selection>
The cheapest medium whose reach ≥ routed length, per speed ladder. No
reach ⇒ `cable.reach` error. Intra-rack cables use
`|ΔU| × 44.45 mm + dressing` and take no additional slack.

#horizontalrule

= Interface Specification
<interface-specification>
== Command line --- `tools/plan.js`
<command-line-toolsplan.js>
```
node planner/tools/plan.js [design.json] [options]

  -o, --output PATH   write YAML to PATH
      --set KEY=VALUE dotted design path override (repeatable)
      --report        human-readable summary
      --json          machine-readable summary
  -h, --help
```

`--report` and `--json` suppress YAML on stdout so machine output stays
clean. Unknown `--set` paths are a hard error.

#figure(
  align(center)[#table(
    columns: 2,
    align: (right,auto,),
    table.header([Exit code], [Meaning],),
    table.hline(),
    [0], [Built, validation found no errors],
    [1], [Built, validation found ≥ 1 error],
    [\(throw)], [Malformed input or unknown design key],
  )]
  , kind: table
  )

== Validator --- `tools/validate_design.py`
<validator-toolsvalidate_design.py>
```
python planner/tools/validate_design.py PATH [--quiet]
```

#figure(
  align(center)[#table(
    columns: 2,
    align: (right,auto,),
    table.header([Exit code], [Meaning],),
    table.hline(),
    [0], [No findings],
    [1], [≥ 1 finding],
    [2], [File unreadable or not a mapping],
  )]
  , kind: table
  )

It additionally emits `validation.disagreement` if the document's own
`ok` flag contradicts its independent result.

== User interface
<user-interface>
Three-column layout: controls (left), views (centre), report (right).

#figure(
  align(center)[#table(
    columns: (33.33%, 66.67%),
    align: (auto,auto,),
    table.header([View], [Contents],),
    table.hline(),
    [Floor plan], [Scale SVG in metre space; overlays for racks, data
    tray fill, power tray fill, kW density; drag to pin, click to
    inspect],
    [Elevations], [Per-rack U map with device names and kW, plus A/B PDU
    chips],
    [Cable schedule], [Filterable, searchable table of every cable],
    [YAML], [Live preview, copy, download],
  )]
  , kind: table
  )

The floor plan's SVG `viewBox` #strong[is] the room in metres, so no
pixel-to-metre conversion exists anywhere and dragging maps directly
back to coordinates.

#horizontalrule

= Validation Rule Catalog (normative)
<validation-rule-catalog-normative>
`E` = error (not buildable as drawn), `W` = warning, `I` =
informational. "Both" = independently implemented in the JS and the
Python checker.

#figure(
  align(center)[#table(
    columns: (15.38%, 11.54%, 34.62%, 38.46%),
    align: (auto,auto,auto,auto,),
    table.header([Code], [Sev], [Condition], [Checked by],),
    table.hline(),
    [`schema.missing`], [E], [Required top-level key absent], [Python],
    [`schema.version`], [W], [Unexpected `schema_version`], [Python],
    [`room.capacity`], [E], [Racks exceed available positions], [JS],
    [`room.rows`], [E], [No complete row fits the depth], [JS],
    [`room.height`], [E], [Clear height cannot carry the power
    tray], [JS],
    [`room.cold_aisle`], [W], [Cold aisle \< 1.2 m], [JS],
    [`room.hot_aisle`], [W], [Hot aisle \< 0.9 m], [JS],
    [`room.floor_load`], [E/W], [Rack kg/m² over (E) or within 15% of
    (W) rating], [JS],
    [`room.collision`], [E], [Two racks share a row/slot], [Python],
    [`rack.ru`], [E], [Equipment exceeds frame height], [Both],
    [`rack.overlap`], [E], [Two devices occupy the same U], [Both],
    [`rack.bounds`], [E], [Device spans outside the frame], [Python],
    [`rack.totals`], [E], [Stated totals disagree with the
    elevation], [Python],
    [`rack.duplicate`], [E], [Duplicate rack name], [Python],
    [`cooling.rack_cap`], [E], [Rack kW over the mode's per-rack
    ceiling], [Both],
    [`cooling.layout`], [E], [Layout has no variant for the selected
    mode], [JS],
    [`cooling.capacity`], [E], [Plant capacity below IT load], [Both],
    [`cooling.headroom`], [W], [\< 10% cooling headroom], [JS],
    [`cooling.loop`], [E], [Liquid rack without exactly 2 coolant
    runs], [Python],
    [`cooling.delta_t`], [E], [Non-physical ΔT], [Python],
    [`cooling.residual_air`], [I], [DLC still leaves load to the air
    path], [JS],
    [`power.entrance`], [E], [A service cannot carry the hall
    alone], [Both],
    [`power.ups`], [E], [UPS firm capacity below IT load], [Both],
    [`power.rpp` / `power.distribution`], [E], [Distribution unit over
    its derated rating], [Both],
    [`power.busway`], [E], [Busway run over capacity], [JS],
    [`power.poles`], [E], [Breaker poles exhausted], [Both],
    [`power.rack_pdu`], [E], [One side cannot carry the rack alone, or a
    feed is missing], [Both],
    [`power.redundancy`], [W], [Single feed --- no A/B
    diversity], [Both],
    [`power.diversity`], [W], [B runs share tray segments with A], [JS],
    [`power.totals`], [E], [Rack loads disagree with stated IT
    load], [Python],
    [`fabric.ports`], [E], [Cables exceed a switch's front
    panel], [Both],
    [`fabric.port_conflict` / `cable.port_conflict`], [E], [A port is
    cabled more than once], [Both],
    [`fabric.rail`], [E], [NIC #emph[k] cabled to a non-rail-#emph[k]
    leaf], [Python],
    [`fabric.oversubscription`], [I], [Achieved ratio differs from
    requested], [JS],
    [`cable.unroutable`], [E], [No pathway between endpoints], [JS],
    [`cable.reach`], [E], [Length exceeds the medium's reach], [Both],
    [`cable.duplicate_label`], [E], [Label reused], [Both],
    [`cable.endpoint`], [E], [Endpoint resolves to nothing], [Python],
    [`cable.media`], [W], [Medium absent from the media
    table], [Python],
    [`cable.length`], [W], [Zero-length cable], [Python],
    [`tray.fill`], [E/W], [Tray over 100% (E) or over 80% (W)], [JS],
    [`totals.*`], [E], [Rollups disagree with the listed
    records], [Python],
    [`workload.tp_split`], [W], [TP peers split across racks], [JS],
    [`validation.disagreement`], [E], [Document verdict contradicts the
    checker], [Python],
  )]
  , kind: table
  )

#horizontalrule

= Verification and Test Strategy
<verification-and-test-strategy>
== Levels
<levels>
#figure(
  align(center)[#table(
    columns: (26.32%, 26.32%, 47.37%),
    align: (auto,auto,auto,),
    table.header([Level], [Scope], [Mechanism],),
    table.hline(),
    [Pipeline], [`design → model` across the mode
    matrix], [`tools/plan.js --json`, assert error counts],
    [Contract], [Exported YAML against §6.2
    invariants], [`tools/validate_design.py`],
    [Cross-check], [JS verdict vs Python verdict], [Disagreement is
    itself an error],
    [Determinism], [Two runs, same design], [Byte comparison],
    [Geometry], [Racks in bounds, finite, no shared positions], [Node
    assertion script],
    [UI], [Render entry points, element/CSS/script wiring], [DOM-shim
    smoke script],
    [Visual], [Floor plan, elevations, schedule, YAML, mode toggles,
    drag-to-pin], [Browser demonstration],
  )]
  , kind: table
  )

== Mode matrix (each must build and agree)
<mode-matrix-each-must-build-and-agree>
`cooling.mode ∈ {air, water}` × `cooling.water_type ∈ {dlc, rdhx}` ×
`fabric.arch ∈ {rail-optimized, tor, eor}` × `fabric.tiers ∈ {2,3}` ×
`power.distribution ∈ {rpp, busway}` ×
`fabric.oversubscription ∈ {1,2,4}` ×
`optimizer.placement ∈ {anneal, genetic, greedy, sequential}`.

== Requirement traceability (selected)
<requirement-traceability-selected>
#figure(
  align(center)[#table(
    columns: (57.89%, 42.11%),
    align: (auto,auto,),
    table.header([Requirement], [Evidence],),
    table.hline(),
    [FR-3], [`room.capacity` fires when racks \> positions],
    [FR-5, FR-6], [Air + DLC layout ⇒ 16 errors across
    `cooling.rack_cap` / `cooling.layout`],
    [FR-14], [21 GPU racks on 64-port spines ⇒ `fabric.ports`\; resolved
    by 128-port spine or 3 tiers],
    [FR-19], [101 kW rack ⇒ 3 PDUs per side; `power.rack_pdu` fires if
    reduced],
    [FR-21], [`power.diversity` counts residual shared segments],
    [FR-23], [Media distribution shifts DAC→AOC when switching
    ToR→rail-optimized],
    [FR-24, FR-25], [Duplicate label / port conflict checked in both
    validators],
    [FR-29], [UI and CLI share `js/`\; both emit the same document],
    [FR-30], [Python checker found a real defect (coolant runs
    terminating on a rack)],
    [NFR-1], [Two consecutive exports compare identical],
    [NFR-9], [Undersized network racks produce errors, not silent
    truncation],
  )]
  , kind: table
  )

== Performance budget (measured, Node 24, Windows)
<performance-budget-measured-node-24-windows>
#figure(
  align(center)[#table(
    columns: 6,
    align: (right,right,right,right,right,right,),
    table.header([Racks], [GPUs], [Cables], [Build], [YAML], [Size],),
    table.hline(),
    [4], [128], [422], [23 ms], [5 ms], [138 KB],
    [12], [576], [1,628], [60 ms], [10 ms], [512 KB],
    [24], [960], [2,622], [282 ms], [16 ms], [830 KB],
    [48], [2,240], [5,840], [1,205 ms], [29 ms], [1.8 MB],
  )]
  , kind: table
  )

Growth is dominated by QAP annealing (O(iterations × racks)) and
per-cable A\*. Beyond \~48 racks, reduce `anneal_iters` or partition the
hall into pods.

#horizontalrule

= Risks and Limitations
<risks-and-limitations>
#figure(
  align(center)[#table(
    columns: (9.09%, 18.18%, 27.27%, 45.45%),
    align: (auto,auto,auto,auto,),
    table.header([ID], [Risk], [Impact], [Mitigation],),
    table.hline(),
    [R-1], [Heuristic solvers may miss a better layout], [Suboptimal
    cable cost], [Baseline comparison is always reported; seed is
    adjustable],
    [R-2], [Catalog figures drift from vendor reality], [Mis-sized
    plant], [Catalog is a single isolated file with cited units],
    [R-3], [Routing order-dependence], [Different fill under
    reordering], [Deterministic order; fill is reported and validated],
    [R-4], [Tray model is a simplification], [Optimistic
    congestion], [Fill reported at 80%/100% thresholds; `tray_runs`
    configurable],
    [R-5], [Output could be mistaken for a stamped drawing], [Compliance
    risk], [§1.4 exclusions; README "What this is not"],
    [R-6], [Large halls exceed interactive latency], [Poor
    UX], [Documented budget; pod the hall],
  )]
  , kind: table
  )

#horizontalrule

= Change Control
<change-control>
- Catalog changes (SKUs, costs, reach) do #strong[not] require a spec
  revision.
- Changes to the output document shape require a `schema_version` bump
  and a revision entry here.
- New validation codes require a row in §9.
- New user-facing capability requires an FR row in §4.1 and traceability
  in §10.3.

#horizontalrule

= Revision History
<revision-history>
#figure(
  align(center)[#table(
    columns: (43.75%, 25%, 31.25%),
    align: (auto,auto,auto,),
    table.header([Version], [Date], [Notes],),
    table.hline(),
    [0.1], [2026-07-25], [Initial specification: room, air/water
    cooling, rack add/remove, layout + switching architecture, power
    entrances/UPS/PDU, optimization pipeline, YAML SoT, dual
    validation],
  )]
  , kind: table
  )

