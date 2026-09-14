/**
 * The reducer.
 *
 * `apply` is the only way a design changes. It is pure and immutable: it returns a new
 * `Design` and never mutates the one it was given, so undo is a matter of keeping the
 * previous value and replay is deterministic.
 *
 * It never throws for a domain failure. Every rejection comes back as
 * `ValidationError[]`, each carrying a `hint` written for an LLM to act on.
 */

import type { AnyCircuitElement } from "circuit-json"
import type { Result, ValidationError } from "@syntrix/shared"
import {
  collect,
  err,
  formatSiValue,
  newElementId,
  nextRefdes,
  ok,
  parseSiValue,
  validationError,
} from "@syntrix/shared"
import type { Design, MetaEntry, PortRef, Provenance } from "./types"
import { isNetRef } from "./types"
import type { Operation } from "./operations"
import {
  createComponent,
  createNet,
  createTrace,
  ftypeSpec,
  isType,
  validateCircuit,
} from "./elements"
import type { FtypeSpec } from "./elements"
import {
  buildIndex,
  describePort,
  elementId,
  resolveComponent,
  resolveNet,
  resolvePort,
} from "./index-view"
import type { IndexedView } from "./index-view"

export interface ApplyContext {
  /**
   * Resolves a catalog part reference to a pin specification. Supplied by
   * `@syntrix/parts`; core stays independent of it so the dependency runs one way.
   */
  resolvePart?: (partRef: string) => { ftype: string; spec: FtypeSpec } | undefined
  /** Recorded in `meta` for every element the operation creates. */
  provenance?: Omit<Provenance, "at">
}

const now = (): string => new Date().toISOString()

const notFound = (
  code: "COMPONENT_NOT_FOUND" | "PORT_NOT_FOUND" | "NET_NOT_FOUND",
  what: string,
  available: string[],
): ValidationError => {
  // Listing what *does* exist is what lets a model correct a typo in one turn rather
  // than guessing.
  const suggestion =
    available.length > 0
      ? ` Available: ${available.slice(0, 12).join(", ")}${available.length > 12 ? ", …" : ""}.`
      : " The design has none yet."
  return validationError(
    code,
    `${what} was not found.`,
    `Check the name against the design.${suggestion}`,
    [],
    { available },
  )
}

/** Apply one operation. Pure: `design` is never mutated. */
export const apply = (
  design: Design,
  operation: Operation,
  ctx: ApplyContext = {},
): Result<Design, ValidationError[]> => {
  const view = buildIndex(design.circuit)
  const result = reduce(design, view, operation, ctx)
  if (!result.ok) return result

  // Version advances once per applied operation, including a batch — a batch is one
  // logical change and one undo step.
  return ok({ ...result.value, version: design.version + 1 })
}

/** Apply several operations in order, stopping at the first failure. */
export const applyAll = (
  design: Design,
  operations: Operation[],
  ctx: ApplyContext = {},
): Result<Design, ValidationError[]> => {
  let current = design
  for (const operation of operations) {
    const result = apply(current, operation, ctx)
    if (!result.ok) return result
    current = result.value
  }
  return ok(current)
}

const withMeta = (
  design: Design,
  ids: string[],
  entry: MetaEntry,
  ctx: ApplyContext,
): Record<string, MetaEntry> => {
  const meta = { ...design.meta }
  for (const id of ids) {
    meta[id] = {
      ...meta[id],
      ...entry,
      ...(ctx.provenance ? { provenance: { ...ctx.provenance, at: now() } } : {}),
    }
  }
  return meta
}

// A reducer over a discriminated union is one branch per operation. Splitting it would
// only hide the exhaustiveness check that makes an unhandled Operation a compile error.
const reduce = (
  design: Design,
  view: IndexedView,
  operation: Operation,
  ctx: ApplyContext,
): Result<Design, ValidationError[]> => {
  switch (operation.type) {
    // ---------------------------------------------------------------- components
    case "add_component": {
      let ftype = operation.ftype
      let spec: FtypeSpec | undefined

      if (operation.partRef) {
        const part = ctx.resolvePart?.(operation.partRef)
        if (!part) {
          return err([
            validationError(
              "PART_NOT_FOUND",
              `Part "${operation.partRef}" could not be resolved.`,
              "Search for the part first, or add the component with a plain ftype such as simple_resistor.",
              [],
              { partRef: operation.partRef },
            ),
          ])
        }
        ftype = part.ftype
        spec = part.spec
      }

      if (!ftype) {
        return err([
          validationError(
            "INVALID_OPERATION",
            "add_component needs either a partRef or an ftype.",
            'Pass ftype: "simple_resistor" for a generic part, or partRef for a catalog part.',
          ),
        ])
      }

      const name = operation.name ?? nextRefdes(ftype, [...view.componentsByName.keys()])

      if (view.componentsByName.has(name)) {
        return err([
          validationError(
            "DUPLICATE_NAME",
            `A component named "${name}" already exists.`,
            "Pick a different refdes, or omit `name` to have one assigned automatically.",
            [view.componentsByName.get(name)?.source_component_id ?? ""],
          ),
        ])
      }

      const created = createComponent({
        ftype,
        name,
        props: operation.props,
        ...(spec ? { spec } : {}),
      })
      if (!created.ok) return created

      const newElements = [created.value.component, ...created.value.ports]
      const ids = newElements.map(elementId).filter((id): id is string => Boolean(id))

      return ok({
        ...design,
        circuit: [...design.circuit, ...newElements],
        meta: withMeta(design, ids, operation.partRef ? { partRef: operation.partRef } : {}, ctx),
      })
    }

    case "remove_component": {
      const component = resolveComponent(view, operation.component)
      if (!component) {
        return err([
          notFound("COMPONENT_NOT_FOUND", `Component "${operation.component}"`, [
            ...view.componentsByName.keys(),
          ]),
        ])
      }

      const componentId = component.source_component_id
      const portIds = new Set(
        (view.portsByComponent.get(componentId) ?? []).map((p) => p.source_port_id),
      )

      // Removing a component must remove its ports and prune it from every trace, or
      // the document is left referencing elements that no longer exist.
      const circuit: AnyCircuitElement[] = []
      for (const element of design.circuit) {
        if (isType(element, "source_component") && element.source_component_id === componentId) {
          continue
        }
        if (isType(element, "source_port") && portIds.has(element.source_port_id)) continue

        if (isType(element, "source_trace")) {
          const remaining = (element.connected_source_port_ids ?? []).filter(
            (id) => !portIds.has(id),
          )
          const nets = element.connected_source_net_ids ?? []

          // A trace is only meaningful while it still joins two things: two ports, or a
          // port and a net. Once the removed component's ports are gone it may join
          // nothing at all, and a trace with no ports left is junk in the document even
          // when it still names a net.
          const stillConnectsSomething =
            remaining.length >= 2 || (remaining.length >= 1 && nets.length >= 1)
          if (!stillConnectsSomething) continue

          circuit.push({ ...element, connected_source_port_ids: remaining })
          continue
        }
        circuit.push(element)
      }

      const meta = { ...design.meta }
      delete meta[componentId]
      for (const portId of portIds) delete meta[portId]

      return ok({ ...design, circuit, meta })
    }

    case "rename": {
      const component = resolveComponent(view, operation.component)
      if (!component) {
        return err([
          notFound("COMPONENT_NOT_FOUND", `Component "${operation.component}"`, [
            ...view.componentsByName.keys(),
          ]),
        ])
      }
      if (
        view.componentsByName.has(operation.name) &&
        view.componentsByName.get(operation.name)?.source_component_id !==
          component.source_component_id
      ) {
        return err([
          validationError(
            "DUPLICATE_NAME",
            `A component named "${operation.name}" already exists.`,
            "Refdes must be unique within a design. Pick another name.",
            [component.source_component_id],
          ),
        ])
      }

      return ok({
        ...design,
        circuit: design.circuit.map((element) =>
          isType(element, "source_component") &&
          element.source_component_id === component.source_component_id
            ? { ...element, name: operation.name }
            : element,
        ),
      })
    }

    case "set_prop": {
      const component = resolveComponent(view, operation.component)
      if (!component) {
        return err([
          notFound("COMPONENT_NOT_FOUND", `Component "${operation.component}"`, [
            ...view.componentsByName.keys(),
          ]),
        ])
      }

      const spec = ftypeSpec(component.ftype ?? "")
      const key = operation.key === "value" && spec?.valueProp ? spec.valueProp : operation.key

      const patch: Record<string, unknown> = {}
      if (key === spec?.valueProp) {
        const parsed = parseSiValue(operation.value as string | number)
        if (!parsed.ok) {
          return err([
            validationError(
              "INVALID_PROP",
              `Could not read "${operation.value}" as a value for ${key}.`,
              parsed.error.hint,
              [component.source_component_id],
            ),
          ])
        }
        patch[key] = parsed.value.value
        // Keep both representations in step (ADR-0007).
        patch[`display_${key}`] =
          typeof operation.value === "string"
            ? operation.value
            : formatSiValue(parsed.value.value, spec?.valueUnit ?? "")
      } else {
        patch[key] = operation.value
      }

      const updated = { ...component, ...patch }
      const conformance = validateCircuit([updated])
      if (!conformance.ok) return conformance

      return ok({
        ...design,
        circuit: design.circuit.map((element) =>
          isType(element, "source_component") &&
          element.source_component_id === component.source_component_id
            ? (conformance.value[0] as AnyCircuitElement)
            : element,
        ),
      })
    }

    // ---------------------------------------------------------------- connectivity
    case "connect": {
      const from = resolvePort(view, operation.a)
      if (!from) return err([portNotFound(view, operation.a)])

      if (isNetRef(operation.b)) {
        const netResult = ensureNet(design, view, operation.b.net)
        if (!netResult.ok) return netResult
        const { design: withNet, netId } = netResult.value

        const trace = createTrace(
          [from.source_port_id],
          [netId],
          `${describePort(view, from)} to ${operation.b.net}`,
        )
        if (!trace.ok) return trace
        return ok({ ...withNet, circuit: [...withNet.circuit, trace.value] })
      }

      const to = resolvePort(view, operation.b as PortRef)
      if (!to) return err([portNotFound(view, operation.b as PortRef)])

      if (from.source_port_id === to.source_port_id) {
        return err([
          validationError(
            "SELF_CONNECTION",
            `Cannot connect ${describePort(view, from)} to itself.`,
            "Pick two different pins.",
            [from.source_port_id],
          ),
        ])
      }

      const trace = createTrace(
        [from.source_port_id, to.source_port_id],
        [],
        `${describePort(view, from)} to ${describePort(view, to)}`,
      )
      if (!trace.ok) return trace
      return ok({ ...design, circuit: [...design.circuit, trace.value] })
    }

    case "disconnect": {
      const from = resolvePort(view, operation.a)
      if (!from) return err([portNotFound(view, operation.a)])

      const targetPortId = isNetRef(operation.b)
        ? undefined
        : resolvePort(view, operation.b as PortRef)?.source_port_id
      const targetNetId = isNetRef(operation.b)
        ? resolveNet(view, operation.b.net)?.source_net_id
        : undefined

      if (!isNetRef(operation.b) && !targetPortId) {
        return err([portNotFound(view, operation.b as PortRef)])
      }
      if (isNetRef(operation.b) && !targetNetId) {
        return err([
          notFound("NET_NOT_FOUND", `Net "${operation.b.net}"`, [...view.netsByName.keys()]),
        ])
      }

      let removed = 0
      const circuit = design.circuit.filter((element) => {
        if (!isType(element, "source_trace")) return true
        const ports = element.connected_source_port_ids ?? []
        const nets = element.connected_source_net_ids ?? []
        const matches = targetPortId
          ? ports.includes(from.source_port_id) && ports.includes(targetPortId)
          : ports.includes(from.source_port_id) && nets.includes(targetNetId as string)
        if (matches) removed += 1
        return !matches
      })

      if (removed === 0) {
        return err([
          validationError(
            "NOT_CONNECTED",
            `${describePort(view, from)} is not connected to that ${targetNetId ? "net" : "pin"}.`,
            "Run inspect_design to see the existing connections before disconnecting.",
            [from.source_port_id],
          ),
        ])
      }

      return ok({ ...design, circuit })
    }

    case "create_net": {
      if (view.netsByName.has(operation.name)) {
        return err([
          validationError(
            "DUPLICATE_NAME",
            `A net named "${operation.name}" already exists.`,
            "Connect to the existing net instead of creating a second one with the same name.",
            [view.netsByName.get(operation.name)?.source_net_id ?? ""],
          ),
        ])
      }
      const net = createNet(operation.name, {
        isPower: operation.isPower,
        isGround: operation.isGround,
      })
      if (!net.ok) return net
      return ok({ ...design, circuit: [...design.circuit, net.value] })
    }

    case "rename_net": {
      const net = resolveNet(view, operation.net)
      if (!net) {
        return err([
          notFound("NET_NOT_FOUND", `Net "${operation.net}"`, [...view.netsByName.keys()]),
        ])
      }
      if (
        view.netsByName.has(operation.name) &&
        view.netsByName.get(operation.name)?.source_net_id !== net.source_net_id
      ) {
        return err([
          validationError(
            "DUPLICATE_NAME",
            `A net named "${operation.name}" already exists.`,
            "Net names must be unique. Pick another, or merge the two nets by connecting them.",
            [net.source_net_id],
          ),
        ])
      }
      return ok({
        ...design,
        circuit: design.circuit.map((element) =>
          isType(element, "source_net") && element.source_net_id === net.source_net_id
            ? { ...element, name: operation.name }
            : element,
        ),
      })
    }

    case "add_net_label":
    case "add_power_symbol": {
      // Both are net annotations. The schematic_net_label element that renders them is
      // produced by @syntrix/layout, which owns the schematic layer; core records the
      // intent on the net so layout can act on it.
      const netName = operation.net
      const ensured = ensureNet(design, view, netName, {
        isPower: operation.type === "add_power_symbol",
        isGround: operation.type === "add_power_symbol" && operation.kind === "gnd",
      })
      if (!ensured.ok) return ensured

      const entry: MetaEntry =
        operation.type === "add_power_symbol"
          ? {
              notes: [
                `power symbol: ${operation.kind}${operation.voltage ? ` ${operation.voltage}` : ""}`,
              ],
            }
          : { notes: ["net label"] }

      return ok({
        ...ensured.value.design,
        meta: withMeta(ensured.value.design, [ensured.value.netId], entry, ctx),
      })
    }

    // ---------------------------------------------------------------- geometry
    case "place_hint": {
      const component = resolveComponent(view, operation.component)
      if (!component) {
        return err([
          notFound("COMPONENT_NOT_FOUND", `Component "${operation.component}"`, [
            ...view.componentsByName.keys(),
          ]),
        ])
      }
      const id = component.source_component_id
      const existing = design.meta[id]?.constraints ?? []
      return ok({
        ...design,
        meta: {
          ...design.meta,
          [id]: { ...design.meta[id], constraints: [...existing, ...operation.constraints] },
        },
      })
    }

    case "move_component": {
      const component = resolveComponent(view, operation.component)
      if (!component) {
        return err([
          notFound("COMPONENT_NOT_FOUND", `Component "${operation.component}"`, [
            ...view.componentsByName.keys(),
          ]),
        ])
      }
      const id = component.source_component_id
      return ok({
        ...design,
        meta: {
          ...design.meta,
          [id]: {
            ...design.meta[id],
            layoutOverride: {
              center: operation.center,
              ...(operation.rotation !== undefined ? { rotation: operation.rotation } : {}),
              pinned: operation.pinned,
            },
          },
        },
      })
    }

    case "set_layout_override": {
      if (!view.byId.has(operation.elementId)) {
        return err([notFound("ELEMENT_NOT_FOUND" as never, `Element "${operation.elementId}"`, [])])
      }
      const previous = design.meta[operation.elementId]?.layoutOverride ?? {}
      return ok({
        ...design,
        meta: {
          ...design.meta,
          [operation.elementId]: {
            ...design.meta[operation.elementId],
            layoutOverride: {
              ...previous,
              ...(operation.center ? { center: operation.center } : {}),
              ...(operation.rotation !== undefined ? { rotation: operation.rotation } : {}),
              ...(operation.pinned !== undefined ? { pinned: operation.pinned } : {}),
            },
          },
        },
      })
    }

    // ---------------------------------------------------------------- composites
    case "batch": {
      let current = design
      const errors: ValidationError[] = []

      for (const [index, child] of operation.ops.entries()) {
        const result = apply(current, child, ctx)
        if (result.ok) {
          current = result.value
          continue
        }
        errors.push(
          ...result.error.map((e) => ({
            ...e,
            message: `operation ${index} (${child.type}): ${e.message}`,
          })),
        )
        // Atomic batches abandon everything on the first failure; non-atomic ones keep
        // going so one bad operation does not discard the rest of the agent's turn.
        if (operation.atomic) return err(errors)
      }

      if (errors.length > 0 && operation.atomic) return err(errors)
      // Each child already bumped the version; undo treats a batch as one step, so roll
      // it back to a single increment.
      return errors.length > 0 && !operation.atomic
        ? err(errors)
        : ok({ ...current, version: design.version })
    }

    case "merge_circuit_json": {
      const validated = validateCircuit(operation.elements)
      if (!validated.ok) return validated

      if (operation.strategy === "replace_all") {
        return ok({ ...design, circuit: validated.value, meta: {} })
      }

      if (operation.strategy === "append_only") {
        return ok({ ...design, circuit: [...design.circuit, ...validated.value] })
      }

      // merge_by_name: incoming components replace same-named ones wholesale, together
      // with their ports, so a re-evaluated TSX snippet updates rather than duplicates.
      const incomingView = buildIndex(validated.value)
      const replacedComponentIds = new Set<string>()
      const replacedPortIds = new Set<string>()

      for (const name of incomingView.componentsByName.keys()) {
        const existing = view.componentsByName.get(name)
        if (!existing) continue
        replacedComponentIds.add(existing.source_component_id)
        for (const port of view.portsByComponent.get(existing.source_component_id) ?? []) {
          replacedPortIds.add(port.source_port_id)
        }
      }

      const kept = design.circuit.filter((element) => {
        if (isType(element, "source_component")) {
          return !replacedComponentIds.has(element.source_component_id)
        }
        if (isType(element, "source_port")) return !replacedPortIds.has(element.source_port_id)
        if (isType(element, "source_trace")) {
          // A trace touching a replaced port is stale; the incoming document carries its
          // own connectivity.
          return !(element.connected_source_port_ids ?? []).some((id) => replacedPortIds.has(id))
        }
        return true
      })

      return ok({ ...design, circuit: [...kept, ...validated.value] })
    }

    default: {
      // Exhaustiveness: adding an Operation without handling it fails to compile.
      const exhaustive: never = operation
      return err([
        validationError(
          "UNKNOWN_OPERATION",
          `Unhandled operation: ${JSON.stringify(exhaustive)}`,
          "This is a bug in SYNTRIX — the operation was accepted by the schema but has no reducer branch.",
        ),
      ])
    }
  }
}

const portNotFound = (view: IndexedView, ref: PortRef): ValidationError => {
  const component = resolveComponent(view, ref.component)
  if (!component) {
    return notFound("COMPONENT_NOT_FOUND", `Component "${ref.component}"`, [
      ...view.componentsByName.keys(),
    ])
  }
  const ports = view.portsByComponent.get(component.source_component_id) ?? []
  // Listing the pins that *do* exist, with their aliases, is what lets a model fix a
  // wrong pin name without another round trip.
  const available = ports.map(
    (p) => `${p.pin_number}${p.port_hints?.length ? ` (${p.port_hints.join("/")})` : ""}`,
  )
  return validationError(
    "UNKNOWN_PIN",
    `Component "${ref.component}" has no pin "${ref.pin}".`,
    `Use one of its pins: ${available.join(", ")}.`,
    [component.source_component_id],
    { available },
  )
}

/** Find a net by name, creating it if absent. Connecting to a new net should just work. */
const ensureNet = (
  design: Design,
  view: IndexedView,
  name: string,
  opts: { isPower?: boolean; isGround?: boolean } = {},
): Result<{ design: Design; netId: string }, ValidationError[]> => {
  const existing = resolveNet(view, name)
  if (existing) return ok({ design, netId: existing.source_net_id })

  const created = createNet(name, opts)
  if (!created.ok) return created

  const netId = elementId(created.value)
  if (!netId) {
    return err([
      validationError("CIRCUIT_JSON_INVALID", "Created net has no id.", "This is a bug."),
    ])
  }
  return ok({ design: { ...design, circuit: [...design.circuit, created.value] }, netId })
}

/** An empty design. */
export const createDesign = (id?: string): Design => ({
  id: id ?? newElementId("design"),
  version: 0,
  circuit: [],
  meta: {},
})

export { collect }
