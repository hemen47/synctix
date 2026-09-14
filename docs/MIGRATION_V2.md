# MIGRATION_V2 — audit of the v1 repository against the v2 architecture

**Written:** 2026-09-14 · **Rulebook:** v2 prompt §12 · **Status:** CHECKPOINT A

v1 delivered M0 (scaffold), M1 (core engine), M2 (parts T0) and — uncommitted on
`master` at the time of writing — M3 (ELK layout). v2 keeps all of that and changes four
things:

1. **Build on tscircuit, not beside it.** Rendering, autorouting, simulation, footprints
   and fabrication export come from tscircuit packages. We build only the graphical
   editor, persistence + operation log, the provider-agnostic agent, MCP tools, the
   curated parts library, ELK schematic layout and the LTspice exporter.
2. **`manualEdits` becomes a first-class field of `Design`**, mirroring tscircuit's own
   manual-edits concept, replacing `meta[].layoutOverride`.
3. **Minimal infrastructure.** Four required compose services (`proxy`, `web`, `api`,
   `mongo`), three optional profiles (`kicad`, `indexing`, `search`). MCP is served from
   the api process; jobs run in-process; artifacts go to a local volume.
4. **No separate sim / freerouting / pytools runtimes.** WASM ngspice in a Worker or in
   Node; tscircuit's autorouter for PCB.

---

## Audit table

Verdicts: **KEEP** = unchanged · **ADAPT** = kept, reworked per the v2 section named ·
**REMOVE** = deleted from the tree (git history is preserved).

### packages/

| Item                 | Size                              | Verdict          | Why                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`    | 798 loc, 34 tests                 | **KEEP**         | Result, errors, `newId`, SI units, logger. §12 names it KEEP outright; nothing in it is infrastructure-coupled.                                                                                                                                                                                                                     |
| `packages/core`      | 3 787 loc, 108 tests, 94.3% lines | **ADAPT** (§4)   | Document model, 16 operations, reducer, ERC v1, `summarizeForLLM` and `merge_circuit_json` all survive. Add `manualEdits` to `Design`; migrate `meta[].layoutOverride` into it with a one-time script + test; add `compileTsx` / `mergeCompiled` over `@tscircuit/eval`; add `ejectToTsx`; add a `circuit-to-svg` conformance test. |
| `packages/parts`     | 2 044 loc, 41 tests               | **ADAPT** (§5)   | T0 catalog (34 parts), footprint resolver over `@tscircuit/footprinter`, `verifyPinMapping`, `PartsSource` registry and federated search all survive. Add the Mongo-backed T1 store with a text index behind a `PartsIndex` interface; Meilisearch becomes an adapter under the `search` profile only.                              |
| `packages/layout`    | 1 034 loc, 28 tests (uncommitted) | **ADAPT** (§6)   | `ElkLayoutStrategy`, conventions and registry are done and green. Change the override source from `meta[].layoutOverride` to `design.manualEdits`; keep the incremental-relayout and net-label behaviour. Commit as-is first so the migration is a reviewable diff.                                                                 |
| `packages/export`    | 44 loc skeleton                   | **ADAPT** (§7)   | Interface + registry stub only. Becomes a thin wrapper around tscircuit exporters plus the two we own: `ltspice-asc` and `eject-to-tsx`. No v1 code to throw away.                                                                                                                                                                  |
| `packages/sim`       | 88 loc skeleton                   | **ADAPT** (§8)   | `Simulator` interface stub only. The implementation target changes from a `sim` HTTP service to `TscircuitNgspiceSimulator` (WASM in a Worker / in Node). ADR-0004 is superseded.                                                                                                                                                   |
| `packages/agent`     | 87 loc skeleton                   | **ADAPT** (§9)   | Tool-definition stub only. Gains the tscircuit-skill prompt base, `generate_tsx_circuit`, role routing and MockProvider replay tests.                                                                                                                                                                                               |
| `packages/ui-canvas` | 1 loc placeholder                 | **KEEP** (empty) | Still in the v2 layout (§3). Nothing to migrate; it is filled at M4.                                                                                                                                                                                                                                                                |
| `packages/pcb`       | 1 loc placeholder                 | **REMOVE**       | §12 removes it explicitly. PCB helpers land in `core`/`layout` at M9; the placeholder holds no code.                                                                                                                                                                                                                                |

### apps/ and services/

| Item                   | Size              | Verdict            | Why                                                                                                                                                                                                                           |
| ---------------------- | ----------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`             | 564 loc, 20 tests | **ADAPT** (§10)    | Express factory, api-key auth, problem+json and health probes survive. Gains designs/ops/agent/exports/parts routers, SSE, the `/mcp` Streamable HTTP route, the `stdio-mcp.ts` entry, and the in-process Mongo-backed queue. |
| `apps/web`             | 193 loc shell     | **ADAPT** (§10)    | The Vite + React shell renders the api health response. Gains the three-pane editor, the chat drawer and the runframe-backed PCB/3D tabs at M4.                                                                               |
| `apps/mcp`             | 76 loc            | **REMOVE**         | MCP now runs inside the api process (§2). The 76 loc are a server bootstrap with no tools; the stdio path becomes `apps/api/src/stdio-mcp.ts`.                                                                                |
| `apps/worker`          | 62 loc            | **REMOVE**         | Jobs run in-process in the api by default; the same handlers move to a BullMQ worker only under the `indexing` profile, which is written fresh at M7 rather than migrated.                                                    |
| `services/kicad`       | 311 loc FastAPI   | **KEEP** (profile) | The `kicad-cli` ERC/DRC/export wrapper is exactly what §2 asks for under the optional `kicad` profile. Only its compose entry changes.                                                                                        |
| `services/sim`         | 218 loc           | **REMOVE**         | Replaced by WASM ngspice in-process (§8). A native ngspice container is explicitly out.                                                                                                                                       |
| `services/freerouting` | 139 loc           | **REMOVE**         | Replaced by tscircuit's autorouter (§1, M9). This also retires the GPL-out-of-process argument in ADR-0006.                                                                                                                   |
| `services/pytools`     | 149 loc           | **REMOVE**         | §12 removes it; nothing depends on it.                                                                                                                                                                                        |

### Infrastructure and docs

| Item                                                      | Verdict                | Why                                                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml` (12 services)                        | **ADAPT**              | Reduce to `proxy`, `web`, `api`, `mongo` plus profiles `kicad`, `indexing` (redis + worker) and `search` (meilisearch). Drop `mcp`, `sim`, `freerouting`, `pytools`, `minio` and their volumes. |
| `docker-compose.dev.yml`                                  | **ADAPT**              | Same service set; bind mounts retained.                                                                                                                                                         |
| `Caddyfile`                                               | **ADAPT**              | Keep `:3015` → web and `/api` → api; add `/mcp` → api; drop the removed upstreams.                                                                                                              |
| `.env.example` / `.env`                                   | **ADAPT**              | Remove `MINIO_*`, `SIM_SERVICE_URL`, `FREEROUTING_*`, `PYTOOLS_*`, `MCP_PORT`. `REDIS_URL` and `MEILI_*` stay but are documented as profile-only. Add `ARTIFACTS_DIR=./data/artifacts`.         |
| `Makefile`, `.github/workflows`, `.husky`, lint/TS config | **KEEP**               | Only the compose target list in the Makefile changes.                                                                                                                                           |
| `config/models.yaml`                                      | **KEEP**               | Already role→model (planner, executor, reviewer, embedder).                                                                                                                                     |
| `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`                 | **ADAPT**              | Rewritten to v2; ROADMAP is replaced by §11.                                                                                                                                                    |
| `docs/DECISIONS.md`                                       | **KEEP** (append-only) | ADR-0004 (eecircuit-engine) and the ADR-0006 Freerouting consequence are superseded by new ADRs rather than edited.                                                                             |
| `docs/PROGRESS.md`, `CLAUDE.md`                           | **ADAPT**              | Rewritten in this checkpoint.                                                                                                                                                                   |
| `docs/ACCEPTANCE.md`                                      | **KEEP**               | Manual scripts stay; the M0 script is rewritten for the 4-service stack.                                                                                                                        |
| Missing docs                                              | **ADD**                | `DESIGN_MODEL.md`, `OPERATIONS.md`, `PARTS.md`, `EXPORTERS.md`, `AGENT.md`, `SIMULATION.md`, `MCP.md`, `DEPLOY_VPS.md` — written as their milestones land.                                      |

---

## Verified during the audit (feeds new ADRs)

- `@tscircuit/runframe@0.0.2725` exists — the viewer for the PCB/3D tabs. The v1
  `@tscircuit/schematic-viewer` / `@tscircuit/pcb-viewer` pins are superseded by it.
- **`jlcsearch` is not an npm package.** It is a hosted API (`jlcsearch.tscircuit.com`).
  The published parts-search package is `@tscircuit/parts-engine@0.0.32`. The M7
  `LcscEasyEdaSource` adapter targets that plus the HTTP endpoint, not a `jlcsearch`
  import.
- **There is no `@tscircuit/autorouting` package.** `@tscircuit/core` routes through
  `@tscircuit/infgrid-ijump-astar@0.0.35` and `@tscircuit/capacity-autorouter@0.0.905`;
  the former is already in our pinned dependency closure (ADR-0006).
- `@openrouter/ai-sdk-provider@3.0.0`, `ollama-ai-provider@1.2.0`,
  `@modelcontextprotocol/sdk@1.30.0` and `elkjs@0.12.0` all resolve.
- All 17 packages from ADR-0005 still resolve. `easyeda-converter` is still at `0.0.2`
  and still needs verification before M7.

## Carried-over open items

- **M0 acceptance is still unverified** — Docker Desktop was not running on the dev
  machine. The v2 M0' exit criterion (a 4-service `docker compose up`, web on :3015) is
  materially easier to hit than the v1 12-service one, and it is the first thing checked
  after the compose rewrite.
- **`@tscircuit/eval` sandboxing** — it runs under Node 24 (ADR-0007). Whether it
  isolates untrusted LLM-authored TSX is decided at M1', now that there is no worker
  container to hide in.
