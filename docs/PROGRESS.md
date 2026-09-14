# PROGRESS

> Read `CLAUDE.md`, this file and `docs/DECISIONS.md` at the start of every session.
> Resume from **Current task**. Never redo completed work. Update after every completed
> task and before every commit.

**Last updated:** 2026-09-14 · **Architecture:** v2 (see `docs/MIGRATION_V2.md`)

## Current task

M1' Core v2 — add `manualEdits` to `Design`, migrate `meta[].layoutOverride` into it
(ADR-0013), then TSX compile + merge and `ejectToTsx`.

M0' is complete except its one live check: `docker compose up` cannot run because the
Docker daemon is not running on this machine. Everything that does not need the daemon
is verified — see **Blocked**.

## Next 3 tasks

1. M1': `manualEdits` on `Design`; `move_component` writes it; `set_layout_override` is
   removed from the operation union; a one-time migration of v1 documents, with a test.
   Then point `@syntrix/layout` at `design.manualEdits` and re-run its 28 tests.
2. M1': `compileTsx` over `@tscircuit/eval` in a sandbox (timeouts, no network) and
   `mergeCompiled` with re-idding and provenance — this also closes open question 2.
3. M1': `ejectToTsx` plus the `circuit-to-svg` render-conformance test; hold core
   coverage at or above the ADR-0008 gate.

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
2. **`@tscircuit/eval` sandboxing** — it runs under Node 24 (ADR-0007), but v2 removes
   the worker container it would have been isolated in. Decide at M1' whether in-process
   `node:vm` isolation plus timeouts and a network block is sufficient for untrusted
   LLM-authored TSX, or whether a dedicated child process with resource limits is needed.
3. **KiCad symbol licensing** — kicad-symbols is CC-BY-SA 4.0 with an exception; record
   the exact terms per part in `provenance` and surface it in the BOM export. Confirm
   the wording at M7.
4. **WASM ngspice in Node** — confirm which package tscircuit's `tsci simulate` actually
   loads before writing `TscircuitNgspiceSimulator` at M5.
