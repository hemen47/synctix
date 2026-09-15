# SYNTRIX

Agentic, AI-native web EDA: schematic → simulation → PCB.

An LLM agent, a browser editor, a REST API and an MCP server all drive **one canonical
engine**. The design document is tscircuit [`circuit-json`](https://github.com/tscircuit/circuit-json),
so anything SYNTRIX produces is readable by the whole tscircuit toolchain — and exportable
to KiCad, LTspice, SPICE, Gerber and BOM/PnP.

SYNTRIX is built **on** tscircuit, not beside it: rendering, autorouting, simulation,
footprints and fabrication export come from tscircuit packages. What we add is the
graphical editor, persistence and the operation log, a provider-agnostic agent, MCP
tools, a curated parts library, ELK schematic layout, and an LTspice exporter.

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

No Docker needed. You need Node 20+, pnpm, and a MongoDB (or none — see below).

```bash
pnpm install
make env        # writes .env — check MONGO_URL, fill in SYNTRIX_API_KEY
pnpm dev        # web on http://localhost:3016, api on :3017
```

Unset `MONGO_URL` to run with an in-memory store and no database at all.

Full detail, including the Atlas DNS caveat and what to do about a
`3221226505` crash on Windows, is in **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**.

With Docker, for something closer to production:

```bash
make dev                   # proxy, web, api — http://localhost:3015
make dev PROFILES=mongo    # add a containerised database
```

## Layout

```
packages/  shared core parts layout export sim agent ui-canvas
apps/      web api          (api also serves MCP and runs the job queue in-process)
services/  kicad            (optional profile: a FastAPI wrapper around kicad-cli)
docs/      architecture, decisions, progress, acceptance, migration
```

## Documentation

| Document                                     | What it covers                                       |
| -------------------------------------------- | ---------------------------------------------------- |
| [CLAUDE.md](CLAUDE.md)                       | Project rules, conventions, how to run and test      |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)   | Running it locally, MongoDB setup, troubleshooting   |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the system fits together and why                 |
| [docs/ROADMAP.md](docs/ROADMAP.md)           | Milestones M0'–M9 with exit criteria                 |
| [docs/PROGRESS.md](docs/PROGRESS.md)         | Current state — read this first                      |
| [docs/DECISIONS.md](docs/DECISIONS.md)       | ADRs, including where reality differed from the plan |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)     | How each milestone is verified                       |
| [docs/MIGRATION_V2.md](docs/MIGRATION_V2.md) | The v1 → v2 audit: what was kept, adapted, removed   |

## Status

Early. The engine, the parts layer and schematic layout are in; the v2 re-architecture
(M0') is landing. See [docs/PROGRESS.md](docs/PROGRESS.md) for the current task and what
is next.
