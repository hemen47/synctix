# SYNTRIX

Agentic, AI-native web EDA: schematic → simulation → PCB.

An LLM agent, a browser editor, a REST API and an MCP server all drive **one canonical
engine**. The design document is tscircuit [`circuit-json`](https://github.com/tscircuit/circuit-json),
so anything SYNTRIX produces is readable by the whole tscircuit toolchain — and exportable
to KiCad, LTspice, SPICE, Gerber and BOM/PnP.

## What makes it different

- **The LLM never writes coordinates or files.** It submits typed Operations that the
  engine validates, or semantic placement hints that layout algorithms turn into geometry.
- **Every change is an event.** The Operation log is append-only; undo, redo, replay and
  agent audit all fall out of it.
- **Errors are written for a model to read.** Every validation failure carries a `hint`,
  so a rejected tool call becomes a self-correcting agent rather than a dead end.
- **Parts are first-class.** Symbol, footprint, pinout, SPICE model, licence and
  provenance per part — with footprints explicitly marked verified or unverified.

## Quick start

```bash
pnpm install
make env        # writes .env — fill in the secrets it names
make dev        # full stack; web on http://localhost:3015
make health     # probe every service
```

Without Docker, for engine work alone:

```bash
pnpm -r test:run
pnpm -r typecheck
```

## Layout

```
packages/  shared core parts layout export sim agent pcb ui-canvas
apps/      web api mcp worker
services/  kicad sim pytools freerouting   (Dockerised native tools)
docs/      architecture, decisions, progress, acceptance
```

## Documentation

| Document                                     | What it covers                                       |
| -------------------------------------------- | ---------------------------------------------------- |
| [CLAUDE.md](CLAUDE.md)                       | Project rules, conventions, how to run and test      |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the system fits together and why                 |
| [docs/ROADMAP.md](docs/ROADMAP.md)           | Milestones M0–M10 with exit criteria                 |
| [docs/PROGRESS.md](docs/PROGRESS.md)         | Current state — read this first                      |
| [docs/DECISIONS.md](docs/DECISIONS.md)       | ADRs, including where reality differed from the plan |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)     | How each milestone is verified                       |

## Status

Early. M0 (scaffold) is landing; see [docs/PROGRESS.md](docs/PROGRESS.md) for the current
task and what is next.
