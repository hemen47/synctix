# CLAUDE.md — SYNTRIX project rules

Agentic, AI-native web EDA: schematic → simulation → PCB. Read this file and
`docs/PROGRESS.md` at the start of every session, then resume from PROGRESS.md's
**Current task**. Never redo completed work.

## Non-negotiable principles

1. **One canonical engine.** `@syntrix/core` owns all mutation. Web UI, REST API, LLM
   agent and MCP server are thin clients that submit typed **Operations**. No client
   mutates a design directly.
2. **The document IS circuit-json.** A flat `AnyCircuitElement[]`, validated with the Zod
   schemas exported by the `circuit-json` package. Anything we need that the spec does
   not have (layout overrides, constraints, provenance, agent notes) lives in a sidecar
   `meta: Record<elementId, MetaEntry>`. **Never add non-spec fields to circuit-json
   elements.**
3. **The LLM never emits coordinates or whole files.** Two input modes, one document:
   OPERATIONS mode (default, tool calls validated by core) and TSX mode (a tscircuit
   `<board>` snippet evaluated by `@tscircuit/eval`, merged via `merge_circuit_json`).
4. **Geometry is computed, not authored.** The LLM gives semantic hints (`place_hint`);
   `@syntrix/layout` (schematic) and `@syntrix/pcb` (board) produce coordinates.
5. **Everything is a plugin behind a registry**: exporters, simulators, layout
   strategies, LLM providers, parts sources, importers. Adding one never touches core.
6. **Event sourcing.** Append-only Operation log in Mongo. Design snapshots are derived.
   Undo/redo/replay/agent-audit all come from the log.
7. **Provider independence.** All LLM access goes through the Vercel AI SDK (`ai`) with a
   role→model routing table in `config/models.yaml`. Switching provider is an env/yaml
   change only. Secrets exist server-side only.
8. **Parts data is first-class.** Official APIs and openly licensed libraries only — no
   HTML scraping of distributor sites. License and provenance recorded per part.

## Verify, never guess

Before using any third-party API, read `node_modules/<pkg>/dist/*.d.ts` (or the README).
When the real API differs from what a spec or prompt assumed, **adapt to the real API and
record an ADR in `docs/DECISIONS.md`.** Verified facts so far live in DECISIONS.md —
check there before re-deriving.

## Stack

- pnpm workspaces + Turborepo, TypeScript strict, ESM, Vitest, Playwright.
- **zod is pinned to v3** workspace-wide (see ADR-0002) — `circuit-json` is built against
  zod 3 and declares it as an undeclared peer.
- Frontend: Vite + React 18, Zustand, TanStack Query, d3-zoom, custom SVG canvas
  (no React Flow), `schematic-symbols`, `circuit-to-svg`, KiCanvas, uPlot.
- Backend: Express, Mongoose, Zod, SSE, BullMQ + Redis, MinIO, Meilisearch, Pino.
- Layout: `elkjs`. MCP: `@modelcontextprotocol/sdk`. LLM: `ai` + provider packages.

## Conventions

- **ESM only.** All imports of local files use extensionless paths resolved by the
  bundler/tsc `Bundler` resolution; package entry points are `src/index.ts` in dev and
  `dist/index.js` when built.
- **Result type, not exceptions**, for domain failures: `Result<T, E>` from
  `@syntrix/shared`. Throw only for programmer error.
- Every validation error carries `code`, `message`, `hint`, `elementIds` so the LLM can
  self-correct.
- IDs are generated in `@syntrix/shared` (`newId(prefix)`), deterministic in tests via an
  injectable id factory — never `Math.random()` inline.
- Pure functions in core: `apply(design, op)` is immutable; it returns a new `Design`.
- Naming: packages `@syntrix/*`; files kebab-case; types PascalCase; Zod schemas
  `camelCase` ending in `Schema`.
- Tests live next to source as `*.test.ts`; golden fixtures in `__fixtures__/`.

## How to run

```bash
pnpm install
pnpm build            # turbo build all packages
pnpm test             # vitest across the workspace
pnpm typecheck
pnpm lint
make dev              # docker compose dev stack (web on :3015)
```

Services (docker compose): proxy 3015, web 3016, api 3017, mcp 3018, kicad 3019,
sim 3020, freerouting 3021, pytools 3022, meilisearch 7700, plus mongo/redis/minio.

## Working agreement

- Commit after each task with **conventional commits**. Run tests before each commit.
- Update `docs/PROGRESS.md` after every completed task and before every commit.
- A milestone is done only when its exit criteria pass via an automated test or a
  documented manual script in `docs/ACCEPTANCE.md`.
- Record every non-obvious technical choice as an ADR in `docs/DECISIONS.md`.
