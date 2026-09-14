# Acceptance

How each milestone's exit criteria are verified. A milestone is done only when its entry
here passes — either as an automated test that CI runs, or as a manual script someone can
follow and get the stated result.

Automated checks are the default. A manual script is only acceptable where the check
needs Docker, a native binary, or a paid API key that CI does not have.

---

## M0 — Scaffold

**Exit criteria:** `docker compose up` serves the web app on :3015; the API health
endpoint is green; every service exposes a health endpoint.

### Automated

```bash
pnpm --filter @syntrix/api test:run
```

`apps/api/src/health.test.ts` covers the health contract: per-dependency probing, the
roll-up rules (down vs degraded vs unknown), that `/health` needs no API key, that
`/live` never touches a dependency, and that a partially-down stack still answers 200.

```bash
pnpm -r typecheck && pnpm -r test:run
```

### Manual

```bash
make env          # writes .env from .env.example
# fill in MEILI_MASTER_KEY, MINIO_SECRET_KEY, SYNTRIX_API_KEY, MCP_BEARER_TOKEN
make dev          # builds and starts the full stack
make health       # probes every service
```

**Pass when:**

1. `http://localhost:3015` loads the SYNTRIX shell and the status pill reads `ok`.
2. The stack-status table lists `kicad`, `sim`, `pytools`, `freerouting` and
   `meilisearch`, each `up`.
3. `make health` exits 0 and prints every service as `up`.
4. `curl -s localhost:3015/api/health | jq .status` prints `"ok"`.
5. `curl -s localhost:3015/mcp` returns 401 without a bearer token — the MCP surface is
   not open to the internet.

**Note on first run.** The `kicad` and `freerouting` images are large (KiCad 9 is several
GB, Freerouting pulls a JRE). The first `make dev` takes a long time and the compose
healthchecks have `start_period` set accordingly. A service reporting `starting` is not a
failure until its start period elapses.

---

## M1 — Core

**Exit criteria:** 90% coverage on `@syntrix/core`; circuit-json conformance tests pass;
`rc_lowpass` round-trips.

```bash
pnpm --filter @syntrix/core test:run --coverage
```

Thresholds are enforced in `packages/core/vitest.config.ts` (lines/functions/statements
90%, branches 85%) — the run fails below them, so the criterion cannot silently rot.

_Detail added as the milestone lands._

---

## M2 — Parts T0 + T1

**Exit criteria:** searching `"3.3V LDO SOT-223"` returns AMS1117-3.3 with a verified
footprint.

_Added at M2._

---

## M3 — Layout

**Exit criteria:** every fixture lays out with no overlapping symbols; snapshot tests are
stable.

_Added at M3._

---

## M4 — Editor

**Exit criteria:** Playwright places an R and a C, wires them, undoes, and exports SVG.

_Added at M4._

---

## M5 — Export

**Exit criteria:** the LTspice `.asc` output parses under a written parser test; the
`kicad` service's ERC passes on the exported `.kicad_sch` for all four fixtures.

_Added at M5._

---

## M6 — Simulation

**Exit criteria:** `rc_lowpass` -3 dB point within 5% of theory; op-amp gain within 2%.

_Added at M6._

---

## M7 — Agent

**Exit criteria:** a 10-prompt eval suite, at least 8 passing ERC plus the expected
simulation metric, under MockProvider replay and under a live provider when a key is
present.

_Added at M7._

---

## M8 — Parts T2

**Exit criteria:** importing an LCSC part end to end yields symbol, footprint and 3D
model; KiCad library import works.

_Added at M8._

---

## M9 — MCP

**Exit criteria:** the MCP inspector lists the tools; a circuit can be created end to end
over MCP.

_Added at M9._

---

## M10 — PCB

**Exit criteria:** `pcb_board` plus placement constraints, DSN → Freerouting → SES
yielding `pcb_trace`; Gerber export; `kicad-cli` DRC passes on a 2-layer
`ams1117_regulator`.

_Added at M10._
