# Architecture Decision Records

Append-only. Each ADR records a choice that was not obvious, especially where a real
library API differed from the original specification.

---

## ADR-0001 — Node 24 runtime, `engines: >=20`

**Status:** accepted · 2026-09-14

The spec called for Node 20. The dev machine runs Node 24.14.0 LTS. Nothing in the stack
requires Node 20 specifically, and Node 24 is a current LTS line.

**Decision:** target `>=20` in `engines`, develop on 24, and pin Docker images to
`node:22-alpine` (the most widely available LTS base at build time) so CI, containers and
local dev stay within one compatible range.

---

## ADR-0002 — Pin zod to v3 workspace-wide

**Status:** accepted · 2026-09-14

**Context.** `circuit-json@0.0.491` is our document schema. Investigation of the shipped
artifact showed two things:

- `dist/index.mjs` imports `zod` as an **external** module, but `zod` appears in neither
  `dependencies` nor `peerDependencies` — it is an _undeclared peer_. Importing
  `circuit-json` without zod installed fails with `ERR_MODULE_NOT_FOUND`.
- `dist/index.d.mts` begins `import { z } from 'zod'` and the package was built against
  `zod@3`.

Zod 3 and Zod 4 have incompatible internal type shapes. Composing a v4 schema with a v3
schema object (e.g. `z.union([ourSchema, cj.source_component])`) fails to typecheck and
can fail at runtime.

**Decision.** Pin `zod@3.24.x` across the workspace and declare it an explicit dependency
of every package that imports it. Do not upgrade to zod 4 until `circuit-json` ships v4
types. Revisit if `circuit-json` declares a proper peer range.

**Consequence.** Zod-4-only features (`z.interface`, the new `z.output` inference,
top-level `z.core`) are unavailable. `zod-to-json-schema` (v3-compatible) is used for the
agent tool definitions rather than zod 4's built-in `z.toJSONSchema`.

---

## ADR-0003 — circuit-json facts verified against v0.0.491

**Status:** accepted · 2026-09-14

Verified empirically rather than from memory. These are the load-bearing facts:

- `any_circuit_element` is a **strict discriminated union on `type`**. An unknown `type`
  is rejected. This is what makes the §4 conformance requirement enforceable: every
  element core produces is parsed through it.
- **SI strings are parsed by the schema itself.** `source_simple_resistor.parse({...,
resistance: "10k"})` yields `resistance: 10000` (a number). Our own SI parser in
  `@syntrix/shared` therefore exists for _our_ props (spacing, board size, tolerances)
  and for pre-validation error messages — it must not double-convert values that
  circuit-json already normalises.
- `source_component` requires `{ type, source_component_id, name }` and carries `ftype`
  as the discriminator into the `source_simple_*` refinements.
- `source_port` requires `{ type, source_port_id, source_component_id, name,
pin_number }`.
- `source_net` requires `{ type, source_net_id, name, member_source_group_ids }` — the
  last is mandatory (use `[]`).
- `source_trace` requires `{ type, source_trace_id, connected_source_port_ids,
connected_source_net_ids }` — both arrays mandatory.
- `schematic_component` requires `{ type, schematic_component_id, source_component_id,
center, size }` and defaults `is_box_with_pins: true`.
- 28 `ftype` values exist (`simple_resistor`, `simple_capacitor`, `simple_chip`,
  `simple_op_amp`, `simple_mosfet`, `simple_ground`, `simple_power_source`, …). The parts
  layer maps every `PartDefinition` onto one of these.

**Consequence.** Core never invents element shapes; the `elementFactories` module builds
each element and immediately parses it through the matching `circuit-json` schema, so a
mismatch fails at construction with a precise error rather than at export time.

---

## ADR-0004 — Simulation engine: `eecircuit-engine`, not `@o.z/ngspice-wasm`

**Status:** provisional · 2026-09-14 · to be confirmed at M6

The spec named `@o.z/ngspice-wasm` "or equivalent". That package is published at version
`0.0.0`, which signals a placeholder. `eecircuit-engine@1.8.0` is the maintained
ngspice-WASM wrapper used by the tscircuit ecosystem itself.

**Decision.** Write `@syntrix/sim` against our own `Simulator` interface and implement
`NgspiceWasmSimulator` on top of `eecircuit-engine`. Because the engine sits behind the
interface (principle 5), swapping it later touches one file. Confirm the API against its
`.d.ts` at M6 before writing the adapter, and update this ADR with the outcome.

---

## ADR-0005 — All 17 tscircuit ecosystem packages verified to exist

**Status:** accepted · 2026-09-14

Resolved versions at project start: `circuit-json@0.0.491`, `@tscircuit/core@0.0.1909`,
`@tscircuit/eval@0.0.1402`, `circuit-to-svg@0.0.419`, `circuit-json-to-spice@0.0.46`,
`circuit-json-to-kicad@0.0.212`, `kicad-converter@0.0.17`, `kicad-mod-converter@0.0.30`,
`circuit-json-to-gerber@0.0.106`, `circuit-json-to-bom-csv@0.0.17`,
`circuit-json-to-pnp-csv@0.0.13`, `dsn-converter@0.0.92`, `@tscircuit/footprinter@0.0.426`,
`easyeda-converter@0.0.2`, `schematic-symbols@0.0.244`,
`@tscircuit/schematic-viewer@2.0.92`, `@tscircuit/pcb-viewer@1.11.394`.

No minimal replacement is needed up front. `easyeda-converter@0.0.2` is at a notably low
version for a package we depend on at M8 — its API is to be verified before the
`LcscEasyEdaSource` adapter is written, and a direct EasyEDA-JSON→circuit-json mapping is
the fallback.

**Note.** Every version above is pinned exactly in the relevant `package.json`. These are
0.0.x packages with no semver stability guarantee; unpinned ranges would make builds
irreproducible.

---

## ADR-0006 — tscircuit packages under-declare dependencies; pin the closure at the root

**Status:** accepted · 2026-09-14

**Context.** Getting `@tscircuit/eval` to run in Node required chasing a chain of
`ERR_MODULE_NOT_FOUND` failures. Each was a package imported at runtime but declared in
neither `dependencies` nor `peerDependencies` of the package importing it:

| Missing package                          | Imported by                      |
| ---------------------------------------- | -------------------------------- |
| `zod`                                    | `circuit-json`                   |
| `@tscircuit/soup-util`                   | `@tscircuit/infgrid-ijump-astar` |
| `calculate-elbow`                        | `@tscircuit/core`                |
| `@tscircuit/infer-cable-insertion-point` | `@tscircuit/core`                |
| `@tscircuit/copper-pour-solver`          | `@tscircuit/core`                |
| `@tscircuit/schematic-trace-solver`      | `@tscircuit/core`                |
| `connectivity-map`                       | `@tscircuit/core`                |
| `flatbush`                               | `@tscircuit/core`                |
| `@tscircuit/miniflex`                    | `@tscircuit/core`                |
| `minicssgrid`                            | `@tscircuit/core`                |
| `spicey`                                 | `@tscircuit/core`                |
| `@tscircuit/krt-wasm`                    | `@tscircuit/core`                |

`@tscircuit/core` also declares 18 `peerDependencies` at `"*"`, which pins nothing.

**Options considered.**

1. `node-linker=hoisted` — give the packages the flat npm-style tree they were written
   against. Tried first; pnpm 11.9 did not apply the setting from either `.npmrc` or
   `pnpm-workspace.yaml`, and it would also expose phantom dependencies to our own code.
2. **Declare the whole closure as root devDependencies.** Node's ESM resolution walks up
   from `node_modules/.pnpm/<pkg>/node_modules/<pkg>/dist/` to the workspace root
   `node_modules/`, so a root-installed package is reachable from any nested package
   without hoisting.

**Decision.** Option 2. Every package in the table above is an explicit root
devDependency, pinned. pnpm's isolated layout is kept, so our own packages still cannot
import what they have not declared.

**Consequences.**

- Upgrading `@tscircuit/eval` or `@tscircuit/core` may surface new undeclared imports.
  The symptom is a clear `ERR_MODULE_NOT_FOUND` naming the package; the fix is to add it
  here and to the root manifest.
- **`@tscircuit/krt-wasm` is Proprietary-licensed** (a WASM fork of the KiCad routing
  tools). It arrives transitively through `@tscircuit/core`. This must be reviewed before
  any distribution of SYNTRIX, and it is a further reason M10 routes through Freerouting
  (GPL, run out-of-process in its own container) rather than through tscircuit's
  autorouter.
- `sharp` (a transitive native image dependency) needs its install script; it is allowed
  in `pnpm-workspace.yaml` under `allowBuilds`.

---

## ADR-0007 — Element conventions taken from tscircuit's own output, not invented

**Status:** accepted · 2026-09-14

Rather than guess how to shape elements, a real circuit (two passives and a trace) was
evaluated through `@tscircuit/eval` and the output inspected. `@syntrix/core`'s element
factories follow what came back:

- **Values are stored twice.** A 10k resistor carries `resistance: 10000` _and_
  `display_resistance: "10kΩ"`. The numeric field is what tools compute with; the display
  field preserves what the user wrote. Our factories set both — writing only the number
  loses the author's intent, and writing only the string breaks every consumer.
- **`port_hints` is the alternate-name mechanism.** A resistor's pin 1 carries
  `port_hints: ["pin1", "pos", "anode", "1", "left"]`. This is what makes
  `connect({ component: "R1", pin: "pos" })` resolvable, so `PartDefinition.pins[].altNames`
  maps onto `port_hints` rather than into our sidecar.
- **Passives declare `are_pins_interchangeable: true`**, which ERC needs in order not to
  report a "reversed" resistor.
- Components belong to a `source_group` via `source_group_id`; a complete document also
  carries `source_project_metadata` and, for a board, `source_board`.
- A full evaluation emits `pcb_*`, `schematic_*` and `cad_component` elements as well —
  24 element types for a two-component circuit. Core generates only the `source_*` layer
  itself and lets `@syntrix/layout` own the `schematic_*` layer, so the two never fight
  over the same elements.

**Consequence.** Open question 2 is partly answered: `@tscircuit/eval` does run under
Node 24, so TSX mode is viable. Whether its sandbox is strong enough for untrusted
LLM-authored TSX is still open, and the answer is expected to be "run it in the worker
container with resource limits" regardless.

---

## ADR-0008 — Coverage gate: 90% lines/statements/functions, 80% branches

**Status:** accepted · 2026-09-14 · resolves open question 5

M1 requires "90% coverage" on `@syntrix/core` without saying which metric. The gate in
`packages/core/vitest.config.ts` is set to **90% lines, statements and functions, and 80%
branches**, and the suite fails below any of them.

**Why branches are lower.** `circuit-json` marks nearly every field optional —
`source_port` has 47 fields, of which 45 are optional. Code that reads those elements is
consequently full of `?? []`, `?.` and presence checks whose false arm cannot be reached
by any document the engine itself produces. Pushing branch coverage to 90 would mean
hand-constructing documents that cannot occur in order to exercise defensive fallbacks,
which measures the tests rather than the code.

Achieved at the close of M1: **94.3% lines, 94.9% functions, 81.0% branches**, across 108
tests.

**Revisit** if branch coverage drops below 80, which would indicate genuinely untested
logic rather than defensive padding.

---

## ADR-0009 — v2: build on tscircuit; four required services

**Status:** accepted · 2026-09-14 · supersedes parts of ADR-0004 and ADR-0006

**Context.** v1 stood a service beside tscircuit for every heavy job: a `sim` container
around native ngspice, a `freerouting` container around the Java router, a `pytools`
container, MinIO for artifacts, Redis + BullMQ for jobs, Meilisearch for parts search, a
separate `mcp` process. Twelve compose services before a single circuit had been drawn,
and each one duplicated something a tscircuit package already did.

**Decision.** tscircuit is the engine for rendering, autorouting, simulation, footprints
and fabrication export. We build only what it lacks: the graphical editor, persistence
and the operation log, the provider-agnostic agent, MCP tools, the curated parts library,
ELK schematic layout and the LTspice exporter. Infrastructure shrinks to four required
compose services — `proxy`, `web`, `api`, `mongo` — with three opt-in profiles: `kicad`
(the `kicad-cli` wrapper), `indexing` (Redis + a BullMQ worker for bulk parts ingestion)
and `search` (Meilisearch).

**Consequences.**

- `apps/mcp` folds into `apps/api` (Streamable HTTP at `/mcp`, plus a stdio entry point).
  `apps/worker` folds into an in-process Mongo-backed queue whose handlers the `indexing`
  profile reuses unchanged.
- `services/sim`, `services/freerouting` and `services/pytools` are deleted. Simulation is
  WASM ngspice in a Worker or in Node; routing is tscircuit's autorouter.
- MinIO is deleted; artifacts are a local volume at `./data/artifacts`.
- The api's only HTTP dependencies are now both optional, so an unconfigured URL reports
  `disabled`, and a bare four-service stack reports `ok` rather than `degraded`.
- **ADR-0006's Freerouting consequence is retired.** Its `@tscircuit/krt-wasm`
  proprietary-licence note stands and still needs review before distribution — and now
  matters more, since we route through tscircuit rather than around it.
- **ADR-0004 is superseded.** `@syntrix/sim` keeps its `Simulator` interface, but the
  implementation targets the WASM ngspice path tscircuit itself uses rather than
  `eecircuit-engine` behind an HTTP service. The concrete package is confirmed at M5.

---

## ADR-0010 — `jlcsearch` is not a package; `@tscircuit/parts-engine` is

**Status:** accepted · 2026-09-14

The v2 specification named `jlcsearch` as the LCSC part-search dependency. `npm view
jlcsearch` returns nothing: it is a **hosted service** (`jlcsearch.tscircuit.com`), not a
published module. The published package for part search in the tscircuit ecosystem is
`@tscircuit/parts-engine@0.0.32`.

**Decision.** The M7 `LcscEasyEdaSource` adapter is written against
`@tscircuit/parts-engine` plus the jlcsearch HTTP endpoint, with `easyeda-converter` for
symbol, footprint and 3D extraction. Both sit behind the existing `PartsSource`
interface, so an outage or a removed endpoint disables one source rather than breaking
search. `@tscircuit/parts-engine`'s API is read from its `.d.ts` before the adapter is
written.

---

## ADR-0011 — `@tscircuit/runframe` for the PCB and 3D viewers

**Status:** accepted · 2026-09-14 · supersedes two pins in ADR-0005

v1 pinned `@tscircuit/schematic-viewer@2.0.92` and `@tscircuit/pcb-viewer@1.11.394` as
separate viewers. `@tscircuit/runframe@0.0.2725` is the current umbrella: its
`CircuitJsonViewer` renders schematic, PCB and 3D tabs from one circuit-json array.

**Decision.** Use runframe for the read-only PCB and 3D tabs. The schematic tab is **not**
runframe — it is our own SVG canvas over `schematic-symbols`, because it has to be
editable, and that is one of the things tscircuit does not provide. This is the line the
v2 rulebook draws: reuse the viewer, build the editor.

---

## ADR-0012 — There is no `@tscircuit/autorouting` package

**Status:** accepted · 2026-09-14

The v2 specification referred to "the tscircuit autorouter package used by
`@tscircuit/core`". No package by that name exists. `@tscircuit/core` routes through
`@tscircuit/infgrid-ijump-astar@0.0.35` (already in our pinned dependency closure, see
ADR-0006) and `@tscircuit/capacity-autorouter@0.0.905`.

**Decision.** M9 routes by evaluating the design through `@tscircuit/core` and taking the
`pcb_trace` elements it emits, rather than importing a router directly. That keeps us on
tscircuit's own routing path and means an upgrade to `@tscircuit/core` upgrades our
router. `dsn-converter` remains the escape hatch for anyone who wants to route the board
in an external tool.

---

## ADR-0013 — `manualEdits` replaces `meta[].layoutOverride`

**Status:** accepted · 2026-09-14

v1 stored user placement in our own sidecar as `meta[elementId].layoutOverride`, written
by a `set_layout_override` operation. That is a private convention: nothing outside
SYNTRIX can read it, and it does not survive a round trip through the tscircuit
toolchain.

**Decision.** `Design` gains a first-class `manualEdits` field mirroring tscircuit's own
manual-edits concept — schematic and PCB placement maps keyed by `source_component_id`.
`move_component` writes it; layout reads it and never overwrites it. `meta` keeps what is
genuinely ours: provenance, constraints, agent notes, part refs, footprint verification.

**Consequences.** `set_layout_override` is removed from the operation union, taking the
count from 16 to 15. A one-time migration moves any existing `meta[].layoutOverride` into
`manualEdits`, with a test that a v1 document loads correctly. `@syntrix/layout` reads
`design.manualEdits` instead of the sidecar.

---

## ADR-0014 — One React, and it is React 19

**Status:** accepted · 2026-09-14

**Context.** The first attempt to run `@tscircuit/eval` in Node failed with _"A React
Element from an older version of React was rendered."_ `@tscircuit/core` renders through
`react-reconciler@0.32.0`, which is built for React 19; the JSX the sandbox evaluated was
produced by React 18.

The 18 did not come from us. `calculate-cell-boundaries@0.0.21`, a transitive dependency
of `@tscircuit/core`, hard-depends on `react@18.3.1` — it uses React only for
`lucide-react` in its debug graphics. pnpm hoisted that copy into
`node_modules/.pnpm/node_modules/`, the hidden directory that every package inside
`.pnpm/` resolves against, where it shadowed React for `@tscircuit/eval`. Adding React 19
as a root devDependency did not help: the root `node_modules` is further up the
resolution chain than the hidden hoist directory, so it is never reached.

**Decision.** A `react`/`react-dom` override pinned to `19.3.0` in `pnpm-workspace.yaml`,
and `apps/web` moved from React 18 to React 19 to match.

**Why not keep the web app on 18.** Two reasons. tscircuit is the engine (principle 1)
and it is a React 19 codebase, so pinning our side to 18 means permanently fighting its
dependency tree. And `@tscircuit/runframe`, which M4 embeds for the PCB and 3D tabs, would
reproduce exactly this dual-instance failure inside the browser bundle — where it is much
harder to see than a stack trace in a test.

**Consequences.** `@tscircuit/eval` runs under Node 24 and renders a two-component board
in about 2s. The web app builds unchanged on React 19. `calculate-cell-boundaries` now
gets a React it did not ask for; it uses React only for an optional debug UI we never
render, so this is safe, and it is recorded here in case a future failure points back at
it.

---

## ADR-0015 — TSX mode isolation: in-process, with a process boundary required for untrusted input

**Status:** accepted · 2026-09-14 · resolves open question 2

**Context.** `@tscircuit/eval` evaluates code in the calling process. v1 planned to hide
that inside the worker container; v2 has no worker.

**Decision.** `compileTsx` runs in-process and enforces what it can: CDN loading is
disabled by default, so a model-authored `import` cannot pull an arbitrary npm package; a
timeout (20s by default) bounds a runaway render; and the runner is killed on every path,
including failure, because a live runner holds the render loop open and the process will
not exit.

**This is not a security boundary, and the code says so.** It is adequate for the trusted
paths — a signed-in user's own design, and our own agent, whose TSX we can read back from
the operation log. It is _not_ adequate for untrusted input: an anonymous MCP client, or a
public deployment. Those must run `compileTsx` behind a process boundary with its own
memory and CPU limits.

**Revisit** at M8, when MCP exposes `generate_tsx_circuit` to external clients. The likely
shape is a pooled child process, since the render stack's cold start is seconds and paying
it per request would cost more than the isolation is worth.

---

## ADR-0016 — tscircuit's renderer and circuit-json's schema are not in lockstep

**Status:** accepted · 2026-09-14

**Context.** The first real TSX compile produced a document `circuit-json@0.0.491` — the
latest published version — rejects. The cause is a single field:
`pcb_component.display_offset_x` comes back from `@tscircuit/core` as a **number**, where
the schema declares a **string**. One malformed field per placed component is enough to
reject the element, and one rejected element was enough to fail the whole compile.

**Decision.** `partitionConformant` handles two kinds of divergence, and nothing else:

1. A field the element's own schema rejects is **stripped**, and the element kept. Only
   removal, never coercion — nothing is invented to make a value fit. A required field
   cannot be rescued this way, because removing it fails validation again, so this can
   only ever fix an optional field the renderer spells differently.
2. An element type the union does not know at all is **dropped whole**. Nothing hits this
   today; it exists because a renderer that runs ahead of its schema once will do it
   again, and failing every TSX compile until a dependency bump is not a reasonable
   response to a new element type.

Both are reported on `CompiledTsx.skew`, so a drop is visible rather than silent.
Principle 2 is what forces this shape: the document is circuit-json validated by
circuit-json's own schemas, so nothing the schema rejects may enter — not even something
tscircuit itself produced. The alternatives were failing every compile over a display
offset, or smuggling unvalidated data into the document.

**A correction worth recording.** The first version of this ADR also listed
`pcb_solder_paste` and `pcb_smtpad` as element types missing from the union. They are not.
`any_circuit_element`'s 164 branches are not all `ZodObject`: some are unions, some
discriminated unions, and some `ZodEffects` wrapping either. A type collector that only
understood `ZodObject` reported a third of the spec as unknown. The collector now walks
all four, and with it there is exactly one real divergence — `display_offset_x`.

**Revisit** whenever `circuit-json` or `@tscircuit/core` is upgraded: check whether `skew`
comes back empty, and delete the workaround if it does.

---

## ADR-0017 — A bad tscircuit selector does not throw

**Status:** accepted · 2026-09-14

Compiling a `<trace from=".R1 > .pin9">` against a two-pin resistor **succeeds**.
tscircuit records the failure as a `source_trace_not_connected_error` element — _"Could
not find port for selector '.R1 > .pin9'. Component '.R1 > ' found, but does not have pin
'pin9'"_ — and renders the rest of the board.

This is the most dangerous behaviour found in the TSX path so far. A caller that checks
only whether `compileTsx` returned `ok` would merge a board whose wiring went nowhere, and
the design would then fail ERC for reasons that look nothing like the actual mistake.

**Decision.** `compileTsx` lifts every element whose type ends in `_error` or `_warning`
into `CompiledTsx.diagnostics`, with a severity. The elements stay in the document — they
are valid circuit-json and the UI draws them — but a caller no longer has to know that
convention to discover the render went wrong. `hasErrors(diagnostics)` is the check.

**Consequence.** The M6 agent loop must treat `hasErrors` as a failed tool call and feed
the diagnostic messages back to the model, exactly as it does a validation error. They are
already written in the right register: the message names the selector and says what the
component does have instead.

---

## ADR-0018 — `@tscircuit/props` is the source of the manual-edits schema

**Status:** accepted · 2026-09-14 · amends ADR-0013

ADR-0013 said `manualEdits` mirrors tscircuit's manual-edits concept. Reading
`@tscircuit/props@0.0.653` showed the concept is not merely mirrorable — it is exported.
`manual_edits_file` is a zod 3 schema, ISC-licensed, and it is what tscircuit itself
parses `manual-edits.json` with. `@syntrix/core` imports and re-exports it rather than
declaring its own.

**One correction to the plan.** The v2 specification said placements are keyed by
`source_component_id`. They are not: the real schema keys by `selector`, and
`@tscircuit/core` matches with
`matchesSelector(component, selector) || component.props.name === selector`. That turns
out to be the better design, and the reason to follow it exactly — ids are regenerated on
every TSX re-evaluation and names are not, so keying by name is what lets a user's drag
survive a recompile. `merge_circuit_json` with `replace_all` now keeps `manualEdits` for
this reason, while `meta`, which is id-keyed, still cannot survive.

The shape, verified at runtime:

```ts
{ pcb_placements?:       { selector, relative_to, center: { x, y } }[]
  schematic_placements?: { selector, relative_to, center: { x, y } }[]
  manual_trace_hints?:   { pcb_port_selector, offsets: Point[] }[] }
```

`relative_to` defaults to `"group_center"`, and `center` accepts SI strings (`"2mm"`
parses to `2`). There is no rotation field, so rotation stays in `meta.rotationDeg` — it
was always genuinely ours.

---

## ADR-0019 — `spicey` is the simulator, not WASM ngspice

**Status:** accepted · 2026-09-15 · supersedes ADR-0004 · resolves open question 4

**Context.** The v2 plan named "the WASM ngspice path used by `tsci simulate`". There is
no such path. tscircuit's in-tree SPICE engine is **`spicey`** — its own description is
"Run SPICE simulations in native javascript. An alternative to ngspice" — and it is
already a dependency of `@tscircuit/core`, so it arrives with the engine rather than as a
choice. (`spicets`, the similarly named package, is a netlist read/write toolkit and not a
simulator at all.)

**Decision.** `spicey` is the default `Simulator`. Measured on the rc_lowpass fixture it
puts the −3 dB corner at 160.3 Hz against a theoretical 159.15 Hz — **0.74% error**,
against M5's 5% budget. Being pure JavaScript, it is also one implementation for both the
browser and the server rather than two, with no WASM to load before the first simulation
and no binary to ship.

`eecircuit-engine` (a real ngspice build, and ADR-0004's original choice) remains the
escape hatch for what spicey does not cover, behind the same interface. spicey exports
`eecEngineTranToVGraphs`, which suggests tscircuit expects exactly that pairing.

**Consequence.** ADR-0004 is superseded: the decision it made was provisional and made
before anything had been measured, and the thing it chose was not what tscircuit uses.

---

## ADR-0020 — What spicey does not do, and what we do about it

**Status:** accepted · 2026-09-15

Three behaviours differ from ngspice enough to be worth recording, all verified by running
the library rather than by reading about it.

**1. The first line is parsed, not treated as a title.** Every SPICE dialect since the
1970s ignores line one; spicey does not. A netlist beginning `RC lowpass` fails with
"Resistor missing node", because the line begins with `R` — an error that points nowhere
near the cause. `withAnalysisCard` prefixes `*` to any netlist that lacks one.

**2. `.op` and `.dc` are not implemented.** The parser lists `.op` under `skipped` and has
no `.dc` handling; `analyses` only ever carries `ac` and `tran`.

- **`op` is served from a settled transient.** For a linear circuit the final sample of a
  transient _is_ the operating point, and it is what a bench measurement would give. A
  1k/1k divider from 10 V reads 5.000 V. `SimResult.log` says how the number was obtained,
  so nobody mistakes it for a native `.op`.
- **`dc` is refused**, with a hint pointing at a ramped transient or at
  `eecircuit-engine`. A sweep cannot be faked from a single operating point, and
  `capabilities.analyses` omits it so a caller finds out before the run rather than during
  it.

**3. `simulateAC` and `simulateTRAN` take a parsed circuit; `simulate` takes text.**
Passing a string to the first two throws on `ckt.analyses` — an error that reads like a
bug in the netlist rather than in the call.

**Revisit** when spicey gains `.op`/`.dc`: the transient substitution should then be
deleted rather than kept as a fallback, since two paths to an operating point will
eventually disagree.

---

## ADR-0021 — We write the engineering BOM ourselves

**Status:** accepted · 2026-09-15

`circuit-json-to-bom-csv` emits one row per component **that carries a distributor SKU**,
and nothing for one that does not. Verified: a design of a 10k resistor and a 100nF
capacitor produces an empty string.

That is correct for a purchasing BOM and wrong for what an engineer needs. The parts list
is wanted long before anyone has chosen a supplier — it is how you check that R3 is really
meant to be 4.7k, and it is what goes into a design review.

**Decision.** `@syntrix/export`'s BOM exporter writes the engineering BOM itself — refdes,
value as the author typed it, type, footprint, and **footprint verification** — and merges
tscircuit's supplier columns in when there are any.

This is the "build only what tscircuit lacks" line (principle 1) falling in its usual
place: not a whole format, a missing column. Wrapping the package and shipping an empty
file would have been more faithful to the letter of the principle and useless.

---

## ADR-0022 — `@tscircuit/parts-engine`, not `easyeda-converter`

**Status:** accepted · 2026-09-15 · resolves open question 1 · refines ADR-0010

**Context.** The v2 plan and ADR-0010 both named `easyeda-converter` for the LCSC import.
ADR-0005 flagged its version — 0.0.2 — as suspicious and said to verify before M7. It does
not survive verification:

- It is built against **`@tscircuit/soup`** and **`@tscircuit/builder`**, the packages
  renamed to `circuit-json` long ago. Its own source imports `any_source_component` from
  `@tscircuit/soup`.
- Its two exported functions **do not compose**. `fetchEasyEDAComponent` returns
  `{ success, code, result }`; `convertEasyEdaJsonToTscircuitSoupJson` reads `.dataStr`
  off its argument, so passing the first's output to the second throws
  `Cannot read properties of undefined (reading 'dataStr')`.
- Passing `result` by hand does not fix it: on C6186 it produces **two** elements — a
  component and a `pcb_component` — with no pads, no ports and no 3D model.

**Decision.** Use `@tscircuit/parts-engine@0.0.32`, which bundles maintained copies of
both functions and is what tscircuit itself calls. Its real method is
`fetchPartCircuitJson({ supplierPartNumber, manufacturerPartNumber, platformFetch })` — not
the shape the name suggests; passing anything else returns `undefined` silently.

Measured on C6186 (AMS1117-3.3) it returns **13 elements**: the source component, four
source ports, four SMT pads, a silkscreen path, a courtyard outline, and a `cad_component`
carrying `model_obj_url` and `model_step_url`. Symbol, footprint and 3D — M7's criterion,
from one call.

Search stays on `jlcsearch.tscircuit.com` (ADR-0010), which returns structured rows with
package, stock and JLC basic-part status. The two are separate because search has to be
fast and fetch has to be complete.

**Consequences.**

- `easyeda-converter` is not a dependency of anything. It is still declared in
  `packages/parts` so the comparison above stays reproducible; drop it at the next
  cleanup if nothing else has grown a use for it.
- The EasyEDA footprint is marked `verified` — it is the package drawing JLC assembles
  against, which is as verified as a footprint gets without measuring a part.
- **Pin names come back generic** for some parts: C6186 yields `pin1`–`pin4` rather than
  `GND`/`VOUT`/`VIN`, because that is what EasyEDA's symbol carries. A part imported this
  way is wired by number unless the user renames the pins. T0 is still the better source
  for a part it covers, which is why it keeps a higher priority in the registry.
- EasyEDA's library terms are not an open licence, and are recorded per part so the BOM
  can surface them (principle 9).

---

## ADR-0023 — KiCad libraries are the only source with no key and no network

**Status:** accepted · 2026-09-15 · resolves open question 3

`kicad-mod-converter@0.0.30` parses a `.kicad_mod` file straight to circuit-json with
`parseKicadModToTscircuitSoup(text)`. Since kicad-footprints is a git checkout of plain
files, `KicadLibrarySource` needs no credentials, no API and no rate limit — the only
parts source with none of those.

**On the licence,** which open question 3 asked us to confirm. kicad-footprints is
CC-BY-SA 4.0 **with a library exception**: using a footprint in a design does not make the
design a derivative work. Without that exception the licence would make every board drawn
with these footprints share-alike, and the source would not be usable here at all. The
exact wording is recorded on every part this source produces rather than assumed once, so
a BOM can carry it.

**Consequence.** The source reports `disabled` with a message naming `make kicad-libs`
when no checkout is present, which is the normal state — the library is ~15k files and not
something to vendor.

---

## ADR-0024 — The MCP SDK is pinned to 1.22, the last zod-3 release

**Status:** accepted · 2026-09-15

`@modelcontextprotocol/sdk@1.24.0` moved its zod dependency to `^3.25 || ^4.0` and imports
the `zod/v3` compatibility subpath, which only exists in zod 4. On our pinned zod 3
(ADR-0002) any import fails with `ERR_PACKAGE_PATH_NOT_EXPORTED: './v3'` — an error naming
zod's export map rather than the SDK, which is a poor signpost.

**Decision.** Pin `1.22.0`, the last release depending on `zod@^3.23.8`. The same trap
took `zod-to-json-schema`, which is pinned to the 3.24 line for exactly this reason; both
are consequences of ADR-0002 and both unpin together when `circuit-json` ships zod 4 types.

**Revisit** with ADR-0002. Until then, check a package's zod range before upgrading it.

---

## ADR-0025 — MCP tools are the agent's tools

**Status:** accepted · 2026-09-15

The MCP server exposes the same operation set as the in-app agent, generated from the same
`AGENT_OPERATIONS` list and validated by the same `operationSchema`. `move_component` and
`undo` are absent from both for the same reasons (principle 4; undo belongs to the user).

**Decision.** One tool surface, two callers. Adding an Operation to core adds it to the
REST API, the in-app agent and every external MCP client at once, with nothing to keep in
step by hand. A second hand-written schema for MCP would be a second thing to drift.

**Two things MCP needs that the agent does not**, both a consequence of a client arriving
with no session:

- **The design id is a tool argument**, not ambient context, and `list_designs` exists to
  find one.
- **Tool descriptions carry their own context.** Our agent reads the house rules in its
  system prompt; an MCP client has no prompt from us, so "connect two pins" has to also
  say that power and ground belong on named nets.

---

## ADR-0026 — A footprint lives in the sidecar, because circuit-json has nowhere for it

**Status:** accepted · 2026-09-15

**Context.** `add_component` with `props: { footprint: "0402" }` appeared to work: the
operation succeeded and the component validated. The footprint was gone. `source_component`
has no footprint field and its zod schema strips unknown keys, so the prop vanished
without a word — and the failure surfaced two milestones later as a routed board with four
pads missing and no copper.

**Decision.** `MetaEntry.footprinterString` holds it. The sidecar is exactly the right
place: circuit-json models footprint _geometry_ as `pcb_*` elements, and what a user
supplies is the _intent_ that produces them, which the spec does not model at all
(principle 3). `ejectToTsx` reads it, which is what puts `footprint="0402"` back into the
TSX that the router evaluates.

**Consequence.** `routePcb` now fails loudly when a design routes to zero pads, naming the
components that were exported without a footprint. A board with no copper that exports
clean Gerbers is the single most expensive failure this project can produce, and it should
not be possible to reach it quietly.
