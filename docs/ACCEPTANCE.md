# Acceptance

How each milestone's exit criteria are verified. A milestone is done only when its entry
here passes — either as an automated test that CI runs, or as a manual script someone can
follow and get the stated result.

Automated checks are the default. A manual script is only acceptable where the check
needs Docker, a native binary, or a paid API key that CI does not have.

---

## M0' — Migration

**Exit criteria:** `docs/MIGRATION_V2.md` written; obsolete apps and services removed;
compose has exactly four required services plus three optional profiles;
`docker compose up` serves the web app on :3015 with api and mongo healthy; all existing
tests still green.

### Automated

```bash
pnpm -r typecheck && pnpm -r test:run
docker compose config --services            # must print exactly: proxy web api mongo
docker compose --profile kicad --profile indexing --profile search config --quiet
```

`apps/api/src/health.test.ts` covers the health contract: per-dependency probing, the
roll-up rules (down vs degraded vs disabled), that `/health` needs no API key, that
`/live` never touches a dependency, that a partially-down stack still answers 200, and
that the bare four-service stack reports `ok` rather than `degraded` — an absent profile
is a choice, not a fault.

CI's `compose` job renders both files with `docker compose config`, which catches YAML
errors, bad anchors and undefined required variables before they reach a VPS.

### Manual

```bash
make env          # writes .env from .env.example
# fill in SYNTRIX_API_KEY and MCP_BEARER_TOKEN — nothing else is required
make dev          # builds and starts the four required services
make health       # probes proxy, web and api
```

**Pass when:**

1. `docker compose config --services` prints exactly `proxy`, `web`, `api`, `mongo`.
2. `http://localhost:3015` loads the SYNTRIX shell and the status pill reads `ok`.
3. `make health` exits 0 and prints every checked service as `up`.
4. `curl -s localhost:3015/api/health | jq .status` prints `"ok"` with both HTTP
   dependencies reported `disabled` (no profiles running).
5. `docker compose ps` shows `api` and `mongo` healthy.

**Optional profiles.** Each is verified separately, and only when it is needed:

```bash
make dev PROFILES=kicad        # the KiCad 9 image is several GB; first build is slow
bash scripts/health-check.sh --profiles kicad
```

---

## M1' — Core v2

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

## M2' — Parts v2

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

**Exit criteria:** Playwright places an R and a C from the palette, wires them, drags one
(with the placement persisted as a manual edit), undoes, and exports SVG.

```bash
pnpm e2e                 # playwright test — starts the api and web dev servers itself
pnpm --filter @syntrix/ui-canvas test:run
```

Nine Playwright tests cover the criterion and the seams around it: placing from the
palette, wiring pin to pin, dragging and then **reloading the page** to prove the
placement was written to `manualEdits` on the server rather than held in the browser,
undo/redo by button and by Ctrl+Z, Delete, SVG export, and ERC.

The geometry underneath — hit testing, snapping, the editor state machine — is covered by
42 unit tests in `@syntrix/ui-canvas` with no DOM at all. The split is deliberate: a
browser test that failed on a wrong hit-test tie-break would point at a click that did
nothing, which is the hardest possible way to find that bug. (It is also how that bug was
actually found; see "Bugs the tests found" in PROGRESS.md.)

The api runs with its in-memory store, which is the same path a development stack with no
`MONGO_URL` takes — a supported configuration, not a test-only one.

**PCB and 3D tabs** are deferred to M9 with the rest of the PCB layer.

---

## M5 — Export + Simulation

**Exit criteria:** the LTspice `.asc` output parses under a written parser test; the
KiCad export opens and passes `kicad-cli sch erc` when the `kicad` profile is up;
`rc_lowpass` −3 dB within 5% of theory.

```bash
pnpm --filter @syntrix/export test:run
pnpm --filter @syntrix/sim test:run
```

**LTspice.** `ltspice-parser.ts` is a real parser for the subset the exporter writes, and
the tests interrogate what it returns rather than grepping the output. That is what
catches SYMATTRs drifting onto the wrong symbol — the one piece of state in the format,
and the one thing a substring check passes straight through.

**Simulation.** The −3 dB corner is checked against 1/(2πRC) rather than against a
recorded number, so a regression in the engine, in the netlist, or in the measurement all
show up, and a golden file that was wrong from the start cannot bless itself. Measured:
**0.74% error**, against a 5% budget (ADR-0019). Transient rise time is checked against
the 2.2τ identity.

### Deferred, with reasons

- **`kicad-cli sch erc`** needs the `kicad` compose profile, which needs the Docker
  daemon — unavailable on this machine (see PROGRESS.md → Blocked). The export itself is
  verified: the schematic parses as `(kicad_sch …)` and is produced for a design with no
  board layer, which is the normal case before M9. To run it:

  ```bash
  make dev PROFILES=kicad
  curl -F file=@design.kicad_sch localhost:3019/sch/erc
  ```

- **Op-amp gain within 2%** moves to M6. Core deliberately knows only enough pin data to
  build an element from a bare ftype — `simple_op_amp` has no factory there, and real
  pinouts live in `@syntrix/parts` behind a resolver. The fixture therefore needs the
  parts path that the agent uses anyway, and the measurement harness (`summarizeSimResult`
  and the closed-form comparison) is already in place and passing for the RC criterion.

---

## M6 — Agent

**Exit criteria:** a 10-prompt eval suite mixing TSX mode and operations mode, at least 8
passing ERC plus the expected simulation metric, under MockProvider replay and under a
live provider when a key is present; and a provider-switch test (OpenRouter → Anthropic
by environment variable alone) that passes.

_Added at M6._

---

## M7 — Parts T2

**Exit criteria:** importing an LCSC part end to end yields symbol, footprint and 3D
model; KiCad library import works.

_Added at M7._

---

## M8 — MCP

**Exit criteria:** the MCP inspector lists every tool over both `/mcp` (Streamable HTTP,
served by the api) and the stdio entry point; a circuit can be created end to end from an
external MCP client.

_Added at M8._

---

## M9 — PCB

**Exit criteria:** `pcb_board` plus placement constraints routed by tscircuit's
autorouter into `pcb_trace`; Gerber export; DSN export as an escape hatch; `kicad-cli`
DRC passes on a 2-layer `ams1117_regulator` when the `kicad` profile is up.

_Added at M9._
