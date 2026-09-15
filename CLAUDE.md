# CLAUDE.md — SYNTRIX project rules (v2)

Agentic, AI-native web EDA built **on tscircuit**: schematic → simulation → PCB.
Read this file, `docs/PROGRESS.md` and `docs/DECISIONS.md` at the start of every session,
then resume from PROGRESS.md's **Current task**. Never redo completed work.
`docs/MIGRATION_V2.md` records what v1 left behind and why.

## Non-negotiable principles

1. **Build on tscircuit, not beside it.** tscircuit is the engine for rendering,
   autorouting, simulation, footprints and fabrication/KiCad export. Before implementing
   any of those, check whether a tscircuit package already does it and use it. Record
   every reuse-or-replace decision in `docs/DECISIONS.md`. We build only what tscircuit
   lacks: a graphical editor, persistence + operation log, a provider-agnostic in-app
   agent, MCP tools, a curated engineering parts library, ELK schematic layout, and an
   LTspice exporter.
2. **One canonical engine.** `@syntrix/core` owns all mutation. Web UI, REST API, agent
   and MCP server are thin clients that submit typed **Operations**.
3. **The document IS circuit-json.**
   `Design = { id, version, circuit: AnyCircuitElement[], meta, manualEdits }`.
   - `circuit` holds only spec-conformant elements, validated with the Zod schemas
     exported by `circuit-json`. **Never add non-spec fields to circuit-json elements.**
   - `meta` is our sidecar: provenance, constraints, agent notes, part refs.
   - `manualEdits` mirrors tscircuit's manual-edits concept (schematic/pcb placements the
     user dragged) and **always wins over automatic layout**.
   - TSX is an **input** format: tscircuit code is compiled by `@tscircuit/eval` in a
     sandbox and merged via `merge_circuit_json`. `ejectToTsx` is one-way; there is no
     graphical→TSX round-trip.
4. **The LLM never emits coordinates or whole files.** Two modes, one document:
   OPERATIONS mode (tool calls validated by core — edits, fixes, small additions) and
   TSX mode (a tscircuit `<board>` written against the official tscircuit AI skill, then
   evaluated and merged — preferred for generating whole circuits).
5. **Geometry is computed, not authored.** `@syntrix/layout` (ELK) places schematic
   elements that have no position; tscircuit's autorouter handles PCB routing. The LLM
   gives semantic hints (`place_hint`) only.
6. **Everything is a plugin behind a registry**: exporters, simulators, layout
   strategies, LLM providers, parts sources, importers. Adding one never touches core.
7. **Event sourcing.** Append-only Operation log in Mongo. Snapshots are derived.
   Undo/redo/replay/agent-audit all come from the log.
8. **Provider independence.** All LLM access goes through the Vercel AI SDK (`ai`) with a
   role→model routing table in `config/models.yaml` (roles: planner, executor, reviewer,
   embedder). Switching provider is an env/yaml change only. Secrets are server-side only.
9. **Parts data is first-class.** Official APIs and openly licensed libraries only — no
   HTML scraping of distributor sites. License and provenance recorded per part.
10. **Minimal infrastructure.** One Node runtime for all app code. Docker Compose has
    **exactly four required services**; anything else is an opt-in profile.

## Verify, never guess

Before using any third-party API, read `node_modules/<pkg>/dist/*.d.ts`, the package's
`exports`, or its README. When the real API differs from what a spec or prompt assumed,
**adapt to the real API and record an ADR in `docs/DECISIONS.md`.** Verified facts live
in DECISIONS.md — check there before re-deriving.

## Stack

- pnpm workspaces + Turborepo, TypeScript strict, ESM, Node 20+, Vitest, Playwright,
  ESLint + Prettier, Husky, GitHub Actions.
- **zod is pinned to v3** workspace-wide (ADR-0002) — `circuit-json` is built against
  zod 3 and declares it as an undeclared peer. Use `zod-to-json-schema` for tool schemas.
- **tscircuit packages** (pinned exactly; 0.0.x has no semver guarantee — ADR-0005/0006):
  `circuit-json`, `@tscircuit/core`, `@tscircuit/eval`, `@tscircuit/runframe`
  (CircuitJsonViewer for the PCB/3D tabs), `circuit-to-svg`, `circuit-json-to-spice`,
  `circuit-json-to-kicad`, `kicad-converter`, `kicad-mod-converter`,
  `circuit-json-to-gerber`, `circuit-json-to-bom-csv`, `circuit-json-to-pnp-csv`,
  `dsn-converter`, `@tscircuit/footprinter`, `schematic-symbols`, `easyeda-converter`,
  `@tscircuit/parts-engine`, and the autorouter `@tscircuit/core` already carries.
- The official tscircuit AI skill is fetched at build time into
  `packages/agent/prompts/tscircuit-skill/` and is the base of the TSX-mode system prompt.
- Frontend: Vite + React 18, Zustand, TanStack Query, d3-zoom, a custom SVG schematic
  canvas over circuit-json (no React Flow), `schematic-symbols` for symbol geometry,
  runframe viewers for read-only PCB/3D, uPlot for waveforms, optional lazy KiCanvas.
- Backend: Express, Mongoose, Zod, SSE, Pino, rate limiting, problem+json errors. MCP is
  served from the **same api process** via `@modelcontextprotocol/sdk` (Streamable HTTP
  at `/mcp`) plus a stdio entry for local Claude Desktop/Cursor. Long jobs use an
  in-process Mongo-backed queue (no Redis) until the `indexing` profile is enabled.
- Simulation: tscircuit's WASM ngspice in a Web Worker (browser) and in Node (server).
  No native ngspice service.
- Layout: `elkjs`. Artifacts: local volume `./data/artifacts`. No MinIO.

## Services

Docker Compose, Caddy public entry on **port 3015**:

- **Required (3):** `proxy` (Caddy :3015 → web, `/api`, `/mcp`), `web` (nginx static,
  :3016), `api` (Express + MCP, :3017).
- **Optional profiles:** `mongo` (only if you want the database in a container), `kicad`
  (kicad/kicad:9.0 + FastAPI wrapper over `kicad-cli`, :3019), `indexing` (redis + BullMQ
  worker for large parts ingestion), `search` (meilisearch :7700).

## Conventions

- **ESM only.** Local imports are extensionless; package entry points are `src/index.ts`
  in dev and `dist/index.js` when built.
- **Result type, not exceptions**, for domain failures: `Result<T, E>` from
  `@syntrix/shared`. Throw only for programmer error.
- Every validation error carries `code`, `message`, `hint`, `elementIds` so the LLM can
  self-correct.
- IDs come from `@syntrix/shared` (`newId(prefix)`), deterministic in tests via an
  injectable id factory — never `Math.random()` inline.
- Pure functions in core: `apply(design, op)` is immutable and returns a new `Design`.
- Naming: packages `@syntrix/*`; files kebab-case; types PascalCase; Zod schemas
  `camelCase` ending in `Schema`.
- Tests live next to source as `*.test.ts`; golden fixtures in `__fixtures__/`.

## How to run

```bash
pnpm install
pnpm dev              # web on :3016, api on :3017 — no Docker needed
pnpm build            # turbo build all packages
pnpm test             # vitest across the workspace
pnpm typecheck
pnpm lint
pnpm e2e              # playwright; starts its own servers

make dev                    # docker compose stack (web on :3015)
make dev PROFILES=mongo      # add a containerised MongoDB
```

MongoDB is **not** a container by default — it runs on the host in development and is
Atlas in production. `docs/DEVELOPMENT.md` has the detail, including two traps worth
knowing: a database name containing `/` connects and then fails every query, and a
`mongodb+srv://` URL needs a DNS resolver that answers (`MONGO_DNS_SERVERS`).

## Working agreement

- Commit after each task with **conventional commits**. Run tests before each commit.
- Update `docs/PROGRESS.md` after every completed task and before every commit
  ("current task", "next 3 tasks", "open questions").
- A milestone is done only when its exit criteria pass via an automated test or a
  documented manual script in `docs/ACCEPTANCE.md`.
- Record every non-obvious technical choice as an ADR in `docs/DECISIONS.md`.
