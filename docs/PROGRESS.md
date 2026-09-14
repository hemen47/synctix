# PROGRESS

> Read `CLAUDE.md` and this file at the start of every session. Resume from
> **Current task**. Never redo completed work. Update after every completed task and
> before every commit.

**Last updated:** 2026-09-14

## Current task

M0 — scaffold: workspace packages, Docker Compose stack, service health endpoints.

## Next 3 tasks

1. Finish M0: `docker-compose.yml` + dev override, Caddyfile, Makefile, `.env.example`,
   service Dockerfiles with health endpoints, CI workflow.
2. M1: `@syntrix/shared` (Result, ids, SI units, errors, logger) with tests.
3. M1: `@syntrix/core` document + indexed view + Operation union + `apply` reducer.

## Milestones

- [ ] **M0 Scaffold** — compose up, web on :3015, all service health endpoints
  - [x] git repo, pnpm workspace, Turborepo, tsconfig base, Prettier
  - [x] verify all 17 tscircuit packages exist and resolve versions
  - [x] verify circuit-json element shapes empirically (ADR-0003)
  - [x] CLAUDE.md, ARCHITECTURE.md, ROADMAP.md, PROGRESS.md, DECISIONS.md
  - [ ] package skeletons with interfaces (shared, core, parts, layout, export, sim, agent, pcb, ui-canvas)
  - [ ] app skeletons (web, api, mcp, worker)
  - [ ] service Dockerfiles + FastAPI wrappers (kicad, sim, pytools)
  - [ ] docker-compose.yml, docker-compose.dev.yml, Caddyfile, Makefile, .env.example
  - [ ] config/models.yaml
  - [ ] GitHub Actions CI, Husky pre-commit
  - [ ] ESLint config
- [ ] **M1 Core** — 90% coverage, conformance tests, rc_lowpass round-trip
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
