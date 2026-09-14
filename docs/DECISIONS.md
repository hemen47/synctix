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
