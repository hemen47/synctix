# ROADMAP

A milestone is **done** only when its exit criteria pass via an automated test or a
documented manual script in `ACCEPTANCE.md`. Tick progress in `PROGRESS.md`.

| #   | Milestone   | Exit criteria                                                                                                                                                    |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0  | Scaffold    | `docker compose up` serves web on :3015; api health endpoint green; every service exposes a health endpoint                                                      |
| M1  | Core        | 90% line coverage on `@syntrix/core`; circuit-json conformance tests pass; `rc_lowpass` round-trips through operations                                           |
| M2  | Parts T0+T1 | search `"3.3V LDO SOT-223"` returns AMS1117-3.3 with a **verified** footprint                                                                                    |
| M3  | Layout      | all fixtures lay out with no overlapping symbols; snapshot tests stable                                                                                          |
| M4  | Editor      | Playwright: place R and C, wire them, undo, export SVG                                                                                                           |
| M5  | Export      | LTspice `.asc` parses under a written parser test; kicad service ERC passes on exported `.kicad_sch` for all fixtures                                            |
| M6  | Simulation  | `rc_lowpass` -3 dB within 5%; op-amp gain within 2%                                                                                                              |
| M7  | Agent       | scripted eval suite of 10 prompts, at least 8 pass ERC plus expected sim metric, under MockProvider replay and under a live provider when a key is present       |
| M8  | Parts T2    | importing an LCSC part end-to-end yields symbol + footprint + 3D; KiCad library import works                                                                     |
| M9  | MCP         | MCP inspector lists tools; a circuit can be created end-to-end over MCP                                                                                          |
| M10 | PCB         | `pcb_board` + placement constraints + DSN to Freerouting to SES yields `pcb_trace`; Gerber export; `kicad-cli` DRC passes on a 2-layer `ams1117_regulator` board |

## Checkpoints

- **CHECKPOINT A** — after ARCHITECTURE.md, interfaces and PROGRESS.md, before code.
- **CHECKPOINT B** — after M7, summarising agent eval results, before M8 to M10.

## Golden fixtures

Four circuits carried through core, layout, export and simulation tests:

- `rc_lowpass` — resistor + capacitor, AC analysis, -3 dB verification
- `opamp_inverting` — op-amp gain stage, gain verification
- `ams1117_regulator` — LDO with input/output caps, the PCB and DRC fixture
- `ne555_blinker` — timer, transient analysis, the "real IC with a pinout" fixture
