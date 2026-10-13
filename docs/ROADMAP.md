# ROADMAP (v2)

A milestone is **done** only when its exit criteria pass via an automated test or a
documented manual script in `ACCEPTANCE.md`. Tick progress in `PROGRESS.md`.
`MIGRATION_V2.md` records what the v1 roadmap left behind and why.

| #   | Milestone    | Exit criteria                                                                                                                                                                                         |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0' | Migration    | `MIGRATION_V2.md` written; obsolete apps and services removed; the stack runs as one process on one port (:3015) with no containers — revised by ADR-0029; all existing tests green                   |
| M1' | Core v2      | `manualEdits`, TSX compile + merge and `ejectToTsx` added; conformance tests including a `circuit-to-svg` render; ≥90% coverage on `@syntrix/core`                                                    |
| M2' | Parts v2     | Mongo text-index store behind `PartsIndex`; search `"3.3V LDO SOT-223"` returns AMS1117-3.3 with a **verified** footprint                                                                             |
| M3  | Layout       | all fixtures lay out with no overlapping symbols; snapshot tests stable; `manualEdits` win over automatic placement                                                                                   |
| M4  | Editor       | Playwright: place R and C from the palette, wire them, drag (manualEdits persisted), undo, export SVG; PCB and 3D tabs render via runframe                                                            |
| M5  | Export + Sim | LTspice `.asc` parses under a written parser test; KiCad export opens and parses; `rc_lowpass` −3 dB within 5% and op-amp gain within 2% via WASM ngspice                                             |
| M6  | Agent        | 10-prompt eval suite mixing TSX and operations mode, ≥8 pass ERC plus the expected sim metric, under MockProvider replay and under a live provider when a key is present; provider-switch test passes |
| M7  | Parts T2     | importing an LCSC part end-to-end yields symbol + footprint + 3D; KiCad library import works; the DigiKey adapter works with keys and reports `disabled` without                                      |
| M8  | MCP          | the MCP inspector lists every tool over `/mcp` and stdio; a circuit can be created end-to-end from an external MCP client                                                                             |
| M9  | PCB          | `pcb_board` + placement constraints routed by tscircuit's autorouter into `pcb_trace`; Gerber export; DSN export as an escape hatch; `kicad-cli` DRC passes on a 2-layer `ams1117_regulator`          |

## Checkpoints

- **CHECKPOINT A** — after `MIGRATION_V2.md` and the CLAUDE.md/PROGRESS.md rewrite,
  before deleting anything. _(reached 2026-09-14)_
- **CHECKPOINT B** — after M6, summarising agent eval and provider-switch results,
  before M7 to M9.

## Golden fixtures

Four circuits carried through core, layout, export and simulation tests:

- `rc_lowpass` — resistor + capacitor, AC analysis, −3 dB verification
- `opamp_inverting` — op-amp gain stage, gain verification
- `ams1117_regulator` — LDO with input/output caps, the PCB and DRC fixture
- `ne555_blinker` — timer, transient analysis, the "real IC with a pinout" fixture
