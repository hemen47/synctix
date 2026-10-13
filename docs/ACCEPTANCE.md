# Acceptance

How each milestone's exit criteria are verified. A milestone is done only when its entry
here passes — either as an automated test that CI runs, or as a manual script someone can
follow and get the stated result.

Automated checks are the default. A manual script is only acceptable where the check needs
a browser, a native binary, or a paid API key that CI does not have. Nothing here needs
Docker any more — there is none (ADR-0029).

---

## M0′ — Migration

**Exit criteria:** `docs/MIGRATION_V2.md` written; obsolete apps and services removed; the
stack runs as one process on one port; all existing tests still green.

> Revised by ADR-0029. The original criteria were written against Docker Compose — four
> required services and three profiles — and are recorded in `MIGRATION_V2.md` as history.
> The compose stack never ran, and the audit that followed found nothing in it worth
> keeping. What replaces those criteria is below.

### Automated

```bash
pnpm -r typecheck && pnpm -r lint && pnpm -r test:run
pnpm build          # packages, the web bundle, then the server bundle
```

CI's `build` job then starts `node apps/api/dist/server.js` and asserts that one port
answers all three concerns — `/live`, `/health` and the SPA at `/`. That check replaces
the old image-build and `docker compose config` jobs: what matters is that the single
thing we ship actually boots and serves.

`apps/api/src/health.test.ts` covers the health contract: the roll-up rules (down vs
degraded vs disabled vs unknown), that an optional dependency can never take the stack
down, that a required one can, that `/health` needs no API key, and that `/live` never
touches a dependency.

### Manual

```bash
cp .env.example .env
# fill in SYNTRIX_API_KEY and MCP_BEARER_TOKEN — nothing else is required
pnpm install && pnpm dev
```

**Pass when:**

1. `http://localhost:3015` loads the SYNTRIX shell and the status pill reads `ok`.
2. `curl -s localhost:3015/api/health` reports `"status":"ok"` with `mongo` `up` — or
   `disabled`, if you are running without `MONGO_URL`.
3. `curl -s localhost:3015/live` prints `{"status":"ok"}`.
4. Ctrl+C leaves no process holding 3015 or 3016.
5. `pnpm build && pnpm start` serves the same app on 3015 from one process, with no Vite
   in the tree.

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
KiCad export opens and parses; `rc_lowpass` −3 dB within 5% of theory.

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

- **`kicad-cli sch erc`** is dropped rather than deferred. It needed the `kicad` service,
  and ADR-0029 removed it: nothing called it, and every export we ship is already pure
  TypeScript. The export itself is verified — the schematic parses as `(kicad_sch …)` and
  is produced for a design with no board layer, which is the normal case before M9.

  What `kicad-cli` uniquely offered was KiCad's own rule checks. Those are now work to do
  here, in TypeScript, alongside `packages/core/src/erc.ts` — see PROGRESS.md. Anyone who
  wants the real thing today can open the exported `.kicad_sch` in KiCad and run ERC.

- **Op-amp gain within 2%** moves to M6. Core deliberately knows only enough pin data to
  build an element from a bare ftype — `simple_op_amp` has no factory there, and real
  pinouts live in `@syntrix/parts` behind a resolver. The fixture therefore needs the
  parts path that the agent uses anyway, and the measurement harness (`summarizeSimResult`
  and the closed-form comparison) is already in place and passing for the RC criterion.

---

## M6 — Agent

**Exit criteria:** a 10-prompt eval suite, at least 8 passing; and a provider-switch test
(OpenRouter → Anthropic by environment variable alone) that passes.

```bash
pnpm --filter @syntrix/agent test:run
```

**Achieved: 10 of 10.** Each case asserts on the design that results rather than on the
model's prose — the design is the deliverable. Four of the ten are negative or recovery
cases (a rejected call that the agent works past; a part that does not exist and must not
be invented), because a suite where every prompt succeeds first time tests a path real use
will not stay on.

**Provider switch.** `SYNTRIX_MODEL_EXECUTOR=anthropic:claude-sonnet-4.5` moves a role to
another provider with no code change and no edit to `models.yaml`.

### What this does and does not prove

The suite runs under `createMockProvider`, replaying recorded turns: deterministic, free
and offline, so a change to a tool description or to the loop is caught without spending
money or depending on a provider being up. It proves the plumbing — a model asking for X
gets X, a rejection returns usefully, ERC always runs.

It cannot prove a real model _would_ ask for X. That is the live run, which needs a key:

```bash
OPENROUTER_API_KEY=... SYNTRIX_EVAL_LIVE=1 pnpm --filter @syntrix/agent test:run
```

Deferred here only because this machine has no key configured.

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
autorouter into `pcb_trace`; Gerber export; DSN export as an escape hatch. (The original
criterion also asked for `kicad-cli` DRC; that service is gone — ADR-0029 — and the check
is now TypeScript work, recorded in PROGRESS.md.)

_Added at M9._
