# PROGRESS

> Read `CLAUDE.md`, this file and `docs/DECISIONS.md` at the start of every session.
> Resume from **Current task**. Never redo completed work. Update after every completed
> task and before every commit.

**Last updated:** 2026-09-14 · **Architecture:** v2 (see `docs/MIGRATION_V2.md`)

## Current task

M6 Agent — tool definitions over the operation set, role→model routing through the Vercel
AI SDK, the AgentLoop, and the 10-prompt eval suite. **CHECKPOINT B** follows.

M0' through M5 are complete except three things, none of them blocking: M0's live
`docker compose up` (the Docker daemon is not running on this machine), M4's
runframe-backed PCB/3D tabs (deferred to M9, when there is PCB data worth viewing), and
M5's `kicad-cli` ERC check (needs the `kicad` profile). See **Blocked**.

## Next 3 tasks

1. M6: fetch the official tscircuit AI skill into `packages/agent/prompts/` with a
   refresh script, and build the TSX-mode system prompt on it.
2. M6: tool definitions generated from core's own Zod schemas via `zod-to-json-schema`,
   so the tool surface and the REST surface cannot drift; then the AgentLoop, with
   `run_erc` mandatory before finishing and TSX diagnostics fed back as failures
   (ADR-0017).
3. M6: the 10-prompt eval under MockProvider replay, plus the provider-switch test
   (OpenRouter → Anthropic by env alone).

## Roadmap v2

- [ ] **M0' Migration** — MIGRATION_V2.md written; obsolete apps/services removed;
      compose has exactly 4 required services + 3 optional profiles; `docker compose up`
      → web on :3015, api + mongo healthy; all existing tests still green.
  - [x] audit written to `docs/MIGRATION_V2.md` (KEEP/ADAPT/REMOVE per item)
  - [x] `CLAUDE.md` rewritten for v2
  - [x] roadmap in this file replaced with v2 §11
  - [x] **CHECKPOINT A** — summary presented
  - [x] removals (`apps/mcp`, `apps/worker`, `services/sim`, `services/freerouting`,
        `services/pytools`, `packages/pcb`) — 745 loc of skeleton and superseded service
  - [x] compose reduced to 4 required + 3 profiles; `docker compose config --services`
        prints exactly `proxy web api mongo`, and all three profiles render clean
  - [x] Caddyfile routes `/mcp` to the api; `.env.example` trimmed of MINIO/SIM/
        FREEROUTING/PYTOOLS/MCP_PORT, with profile vars moved to an opt-in section
  - [x] Makefile gains `PROFILES=`; the health-check script takes `--profiles`
  - [x] api health probes reduced to the two optional profile services, so a bare stack
        reports `ok` rather than `degraded` (21 tests)
  - [x] CI builds the api and web images instead of the deleted service images
  - [x] ADR-0009 … ADR-0013 recorded; ARCHITECTURE, ROADMAP, ACCEPTANCE, README updated
  - [x] all tests green: 234 across shared, core, parts, layout and api
  - [ ] **BLOCKED** — `docker compose up` verified live (Docker daemon not running)
- [x] **M1' Core v2** — `manualEdits`, TSX compile + merge, `ejectToTsx`; conformance
      tests including a `circuit-to-svg` render; ≥90% coverage on core.
  - [x] `manualEdits` on `Design`, using `@tscircuit/props`' own `manual_edits_file`
        schema rather than one of ours (ADR-0018); keyed by component name, not id
  - [x] `move_component` writes it, `clear_placement` removes it, `set_layout_override`
        is gone — 15 operations, down from 16
  - [x] `migrateDesign` lifts v1 documents on load, idempotently, reporting orphans
  - [x] `@syntrix/layout` reads `design.manualEdits`; its 28 tests still pass
  - [x] `compileTsx` over `@tscircuit/eval` — CDN off, timeout, runner killed on every
        path (ADR-0015, closing open question 2)
  - [x] `partitionConformant` handles the renderer/schema skew without letting a
        non-conformant element into the document (ADR-0016)
  - [x] `CompiledTsx.diagnostics` surfaces the errors tscircuit reports without throwing
        (ADR-0017) — a bad selector compiles clean, which would otherwise be silent
  - [x] `mergeCompiled` re-ids structurally, records provenance for what landed, and
        `mergeImpact` says what a merge would overwrite before it happens
  - [x] `ejectToTsx`, proved by recompiling its own output and comparing connectivity
  - [x] conformance: both fixtures render through `circuit-to-svg`'s schematic and PCB
        renderers without throwing
  - [x] React pinned to 19 workspace-wide, which is what made `@tscircuit/eval` run at
        all (ADR-0014)
  - [x] core 148 tests, 94.7% lines / 83.1% branches — above the ADR-0008 gate;
        272 across the workspace
- [x] **M2' Parts v2** — Mongo text-index store behind `PartsIndex`; search
      "3.3V LDO SOT-223" → AMS1117 with a verified footprint; Meilisearch only under the
      `search` profile.
  - [x] `PartsIndex` interface with three implementations — local, Mongo, Meilisearch
  - [x] ranking is shared, not per-index: Mongo narrows, the T0 scorer ranks, and a test
        asserts Mongo and local return the same order for the same query
  - [x] `toMongoFilter` is a pure function, tested without a database — including regex
        escaping, so "AMS1117-3.3" cannot compile into a pattern where "." matches
        anything
  - [x] Meilisearch reports `disabled` with no URL and never throws for it; range filters
        stay with the indexes that can express them
  - [x] exit criterion passes on the local index, so it holds with nothing running
  - [x] 59 parts tests; 290 across the workspace
- [x] **M3 Layout** — fixtures lay out with no overlapping symbols; snapshot tests;
      `manualEdits` win over automatic placement.
  - [x] all four fixtures lay out with no intersecting symbol bounding boxes
  - [x] placement snapshots keyed by component name and rounded to the grid, so they
        record the drawing rather than the id factory's counter
  - [x] a manually placed component does not move when new components are added around
        it — the failure that makes a graphical editor unusable
  - [x] `clear_placement` visibly hands a component back to ELK
  - [x] 34 layout tests
- [x] **M4 Editor** — Playwright: place R and C from the palette, wire them, drag
      (manualEdits persisted), undo, export SVG.
  - [x] `@syntrix/ui-canvas`: scene graph over circuit-json using `schematic-symbols`
        artwork, hit testing, viewport maths, and the editor state machine — all pure
        functions over plain data, 42 tests, no DOM
  - [x] the state machine emits Operations and never mutates a design; a drag that did
        not move emits nothing, and Ctrl+Z emits nothing because undo is a log replay
  - [x] api: designs CRUD, operations with optimistic concurrency, history, undo/redo,
        layout, ERC, summary, parts search and pinout (41 tests)
  - [x] the append-only log with `mintedIds`, so replay reproduces ids exactly
  - [x] three-pane React shell — palette, SVG canvas, inspector — with the keyboard map
  - [x] designs have a URL, so a reload returns to the same document
  - [x] 9 Playwright tests green: place, wire, drag-and-reload, undo/redo, Ctrl+Z, Delete,
        export SVG, ERC
  - [ ] **DEFERRED to M9** — PCB and 3D tabs via `@tscircuit/runframe`. There is no PCB
        layer in a design until M9, so the tabs would render an empty board; building the
        viewer before there is anything to view would be building it twice.
- [x] **M5 Export + Sim** — LTspice `.asc` parses via a written parser test; rc_lowpass
      −3 dB within 5%.
  - [x] exporter registry with eight tscircuit-backed exporters: SPICE, BOM, pick-and-
        place, KiCad, schematic SVG, board SVG, Gerber, DSN
  - [x] every adapter written against the package's real API — three assumptions were
        wrong (see below)
  - [x] the engineering BOM is ours, because tscircuit's is a purchasing BOM and emits
        nothing for an unsourced design (ADR-0021)
  - [x] LTspice `.asc` writer plus a written `.asc` parser that reads its output back —
        ground becomes node 0, unsupported parts are named rather than mis-drawn
  - [x] `spicey` as the simulator, not WASM ngspice: it is what tscircuit itself uses and
        it lands the rc_lowpass corner **0.74%** from theory (ADR-0019, closing open
        question 4)
  - [x] `.op` served from a settled transient, `.dc` refused rather than faked (ADR-0020)
  - [x] `summarizeSimResult` — interpolated −3 dB against the passband, 10–90% rise time,
        overshoot against the settled value; the model never sees a raw vector
  - [x] 22 export tests, 19 sim tests
  - [ ] **DEFERRED** — `kicad-cli sch erc` on the exported schematic needs the `kicad`
        compose profile, which needs the Docker daemon. The export itself is verified.
  - [ ] **DEFERRED to M6** — op-amp gain within 2%. Core has no `simple_op_amp` factory,
        so the fixture needs the parts layer's resolver path; the measurement harness is
        in place and the RC criterion passes.
- [ ] **M6 Agent** — 10-prompt eval suite (TSX-mode and ops-mode), ≥8 pass ERC + the
      expected sim metric under MockProvider replay and under a live provider when a key
      is present; provider-switch test (OpenRouter → Anthropic via env) passes.
      — **CHECKPOINT B**
- [ ] **M7 Parts T2** — LCSC import end-to-end yields symbol + footprint + 3D; KiCad lib
      import; DigiKey adapter works with keys and reports `disabled` without.
- [ ] **M8 MCP** — MCP inspector lists all tools over `/mcp` and stdio; end-to-end
      circuit creation from an external MCP client.
- [ ] **M9 PCB** — `pcb_board` + placement constraints + tscircuit autorouter →
      `pcb_trace`; Gerber export; DSN export as an escape hatch; `kicad-cli` DRC passes
      on a 2-layer ams1117_regulator board when the profile is up; PCB tab becomes
      editable for placement.

## Bugs the tests found

Recording these because each was invisible to the layer above it, and each is the kind
that comes back.

- **Replay regenerated element ids.** `apply` mints ids as it goes, so folding a log with
  a fresh factory produced a structurally identical design with different ids — orphaning
  the id-keyed `meta` sidecar and invalidating every id a client held. Undo would have
  broken both silently. Log entries now record what they minted. Found by asserting that
  a design folded from its log equals the one the store served.
- **Both pins of a passive landed on the same point.** ELK assigns port coordinates while
  routing, so a component with no edges yet — every component, the moment it is placed —
  got every port at the node origin. It drew as one pin, made the other unclickable, and
  let a wire attach to whichever the hit test found first. Pin positions are computed from
  the symbol's own geometry now. The layout tests passed throughout: they checked that
  _components_ did not overlap, not that pins within one were distinct.
- **A symbol's box beat its own pin in the hit test.** `distanceToRect` reports 0 anywhere
  inside a symbol, so sorting by distance first let the symbol win by 0 against a pin
  0.000002mm away. Pins were unclickable and the wire tool could not start a wire. Hit
  testing sorts by kind first now, which was what its own comment already claimed.
- **The wire preview swallowed the click that would finish the wire.** It follows the
  cursor, so it sat between the cursor and the destination pin. Decoration is
  `pointer-events: none` now.
- **`simple_potentiometer` could not be added at all.** circuit-json requires
  `max_resistance` on it, which core had no way to know. Required props are read from the
  schema itself now, rather than from a list in core that would drift.
- **The editor created two designs per load**, because React StrictMode invokes an effect
  twice and both ran before the first `await` resolved. A state check cannot guard across
  an await; a shared promise can.
- **A reload started a new empty design.** Designs had no address. They have a URL now.
- **Three exporter APIs were not what the plan assumed.** `circuitJsonToSpice` returns a
  netlist object rather than a string, so missing the second call would have shipped
  `[object Object]`. The KiCad converters are stateful builders, not `convert(json)`
  functions. `convertCircuitJsonToGerberFiles` does the whole job, so we do not own layer
  naming. All three were found by reading the packages before writing the adapter, which
  is the cheap way to find them.
- **`spicey` parses the first line of a netlist.** Every SPICE dialect since the 1970s
  treats it as a title. A netlist beginning "RC lowpass" fails with "Resistor missing
  node", because the line begins with R — an error pointing nowhere near its cause.

## Carried forward from v1 (work that survives)

These were completed under v1 and are not redone; the v2 milestone that reworks each is
named in `docs/MIGRATION_V2.md`.

- **`@syntrix/shared`** — Result, errors, `newId`, SI units, logger. 34 tests. KEEP.
- **`@syntrix/core`** — element factories validating through circuit-json at
  construction, indexed view, pin resolution, connectivity closure, the `apply` reducer
  over 16 operations, ERC v1 (8 rules), `summarizeForLLM`, `merge_circuit_json` (3
  strategies), rc_lowpass round-trip. 108 tests, 94.3% lines / 94.9% functions / 81.0%
  branches. Reworked by M1'.
- **`@syntrix/parts`** — T0 catalog of 34 parts with real pinouts, aliases, licence and
  provenance; footprint resolver over `@tscircuit/footprinter` with 19 packages
  pad-count verified; `verifyPinMapping` (caught 5 real catalogue defects); local search
  with synonyms, package aliases, voltage matching, facets and filters; `PartsSource`
  registry with federated search; `t0Resolver` core bridge; AMS1117 builds from the
  catalog and passes ERC. 41 tests. Reworked by M2'.
- **`@syntrix/layout`** — `ElkLayoutStrategy`, schematic conventions, registry, 28 tests
  including output conformance on three fixtures. Complete but uncommitted; committed
  first, then migrated to `manualEdits` at M3.
- **`apps/api`** — Express factory, api-key auth, problem+json errors, health probes.
  21 tests. Extended by M0'/M8.
- **Scaffold** — pnpm workspace, Turborepo, tsconfig base, ESLint, Prettier, Husky
  (verified blocking an unformatted commit), GitHub Actions CI, `config/models.yaml`.

## Decisions made

Full ADRs in `DECISIONS.md`. Summary:

- **ADR-0001** Node 24 locally, `engines: >=20`, `node:22-alpine` in containers.
- **ADR-0002** **zod pinned to v3** workspace-wide — `circuit-json` is built against zod
  3 and declares it as an undeclared peer. Use `zod-to-json-schema` for tool schemas.
- **ADR-0003** circuit-json shapes verified empirically against v0.0.491.
  `any_circuit_element` is a strict discriminated union, so conformance is enforceable at
  element construction. SI strings are parsed by circuit-json itself.
- **ADR-0004** Simulation engine `eecircuit-engine` — **superseded by v2**; simulation
  now uses the WASM ngspice path tscircuit itself uses. New ADR at M5.
- **ADR-0005** All 17 tscircuit packages exist; versions pinned exactly.
  `easyeda-converter` is at 0.0.2 — verify before M7.
- **ADR-0006** tscircuit packages under-declare dependencies; the closure is pinned as
  root devDependencies. Its Freerouting consequence is retired by v2 (§1: use tscircuit's
  autorouter); the `@tscircuit/krt-wasm` proprietary-licence review stands.
- **ADR-0007** Element conventions taken from tscircuit's own eval output, not invented.
  `@tscircuit/eval` runs under Node 24.
- **ADR-0008** Coverage gate: 90% lines/statements/functions, 80% branches.
- **ADR-0009** v2: build on tscircuit; four required compose services with three opt-in
  profiles. Supersedes ADR-0004 and retires ADR-0006's Freerouting consequence.
- **ADR-0010** `jlcsearch` is not an npm package — it is a hosted API;
  `@tscircuit/parts-engine@0.0.32` is the published part-search package.
- **ADR-0011** `@tscircuit/runframe` replaces the separate schematic-viewer and
  pcb-viewer pins, for the read-only PCB and 3D tabs only — the schematic canvas stays
  ours, because it has to be editable.
- **ADR-0012** There is no `@tscircuit/autorouting`; M9 takes the `pcb_trace` elements
  `@tscircuit/core` emits rather than importing a router directly.
- **ADR-0013** `manualEdits` replaces `meta[].layoutOverride`; `set_layout_override`
  leaves the operation union, taking it from 16 operations to 15.
- **ADR-0014** One React, and it is 19: a transitive `calculate-cell-boundaries` pulls
  React 18 into pnpm's hidden hoist directory, where it shadowed React for
  `@tscircuit/eval`. Overridden workspace-wide; `apps/web` moved to 19 to match.
- **ADR-0015** TSX isolation is in-process with CDN off, a timeout and a guaranteed kill.
  Adequate for trusted input; untrusted input needs a process boundary, decided at M8.
- **ADR-0016** tscircuit's renderer and `circuit-json`'s schema disagree about
  `pcb_component.display_offset_x`. The field is stripped, never coerced, and the skew is
  reported rather than hidden.
- **ADR-0017** A bad tscircuit selector does not throw — it becomes a
  `source_trace_not_connected_error` element. `compileTsx` lifts those into
  `diagnostics`, and the M6 agent loop must treat them as a failed call.
- **ADR-0019** `spicey` — tscircuit's own native-JS SPICE engine — is the simulator, not
  WASM ngspice, which does not exist as a tscircuit path. 0.74% error on the rc_lowpass
  corner. Supersedes ADR-0004 and closes open question 4.
- **ADR-0020** What spicey does not do: it parses the netlist's first line, implements
  neither `.op` nor `.dc`, and its analysis functions take a parsed circuit rather than
  text. `op` comes from a settled transient; `dc` is refused rather than faked.
- **ADR-0021** The engineering BOM is ours. `circuit-json-to-bom-csv` emits rows only for
  components with a distributor SKU, so an unsourced design produces an empty file.
- **ADR-0018** `@tscircuit/props` exports the manual-edits schema; we use it verbatim.
  It keys placements by selector/name, not `source_component_id` as the spec assumed —
  which is what makes a user's drag survive a TSX recompile.

## Blocked

**Live stack acceptance is unverified.** The Docker daemon is still not running on the
dev machine (`docker info` fails against `npipe:////./pipe/dockerDesktopLinuxEngine`), so
images have never been built and the stack has never run. This is the single remaining
M0' item.

Verified without the daemon: `docker compose config --services` prints exactly the four
required services, and renders clean with each profile enabled; both compose files pass
`docker compose config --quiet`; the api and web servers serve correct health responses
when run directly with Node; auth returns 401/404 correctly; the web app builds.

To close it: start Docker Desktop and run the M0' script in `ACCEPTANCE.md` (`make dev`,
`make health`). The v2 stack is four small services, so the first build is minutes rather
than the multi-GB KiCad pull v1 needed — that image now sits behind `PROFILES=kicad`.

## Open questions

1. **`easyeda-converter@0.0.2`** — verify its API before the M7 `LcscEasyEdaSource`
   adapter; the fallback is a direct EasyEDA-JSON → circuit-json mapping. ADR-0010
   covers the rest of that adapter's dependencies.
2. ~~**`@tscircuit/eval` sandboxing**~~ — resolved by ADR-0015. In-process with CDN
   loading off, a timeout and a guaranteed kill is adequate for trusted input; an
   untrusted caller needs a process boundary, which is decided at M8 when MCP exposes
   `generate_tsx_circuit` externally.
3. **KiCad symbol licensing** — kicad-symbols is CC-BY-SA 4.0 with an exception; record
   the exact terms per part in `provenance` and surface it in the BOM export. Confirm
   the wording at M7.
4. ~~**WASM ngspice in Node**~~ — resolved by ADR-0019. There is no WASM ngspice path in
   tscircuit; its engine is `spicey`, pure JavaScript, already in our dependency closure.
