/**
 * Indexed view over the flat element array.
 *
 * The array is canonical; this is the shape that answers questions. "What is connected
 * to pin 3 of U1?" against a flat array is a linear scan per hop, and ERC asks that
 * question for every pin in the design.
 *
 * The view is derived and disposable — never mutate it expecting the document to follow.
 */

import type { AnyCircuitElement } from "circuit-json"
import type { PortRef } from "./types"

type Component = Extract<AnyCircuitElement, { type: "source_component" }>
type Port = Extract<AnyCircuitElement, { type: "source_port" }>
type Net = Extract<AnyCircuitElement, { type: "source_net" }>
type Trace = Extract<AnyCircuitElement, { type: "source_trace" }>

export interface IndexedView {
  /** Every element by its own id field. */
  byId: Map<string, AnyCircuitElement>
  components: Map<string, Component>
  /** Component name (refdes) to component. Names are unique within a design. */
  componentsByName: Map<string, Component>
  ports: Map<string, Port>
  nets: Map<string, Net>
  netsByName: Map<string, Net>
  traces: Map<string, Trace>
  /** component id -> its ports, ordered by pin number. */
  portsByComponent: Map<string, Port[]>
  /** port id -> traces touching it. */
  tracesByPort: Map<string, Trace[]>
  /** net id -> port ids on that net. */
  portsByNet: Map<string, Set<string>>
}

/**
 * circuit-json names each element's id field after its type, so this is mechanical
 * rather than a per-type switch.
 */
export const elementId = (element: AnyCircuitElement): string | undefined => {
  const key = `${element.type}_id`
  const value = (element as unknown as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

export const buildIndex = (elements: AnyCircuitElement[]): IndexedView => {
  const view: IndexedView = {
    byId: new Map(),
    components: new Map(),
    componentsByName: new Map(),
    ports: new Map(),
    nets: new Map(),
    netsByName: new Map(),
    traces: new Map(),
    portsByComponent: new Map(),
    tracesByPort: new Map(),
    portsByNet: new Map(),
  }

  for (const element of elements) {
    const id = elementId(element)
    if (id) view.byId.set(id, element)

    switch (element.type) {
      case "source_component": {
        view.components.set(element.source_component_id, element)
        view.componentsByName.set(element.name, element)
        break
      }
      case "source_port": {
        view.ports.set(element.source_port_id, element)
        // `source_component_id` is optional in the schema: a port can exist without an
        // owner (a bare net endpoint). Such ports are still indexed by id, but they
        // belong to no component, so they are skipped here rather than filed under
        // `undefined`.
        if (element.source_component_id) {
          const list = view.portsByComponent.get(element.source_component_id) ?? []
          list.push(element)
          view.portsByComponent.set(element.source_component_id, list)
        }
        break
      }
      case "source_net": {
        view.nets.set(element.source_net_id, element)
        view.netsByName.set(element.name, element)
        break
      }
      case "source_trace": {
        view.traces.set(element.source_trace_id, element)
        break
      }
      default:
        break
    }
  }

  // Ports in pin order, so "the first pin" means the same thing everywhere.
  for (const ports of view.portsByComponent.values()) {
    ports.sort((a, b) => (a.pin_number ?? 0) - (b.pin_number ?? 0))
  }

  for (const trace of view.traces.values()) {
    for (const portId of trace.connected_source_port_ids ?? []) {
      const list = view.tracesByPort.get(portId) ?? []
      list.push(trace)
      view.tracesByPort.set(portId, list)
    }
    for (const netId of trace.connected_source_net_ids ?? []) {
      const set = view.portsByNet.get(netId) ?? new Set<string>()
      for (const portId of trace.connected_source_port_ids ?? []) set.add(portId)
      view.portsByNet.set(netId, set)
    }
  }

  return view
}

/**
 * Resolve a `PortRef` to a port element.
 *
 * A pin may be addressed by number ("2"), by name ("pin2"), or by any of its
 * `port_hints` ("neg", "cathode", "VCC") — which is what lets an agent write
 * `connect({ component: "U1", pin: "VCC" })` without knowing the pinout (ADR-0007).
 */
export const resolvePort = (view: IndexedView, ref: PortRef): Port | undefined => {
  const component = view.componentsByName.get(ref.component) ?? view.components.get(ref.component)
  if (!component) return undefined

  const ports = view.portsByComponent.get(component.source_component_id) ?? []
  const needle = String(ref.pin).toLowerCase()

  return (
    ports.find((p) => String(p.pin_number) === needle) ??
    ports.find((p) => p.name?.toLowerCase() === needle) ??
    ports.find((p) => (p.port_hints ?? []).some((h) => h.toLowerCase() === needle))
  )
}

export const resolveComponent = (view: IndexedView, nameOrId: string): Component | undefined =>
  view.componentsByName.get(nameOrId) ?? view.components.get(nameOrId)

export const resolveNet = (view: IndexedView, nameOrId: string): Net | undefined =>
  view.netsByName.get(nameOrId) ?? view.nets.get(nameOrId)

/** Human-readable location for an error or ERC violation: `U1 pin 3 (VCC)`. */
export const describePort = (view: IndexedView, port: Port): string => {
  const component = port.source_component_id
    ? view.components.get(port.source_component_id)
    : undefined
  const owner = component?.name ?? port.source_component_id ?? "(unattached port)"
  const label = port.name && port.name !== `pin${port.pin_number}` ? ` (${port.name})` : ""
  return `${owner} pin ${port.pin_number}${label}`
}

/**
 * Every port transitively connected to the given one, following traces and nets.
 *
 * This is the connectivity primitive ERC is built on: a "net" in the electrical sense is
 * this closure, not necessarily a single `source_net` element.
 */
export const connectedPorts = (view: IndexedView, portId: string): Set<string> => {
  const seen = new Set<string>([portId])
  const queue = [portId]

  while (queue.length > 0) {
    const current = queue.pop() as string
    for (const trace of view.tracesByPort.get(current) ?? []) {
      for (const other of trace.connected_source_port_ids ?? []) {
        if (!seen.has(other)) {
          seen.add(other)
          queue.push(other)
        }
      }
      // A trace that names a net joins every port on that net.
      for (const netId of trace.connected_source_net_ids ?? []) {
        for (const other of view.portsByNet.get(netId) ?? []) {
          if (!seen.has(other)) {
            seen.add(other)
            queue.push(other)
          }
        }
      }
    }
  }

  return seen
}

/**
 * All electrical nets in the design, as sets of port ids, plus the net name where one
 * is known. Two ports are on the same net when a chain of traces joins them.
 */
export interface ElectricalNet {
  ports: Set<string>
  netIds: Set<string>
  name?: string
}

export const electricalNets = (view: IndexedView): ElectricalNet[] => {
  const assigned = new Set<string>()
  const nets: ElectricalNet[] = []

  for (const portId of view.ports.keys()) {
    if (assigned.has(portId)) continue

    const ports = connectedPorts(view, portId)
    for (const id of ports) assigned.add(id)

    const netIds = new Set<string>()
    for (const id of ports) {
      for (const trace of view.tracesByPort.get(id) ?? []) {
        for (const netId of trace.connected_source_net_ids ?? []) netIds.add(netId)
      }
    }

    const first = [...netIds][0]
    const name = first ? view.nets.get(first)?.name : undefined
    nets.push({ ports, netIds, ...(name ? { name } : {}) })
  }

  return nets
}
