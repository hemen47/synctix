# PROGRESS

> Read `CLAUDE.md` and this file at the start of every session. Resume from
> **Current task**. Never redo completed work. Update after every completed task and
> before every commit.

**Last updated:** 2026-09-14

## Current task

M2 — `@syntrix/parts`: T0 generic catalog, `PartsSource` registry, footprint resolution.

## Next 3 tasks

1. M2: T0 catalog in code (passives, diodes, transistors, common ICs, connectors) with
   real pinouts and `port_hints`, wired into core through `ApplyContext.resolvePart`.
2. M2: footprint resolver (`@tscircuit/footprinter` string to pcb elements) with unit
   tests on 0402/0603/SOT-23/SOIC-8/SOT-223/QFN-32/TQFP-32/TO-220/headers.
3. M2: Mongo + Meilisearch T1 index and the `search_parts` path, to satisfy the
   "3.3V LDO SOT-223 returns AMS1117 with a verified footprint" criterion.

## Milestones

- [ ] **M0 Scaffold** — compose up, web on :3015, all service health endpoints
  - [x] git repo, pnpm workspace, Turborepo, tsconfig base, Prettier
  - [x] verify all 17 tscircuit packages exist and resolve versions
  - [x] verify circuit-json element shapes empirically (ADR-0003)
  - [x] CLAUDE.md, ARCHITECTURE.md, ROADMAP.md, PROGRESS.md, DECISIONS.md
  - [x] package skeletons with interfaces (shared, core, parts, layout, export, sim, agent, pcb, ui-canvas)
  - [x] app skeletons (web, api, mcp, worker) — api health tested, web shell renders it
  - [x] service Dockerfiles + FastAPI wrappers (kicad, sim, pytools, freerouting)
  - [x] docker-compose.yml, docker-compose.dev.yml, Caddyfile, Makefile, .env.example
  - [x] config/models.yaml
  - [x] GitHub Actions CI, Husky pre-commit (verified: it blocked an unformatted commit)
  - [x] ESLint config
  - [ ] **BLOCKED** — `make dev` end-to-end run (needs Docker Desktop running locally)
- [x] **M1 Core** — 90% coverage, conformance tests, rc_lowpass round-trip
  - [x] `@syntrix/shared`: Result, errors, ids, SI units, logger (34 tests)
  - [x] element factories that validate through circuit-json at construction
  - [x] indexed view, pin resolution by number/name/hint, connectivity closure
  - [x] `apply` reducer — all 16 operations, pure and immutable
  - [x] ERC v1 — all 8 rules, built on circuit-json's native pin semantics
  - [x] `summarizeForLLM` with budget-aware truncation
  - [x] TSX merge via `merge_circuit_json` (3 strategies)
  - [x] rc_lowpass round-trip; batch and stepwise produce identical documents
  - [x] coverage 94.3% lines / 94.9% functions / 81.0% branches (108 tests)
- [ ] **M2 Parts T0+T1** — search returns AMS1117 with verified footprint
- [ ] **M3 Layout** — fixtures lay out without overlaps
- [ ] **M4 Editor** — Playwright place/wire/undo/export
- [ ] **M5 Export** — LTspice .asc parser test, KiCad ERC passes
- [ ] **M6 Simulation** — rc_lowpass -3 dB within 5%, op-amp gain within 2%
- [ ] **M7 Agent** — 10-prompt eval, at least 8 pass — **CHECKPOINT B**
- [ ] **M8 Parts T2** — LCSC import end-to-end, KiCad lib import
- [ ] **M9 MCP** — inspector lists tools, create circuit over MCP
- [ ] **M10 PCB** — placement, routing, Gerber, DRC passes

## Decisions made

Full ADRs in `DECISIONS.md`. Summary:

- **ADR-0001** Node 24 locally, `engines: >=20`, `node:22-alpine` in containers.
- **ADR-0002** **zod pinned to v3** workspace-wide — `circuit-json` is built against zod 3
  and declares it as an undeclared peer. Blocks zod 4 features; use `zod-to-json-schema`
  for agent tool schemas.
- **ADR-0003** circuit-json shapes verified empirically against v0.0.491.
  `any_circuit_element` is a strict discriminated union, so conformance is enforceable at
  element construction. SI strings are parsed by circuit-json itself (`"10k"` to `10000`).
- **ADR-0004** Simulation engine is `eecircuit-engine`, not `@o.z/ngspice-wasm` (which is
  published at 0.0.0, a placeholder). Provisional until M6.
- **ADR-0005** All 17 tscircuit packages exist; versions pinned exactly (0.0.x packages
  have no semver guarantee). `easyeda-converter` is at 0.0.2 — verify before M8.

## Blocked

**M0 manual acceptance is unverified.** The Docker daemon was not running on the dev
machine (`docker build` fails with `failed to connect to the docker API at
npipe:////./pipe/dockerDesktopLinuxEngine`), so image builds and the live stack were
never exercised. What _is_ verified: both compose files pass `docker compose config`
(which does not need the daemon), the API and web servers start and serve correct health
responses when run directly with Node, auth returns 401/404 correctly, and the web app
builds.

To finish M0, start Docker Desktop and run the script in `ACCEPTANCE.md` (`make dev`,
`make health`). Expect a long first build — the KiCad 9 image is several GB.

## Open questions

1. **`easyeda-converter@0.0.2`** — version suggests an early or republished package.
   Verify its API before the M8 `LcscEasyEdaSource` adapter; fallback is a direct
   EasyEDA-JSON to circuit-json mapping.
2. **`@tscircuit/eval` sandbox in Node** — confirm it isolates untrusted LLM-authored TSX
   adequately, or run it inside the worker container with resource limits. Decide at M1
   when `merge_circuit_json` / TSX mode is implemented.
3. **Freerouting invocation** — Java CLI vs HTTP API in the `freerouting` container.
   Decide at M10.
4. **KiCad symbol licensing** — kicad-symbols is CC-BY-SA 4.0 with an exception; record
   the exact terms per part in `provenance` and surface it in the BOM export. Confirm
   wording at M8.
5. **Coverage target** — M1 requires 90% on core. Decide whether that is line or branch
   coverage in the Vitest config (currently planning line, with branch reported).
