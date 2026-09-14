# SYNTRIX Architecture

## 1. The shape of the system

SYNTRIX is a **single engine with thin clients**. Everything that can change a design —
a mouse drag in the browser, a REST call, an LLM tool call, an MCP request — is expressed
as a typed **Operation** and applied by `@syntrix/core`. There is exactly one code path
from intent to document.

```
   Web UI        REST API        LLM Agent        MCP Server
      \             |               |               /
       +------------+-------+-------+--------------+
                            |
                    Operation (Zod-validated)
                            |
                      @syntrix/core
          apply(design, op): Result<Design, ValidationError[]>
                            |
                  +---------+----------+
                  |                    |
          Operation log           Design snapshot
       (append-only, Mongo)      (derived, cached)
                  |
        undo / redo / replay / agent audit
```

The clients hold no domain logic. A feature added to core is immediately available to all
four surfaces; a client that wants something core cannot express must add an Operation,
not a side door.

## 2. The document

```ts
type Design = {
  id: string
  version: number // optimistic concurrency
  circuit: AnyCircuitElement[] // spec-conformant circuit-json, flat
  meta: Record<string, MetaEntry> // sidecar, keyed by element id
  manualEdits: ManualEdits // placements the user dragged, keyed by component
}
```

`circuit` is **pure tscircuit circuit-json** — every element is parsed through the
`circuit-json` package's `any_circuit_element` union, which is a strict discriminated
union on `type` (ADR-0003). That strictness is the feature: it is impossible to smuggle a
non-spec field into the document, so anything we export is by construction something the
whole tscircuit toolchain can read.

Everything we need that the spec does not model goes in `meta`: placement constraints,
part provenance, agent notes, footprint verification status. The sidecar travels with the
design and is stripped on export.

`manualEdits` is separate from `meta` because it is not ours: it mirrors tscircuit's own
manual-edits concept (schematic and PCB placements keyed by `source_component_id`), so it
round-trips through the tscircuit toolchain rather than being a private convention. It
always wins over automatic layout.

Because a flat array is the wrong shape for most questions ("what is connected to this
pin?"), core maintains an **indexed view** beside it — maps from id to element, component
to ports, port to traces, net to ports — rebuilt incrementally as operations land. Reads
go through the index; the array stays canonical.

## 3. Operations

A Zod discriminated union: `add_component`, `remove_component`, `set_prop`, `rename`,
`connect`, `disconnect`, `create_net`, `rename_net`, `add_net_label`, `add_power_symbol`,
`place_hint`, `move_component`, `batch`, `merge_circuit_json`.

`apply` is **pure and immutable**. It never throws for domain failure; it returns
`Result<Design, ValidationError[]>`, and each error carries `code`, `message`, `hint` and
`elementIds`. The `hint` field is written for an LLM reader — "pin 3 of U1 is already
connected to net VCC; disconnect it first or connect to that net instead" — which is what
turns a failed tool call into a self-correcting agent rather than a dead end.

Two operations deserve note:

- `merge_circuit_json` is how **TSX mode** lands. The LLM writes a tscircuit `<board>`
  snippet, `@tscircuit/eval` evaluates it in a sandbox to circuit-json, and the result
  enters through this single validated door with a merge strategy. TSX mode is therefore
  not a second engine — it is one operation.
- `move_component` is reserved for the user and the layout engine. The LLM cannot call
  it; it gets `place_hint` instead, which records intent ("keep C1 close to U1's VCC
  pin") and lets the layout algorithm produce coordinates. This is principle 4 made
  mechanical.

## 4. Event sourcing

The Operation log is append-only in Mongo. Snapshots are derived and cached, never
authoritative. Undo is not a special mechanism — it is a replay to `n-1`, and redo a
replay forward. The same log is the agent audit trail: every coordinate in a design is
traceable to the operation, and the agent turn, that produced it.

## 5. Package map

| Package              | Responsibility                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `@syntrix/shared`    | `Result`, id generation, SI unit parsing, logger, error taxonomy                                 |
| `@syntrix/core`      | document store, indexed views, Operations, reducer, undo/redo, ERC, `summarizeForLLM`, TSX merge |
| `@syntrix/parts`     | `PartDefinition`, T0 generic catalog, `PartsSource` registry, footprint resolution, pin mapping  |
| `@syntrix/layout`    | `LayoutStrategy`, `ElkLayoutStrategy`, schematic conventions, override merge                     |
| `@syntrix/export`    | exporter registry wrapping the tscircuit exporters, plus ltspice-asc and eject-to-tsx            |
| `@syntrix/sim`       | `Simulator` interface, WASM ngspice in Worker and Node, netlist builder, result summarizer       |
| `@syntrix/agent`     | tool definitions, role-to-model routing, `AgentLoop`, prompts (incl. the tscircuit skill)        |
| `@syntrix/ui-canvas` | framework-agnostic SVG scene graph and hit testing                                               |

Apps: `web` (Vite/React) and `api` (Express + MCP + the in-process job queue) — one Node
runtime for all app code. The only service is the optional `kicad` profile, a FastAPI
wrapper around `kicad-cli`.

Dependency direction is strictly downward: `shared` then `core`, then `parts` / `layout` /
`export` / `sim`, then `agent`, then apps. Core depends on no sibling package except
`shared`.

## 6. Plugin registries

Six extension points, one pattern: an interface, a registry keyed by id, and registration
at app startup.

```ts
interface Exporter {
  id: string
  label: string
  ext: string
  mime: string
  export(design: Design): Promise<Artifact[]>
}
interface Simulator {
  capabilities: SimCapabilities
  run(netlist: string, analysis: Analysis): Promise<SimResult>
}
interface LayoutStrategy {
  id: string
  layout(design: Design, opts: LayoutOptions): Promise<LayoutResult>
}
interface PartsSource {
  id: string
  status(): "ready" | "disabled"
  search(q: string, filters: PartFilters): Promise<PartSummary[]>
  fetch(sku: string): Promise<PartDefinition>
}
```

A `PartsSource` whose API key is absent reports `disabled` and is skipped — a missing
DigiKey key must never crash a search. That is why `status()` is on the interface rather
than inferred from a thrown error.

## 7. Geometry

The LLM never produces coordinates. `@syntrix/layout` wraps **elkjs**: components become
nodes with fixed port sides (inputs west, outputs east, power north, ground south,
passives inline), edges route orthogonally and become `schematic_trace` elements with
junctions. Power nets get net labels instead of long wires, because a schematic with a
wire from every IC to a distant VCC rail is technically correct and unreadable.

Manual edits always win: a user drag writes `move_component`, which records the placement
in `design.manualEdits`, and relayout preserves it. Relayout is incremental — only
elements without positions move.

PCB routing is not ours. tscircuit's autorouter, reached through `@tscircuit/core`,
produces `pcb_trace` elements; we contribute board outline, placement and constraints.

## 8. Parts

Three tiers. **T0** is a generic catalog in code (R, C, L, diodes, transistors, common
ICs, connectors, power symbols) — always available, no network, no database. **T1** is a
curated set in Mongo with a text index over mpn, description, category and package, plus
structured electrical fields for filtering — behind a `PartsIndex` interface, so the
optional `search` profile swaps in Meilisearch without touching a caller. **T2** is
federated: adapters for LCSC/EasyEDA, KiCad libraries, DigiKey, Nexar and Mouser, with
results cached and promotable into T1.

Every part records `license` and `provenance`, and every footprint records
`verification: "verified" | "unverified"`. The agent's house rules prefer verified
footprints — an unverified footprint is a board that does not fit its parts, which is the
most expensive failure mode in this domain.

## 9. Simulation

`circuit-json-to-spice` builds the netlist; `@syntrix/sim` injects SPICE models from the
parts layer and appends analysis cards. ngspice runs as WASM — in a Web Worker in the
browser and in-process in Node on the server — the same engine tscircuit itself uses.
There is no native ngspice service.

**The LLM never sees raw waveform vectors.** `summarizeSimResult` reduces a run to node
voltages, min/max/RMS, -3 dB point, rise time and overshoot; full vectors are written to
`./data/artifacts/sim/<id>.json` and referenced by id. A transient analysis is megabytes of numbers, and a context window
is not a data store.

## 10. Agent

The agent is a loop over core's Operations, not a code generator. Tools mirror the
Operation set plus parts search, ERC, simulation and export. Roles (planner, executor,
reviewer, embedder) map to models through `config/models.yaml`, and all provider access
goes through the Vercel AI SDK — switching from OpenRouter to a local Ollama model is a
yaml edit.

Two loop invariants: the agent **must run ERC before finishing**, and must simulate when
the request was about behaviour rather than structure. Trace events stream to the UI over
SSE so the user watches the reasoning rather than a spinner.

## 11. Deployment

Docker Compose behind Caddy on port 3015, which terminates TLS and routes `/` to web and
both `/api` and `/mcp` to the api process.

**Four required services**: `proxy`, `web`, `api`, `mongo`. Everything else is an opt-in
profile — `kicad` (a FastAPI wrapper around `kicad-cli`, so the Node process never shells
out to a binary it cannot version), `indexing` (Redis plus a BullMQ worker running the
same job handlers the api runs in-process), and `search` (Meilisearch). Artifacts are a
local volume. A stack with no profile running is fully functional and reports `ok`.
