# PROGRESS

> Read `CLAUDE.md`, this file and `docs/DECISIONS.md` at the start of every session.
> Resume from **Current task**. Never redo completed work. Update after every completed
> task and before every commit.

**Last updated:** 2026-09-14 · **Architecture:** v2 (see `docs/MIGRATION_V2.md`)

## Current task

M0' Migration — CHECKPOINT A reached: `docs/MIGRATION_V2.md` written, `CLAUDE.md` and
this roadmap rewritten for v2. Next is the removal pass and the compose rewrite.

## Next 3 tasks

1. Commit the finished M3 layout package as-is (28 tests green) so the v2 migration of
   it is a reviewable diff rather than a rewrite.
2. M0': delete `apps/mcp`, `apps/worker`, `services/sim`, `services/freerouting`,
   `services/pytools`, `packages/pcb`; drop them from the workspace, Turbo graph and CI.
3. M0': rewrite `docker-compose*.yml`, `Caddyfile`, `.env.example` and the `Makefile` to
   4 required services + 3 profiles, then run `docker compose up` and confirm web on
   :3015 with api and mongo healthy.

## Roadmap v2

- [ ] **M0' Migration** — MIGRATION_V2.md written; obsolete apps/services removed;
      compose has exactly 4 required services + 3 optional profiles; `docker compose up`
      → web on :3015, api + mongo healthy; all existing tests still green.
  - [x] audit written to `docs/MIGRATION_V2.md` (KEEP/ADAPT/REMOVE per item)
  - [x] `CLAUDE.md` rewritten for v2
  - [x] roadmap in this file replaced with v2 §11
  - [ ] **CHECKPOINT A** — summary presented
  - [ ] removals (`apps/mcp`, `apps/worker`, `services/sim`, `services/freerouting`,
        `services/pytools`, `packages/pcb`)
  - [ ] compose/Caddyfile/.env/Makefile reduced to 4 + 3 profiles
  - [ ] `docker compose up` verified live (was blocked in v1 — Docker daemon down)
- [ ] **M1' Core v2** — `manualEdits`, TSX compile + merge, `ejectToTsx`; conformance
      tests including a `circuit-to-svg` render; ≥90% coverage on core.
- [ ] **M2' Parts v2** — Mongo text-index store behind `PartsIndex`; search
      "3.3V LDO SOT-223" → AMS1117 with a verified footprint; Meilisearch only under the
      `search` profile.
- [ ] **M3 Layout** — fixtures lay out with no overlapping symbols; snapshot tests;
      `manualEdits` win over automatic placement.
- [ ] **M4 Editor** — Playwright: place R and C from the palette, wire them, drag
      (manualEdits persisted), undo, export SVG; PCB/3D tabs render via runframe.
- [ ] **M5 Export + Sim** — LTspice `.asc` parses via a written parser test; KiCad export
      opens and passes `kicad-cli` ERC when the profile is up; rc_lowpass −3 dB within
      5% and op-amp gain within 2% via WASM ngspice.
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
  20 tests. Extended by M0'/M8.
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

New ADRs owed from the v2 audit (write during M0'):

- `@tscircuit/runframe` replaces the separate schematic-viewer / pcb-viewer pins.
- `jlcsearch` is not an npm package — it is a hosted API; `@tscircuit/parts-engine` is
  the published package.
- There is no `@tscircuit/autorouting`; `@tscircuit/core` routes via
  `@tscircuit/infgrid-ijump-astar` and `@tscircuit/capacity-autorouter`.

## Blocked

**Live stack acceptance is unverified.** The Docker daemon was not running on the dev
machine (`docker build` fails against `npipe:////./pipe/dockerDesktopLinuxEngine`), so
images were never built and the stack never ran. Verified without it: both compose files
pass `docker compose config`, the api and web servers serve correct health responses when
run directly with Node, auth returns 401/404 correctly, and the web app builds. The v2
4-service stack is the first thing exercised once the daemon is up.

## Open questions

1. **`easyeda-converter@0.0.2`** — verify its API before the M7 `LcscEasyEdaSource`
   adapter; fallback is a direct EasyEDA-JSON → circuit-json mapping.
2. **`@tscircuit/eval` sandboxing** — it runs under Node 24 (ADR-0007), but v2 removes
   the worker container it would have been isolated in. Decide at M1' whether in-process
   `node:vm` isolation plus timeouts and a network block is sufficient for untrusted
   LLM-authored TSX, or whether a dedicated child process with resource limits is needed.
3. **KiCad symbol licensing** — kicad-symbols is CC-BY-SA 4.0 with an exception; record
   the exact terms per part in `provenance` and surface it in the BOM export. Confirm
   the wording at M7.
4. **WASM ngspice in Node** — confirm which package tscircuit's `tsci simulate` actually
   loads before writing `TscircuitNgspiceSimulator` at M5.
