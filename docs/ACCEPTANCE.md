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
90%, branches 80% — see ADR-0008) — the run fails below them, so the criterion cannot
silently rot.

**Achieved:** 94.3% lines, 94.9% functions, 81.0% branches, across 108 tests.

**Conformance.** `validateCircuit` parses every element through circuit-json's
`any_circuit_element`, a strict discriminated union. `apply.test.ts` asserts conformance
after operations that write to the sidecar, which is what proves principle 2 holds: no
non-spec field ever enters the element array.

**rc_lowpass round-trip.** `src/__fixtures__/rc-lowpass.ts` defines the circuit as
operations, not as a circuit-json blob, so building it exercises the same path the agent
and the UI use. The suite asserts that it:

1. conforms to circuit-json,
2. produces the expected components and nets,
3. yields the right electrical connectivity (R1.2 and C1.1 are one node via VOUT; C1.2 is
   not),
4. survives a serialise/reload cycle,
5. and produces a byte-identical document whether applied one operation at a time or as a
   single atomic batch.

---

## M2 — Parts T0 + T1

**Exit criteria:** searching `"3.3V LDO SOT-223"` returns AMS1117-3.3 with a verified
footprint.

```bash
pnpm --filter @syntrix/parts test:run
```

The criterion is a test, not a manual check — `parts.test.ts` asserts that the top result
for that exact query is AMS1117-3.3, that its footprint is marked verified, that its
package is SOT-223, that it outputs 3.3 V, **and** that the footprint it claims actually
resolves to a land pattern with the right pad count. Claiming verification without
resolving the geometry would make the flag meaningless.

Search runs with no services up, so this passes in CI without a container. Meilisearch
indexes the same ranking rules for T1 at scale rather than defining its own relevance.

**Catalog integrity is also gated.** One test resolves every T0 part's footprint and
checks its pad count against its declared pin count. It found five real defects when
first run, each of which would have produced an unbuildable board:

| Part               | Defect                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------- |
| AMS1117-3.3        | 3 pins declared against a 4-pad SOT-223 — the thermal tab (bonded to VOUT) was missing |
| LM1117-3.3         | same                                                                                   |
| CH340G             | 6 of 16 pins declared, leaving 10 SOIC-16 pads with no net                             |
| Generic op-amp     | 5-pin symbol claiming a SOIC-8 footprint it has no business committing to              |
| Tactile pushbutton | 2 pins declared against 4 pads — the two internally bridged pairs                      |

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
