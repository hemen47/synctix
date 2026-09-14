/**
 * ELK-based schematic layout.
 *
 * The LLM supplies semantic hints; this turns them into coordinates (principle 4).
 *
 * Three rules govern the result:
 *   1. Manual overrides always win. A human who dragged a symbol does not want it moved.
 *   2. Power and ground become net labels at the pin, not wires to a distant rail.
 *   3. Everything lands on the 1.27 mm grid, because off-grid pins do not connect in
 *      most EDA tools.
 */

import ELK from "elkjs/lib/elk.bundled.js"
import type { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk-api"
import type { AnyCircuitElement } from "circuit-json"
import type { Design } from "@syntrix/core"
import { buildIndex, electricalNets, findPlacement } from "@syntrix/core"
import type { Result, ValidationError } from "@syntrix/shared"
import {
  err,
  newElementId,
  ok,
  snapToGrid,
  validationError,
  SCHEMATIC_GRID_MM,
} from "@syntrix/shared"
import type { LayoutOptions, LayoutResult, LayoutStrategy, PortSide } from "./types"
import { PIN_PITCH_MM, isRailNet, isGroundNet, sideForPin, symbolSize } from "./conventions"

const ELK_SIDE: Record<PortSide, string> = {
  north: "NORTH",
  south: "SOUTH",
  east: "EAST",
  west: "WEST",
}

const FACING: Record<PortSide, "up" | "down" | "left" | "right"> = {
  // A pin on the west edge points left, away from the body.
  north: "up",
  south: "down",
  east: "right",
  west: "left",
}

interface PortPlan {
  portId: string
  side: PortSide
  pinNumber: number
}

/** Everything layout needs to know about one component, gathered before ELK runs. */
interface ComponentPlan {
  componentId: string
  name: string
  ftype: string
  size: { width: number; height: number }
  ports: PortPlan[]
  pinned?: { x: number; y: number }
}

/** Pins grouped by the side they sit on, in a stable order. */
const groupBySide = (ports: PortPlan[]): Array<[PortSide, PortPlan[]]> => {
  const bySide = new Map<PortSide, PortPlan[]>()
  for (const port of ports) {
    const list = bySide.get(port.side) ?? []
    list.push(port)
    bySide.set(port.side, list)
  }
  // Sorted by pin number within a side, so pin 1 is above pin 2 on a west edge rather
  // than wherever the port list happened to put it.
  for (const list of bySide.values()) list.sort((a, b) => a.pinNumber - b.pinNumber)
  return [...bySide.entries()]
}

/**
 * A point on the symbol's edge, `offset` along that edge from its midpoint.
 *
 * Pins sit half a pitch outside the body, which is where a wire should meet them: a pin
 * drawn flush with the outline has nowhere for its stub to go.
 */
const edgePosition = (
  side: PortSide,
  cx: number,
  cy: number,
  width: number,
  height: number,
  offset: number,
): { x: number; y: number } => {
  const gap = PIN_PITCH_MM / 2
  switch (side) {
    case "west":
      return { x: cx - width / 2 - gap, y: cy + offset }
    case "east":
      return { x: cx + width / 2 + gap, y: cy + offset }
    case "north":
      return { x: cx + offset, y: cy - height / 2 - gap }
    case "south":
      return { x: cx + offset, y: cy + height / 2 + gap }
  }
}

export class ElkLayoutStrategy implements LayoutStrategy {
  readonly id = "elk"
  readonly label = "Layered (ELK)"

  private readonly elk = new ELK()

  async layout(
    design: Design,
    options: LayoutOptions = {},
  ): Promise<Result<LayoutResult, ValidationError[]>> {
    const grid = options.gridMm ?? SCHEMATIC_GRID_MM
    const spacing = options.spacingMm ?? 5.08
    const useLabels = options.useNetLabelsForPower ?? true
    const view = buildIndex(design.circuit)

    if (view.components.size === 0) {
      return ok({
        elements: [],
        bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
        unsatisfiedConstraints: [],
      })
    }

    // ---- plan -------------------------------------------------------------
    const plans: ComponentPlan[] = []
    for (const component of view.components.values()) {
      const ports = view.portsByComponent.get(component.source_component_id) ?? []
      const ftype = component.ftype ?? "simple_chip"
      // A manual edit is a placement the user chose. It wins outright (ADR-0013), and
      // it is keyed by component name rather than id so it survives a TSX recompile.
      const placement = findPlacement(design.manualEdits, "schematic", component.name)

      plans.push({
        componentId: component.source_component_id,
        name: component.name,
        ftype,
        size: symbolSize(ftype, ports.length),
        ports: ports.map((port, index) => ({
          portId: port.source_port_id,
          side: sideForPin(port, ftype, index, ports.length),
          pinNumber: port.pin_number ?? index + 1,
        })),
        // Rule 1: a manual placement is a fixed position, not a suggestion.
        ...(placement ? { pinned: placement.center } : {}),
      })
    }

    // ---- which nets are drawn as labels -----------------------------------
    const railNetIds = new Set<string>()
    if (useLabels) {
      for (const net of view.nets.values()) {
        const record = net as unknown as Record<string, unknown>
        if (isRailNet(net.name, Boolean(record["is_power"]), Boolean(record["is_ground"]))) {
          railNetIds.add(net.source_net_id)
        }
      }
    }

    // A trace is routed as a wire unless every net it names is a rail.
    const wiredTraces = [...view.traces.values()].filter((trace) => {
      const nets = trace.connected_source_net_ids ?? []
      if (nets.length === 0) return true
      return !nets.every((id) => railNetIds.has(id))
    })

    // ---- build the ELK graph ----------------------------------------------
    const graph: ElkNode = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": options.direction ?? "RIGHT",
        "elk.portConstraints": "FIXED_SIDE",
        "elk.spacing.nodeNode": String(spacing),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(spacing * 1.5),
        // Orthogonal edges: schematics are drawn with right angles, not splines.
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.mergeEdges": "true",
      },
      children: plans.map((plan) => ({
        id: plan.componentId,
        width: plan.size.width,
        height: plan.size.height,
        // A pinned position is applied after layout, not through ELK: `elk.position`
        // orders a node within its layer, it does not place it at absolute
        // coordinates. Rule 1 has to be enforced by us.
        ports: plan.ports.map((port) => ({
          id: port.portId,
          width: 0.1,
          height: 0.1,
          layoutOptions: { "elk.port.side": ELK_SIDE[port.side] },
        })),
      })),
      edges: wiredTraces.flatMap((trace): ElkExtendedEdge[] => {
        const ports = trace.connected_source_port_ids ?? []
        // ELK edges are pairwise; a multi-point trace becomes a chain of them.
        const pairs: ElkExtendedEdge[] = []
        for (let i = 0; i + 1 < ports.length; i += 1) {
          pairs.push({
            id: `${trace.source_trace_id}__${i}`,
            sources: [ports[i] as string],
            targets: [ports[i + 1] as string],
          } as ElkExtendedEdge)
        }
        return pairs
      }),
    }

    let laid: ElkNode
    try {
      laid = await this.elk.layout(graph)
    } catch (cause) {
      return err([
        validationError(
          "LAYOUT_FAILED",
          `Layout failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          "This usually means a trace references a port that no longer exists. Run ERC to find dangling references.",
        ),
      ])
    }

    // ---- convert back to circuit-json -------------------------------------
    const elements: AnyCircuitElement[] = []
    const portCenters = new Map<string, { x: number; y: number }>()
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const node of laid.children ?? []) {
      const plan = plans.find((p) => p.componentId === node.id)
      if (!plan) continue

      const width = node.width ?? plan.size.width
      const height = node.height ?? plan.size.height

      // ELK reports a node's top-left corner; circuit-json wants its centre.
      // A pinned override replaces ELK's answer outright — a human who dragged a symbol
      // does not want it moved, even if that leaves it overlapping something.
      const originX = plan.pinned ? plan.pinned.x : (node.x ?? 0)
      const originY = plan.pinned ? plan.pinned.y : (node.y ?? 0)
      const cx = snapToGrid(originX + width / 2, grid)
      const cy = snapToGrid(originY + height / 2, grid)

      minX = Math.min(minX, cx - width / 2)
      minY = Math.min(minY, cy - height / 2)
      maxX = Math.max(maxX, cx + width / 2)
      maxY = Math.max(maxY, cy + height / 2)

      const schematicComponentId = newElementId("schematic_component")
      elements.push({
        type: "schematic_component",
        schematic_component_id: schematicComponentId,
        source_component_id: plan.componentId,
        center: { x: cx, y: cy },
        size: { width, height },
      } as AnyCircuitElement)

      // Pin positions are computed here rather than taken from ELK.
      //
      // ELK assigns port coordinates as a side effect of routing, so a component with no
      // edges yet — every component, the moment it is placed — gets every port at the
      // node origin, stacking a resistor's two pins on the same point. That draws as one
      // pin, makes the other unclickable, and lets a wire attach to whichever the hit
      // test happened to find first.
      //
      // The side each pin belongs on is already decided by the schematic conventions, and
      // the symbol's size is known, so the edge position is ours to compute: spread the
      // pins on each side along that edge at the standard pitch, centred.
      for (const [side, pinsOnSide] of groupBySide(plan.ports)) {
        pinsOnSide.forEach((portPlan, index) => {
          const offset = (index - (pinsOnSide.length - 1) / 2) * PIN_PITCH_MM
          const { x, y } = edgePosition(side, cx, cy, width, height, offset)
          const px = snapToGrid(x, grid)
          const py = snapToGrid(y, grid)
          portCenters.set(portPlan.portId, { x: px, y: py })

          elements.push({
            type: "schematic_port",
            schematic_port_id: newElementId("schematic_port"),
            source_port_id: portPlan.portId,
            schematic_component_id: schematicComponentId,
            center: { x: px, y: py },
            facing_direction: FACING[portPlan.side],
            distance_from_component_edge: PIN_PITCH_MM / 2,
            pin_number: portPlan.pinNumber,
          } as AnyCircuitElement)
        })
      }
    }

    // ---- wires -------------------------------------------------------------
    //
    // Wires are routed per *electrical net*, not per trace. Most connections in a real
    // design are port-to-net ("connect R1.1 to VIN"), which is a trace with a single
    // port — there is no second endpoint to draw to. What the reader needs to see is
    // that every pin on a net is joined, so the net is the unit of routing.
    for (const net of electricalNets(view)) {
      // Rails are drawn as labels instead; see below.
      if (useLabels && [...net.netIds].some((id) => railNetIds.has(id))) continue

      const members = [...net.ports]
        .map((portId) => ({ portId, center: portCenters.get(portId) }))
        .filter(
          (m): m is { portId: string; center: { x: number; y: number } } => m.center !== undefined,
        )
        // Left to right, then top to bottom: a stable order makes the chain
        // deterministic and keeps wires flowing with the signal.
        .sort((a, b) => a.center.x - b.center.x || a.center.y - b.center.y)

      if (members.length < 2) continue

      const edges: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }> = []
      for (let i = 0; i + 1 < members.length; i += 1) {
        const from = members[i]!.center
        const to = members[i + 1]!.center

        // Manhattan dogleg. ELK computes its own edge sections, but our node centres
        // were snapped to the grid afterwards, so re-deriving the route here keeps
        // wires meeting pins exactly rather than near them.
        if (from.x !== to.x && from.y !== to.y) {
          const corner = { x: to.x, y: from.y }
          edges.push({ from, to: corner }, { from: corner, to })
        } else {
          edges.push({ from, to })
        }
      }

      if (edges.length === 0) continue

      // A net formed by exactly one trace can carry that trace's id; a net stitched
      // from several cannot claim any single one.
      const sourceTraceIds = new Set<string>()
      for (const portId of net.ports) {
        for (const trace of view.tracesByPort.get(portId) ?? []) {
          sourceTraceIds.add(trace.source_trace_id)
        }
      }
      const singleTrace = sourceTraceIds.size === 1 ? [...sourceTraceIds][0] : undefined

      elements.push({
        type: "schematic_trace",
        schematic_trace_id: newElementId("schematic_trace"),
        ...(singleTrace ? { source_trace_id: singleTrace } : {}),
        edges,
        // Junction detection needs the whole drawing; computed below.
        junctions: [],
      } as AnyCircuitElement)
    }

    // ---- rail labels -------------------------------------------------------
    const unsatisfied: LayoutResult["unsatisfiedConstraints"] = []

    if (useLabels) {
      for (const net of electricalNets(view)) {
        const railId = [...net.netIds].find((id) => railNetIds.has(id))
        if (!railId) continue

        const netElement = view.nets.get(railId)
        const record = netElement as unknown as Record<string, unknown> | undefined
        const ground = isGroundNet(netElement?.name, Boolean(record?.["is_ground"]))

        for (const portId of net.ports) {
          const center = portCenters.get(portId)
          if (!center) continue

          elements.push({
            type: "schematic_net_label",
            schematic_net_label_id: newElementId("schematic_net_label"),
            source_net_id: railId,
            // Offset clear of the pin: ground below, supply above.
            center: {
              x: center.x,
              y: snapToGrid(center.y + (ground ? -PIN_PITCH_MM : PIN_PITCH_MM), grid),
            },
            anchor_side: ground ? "top" : "bottom",
            text: netElement?.name ?? "",
          } as AnyCircuitElement)
        }
      }
    }

    // ---- junctions ---------------------------------------------------------
    addJunctions(elements)

    // ---- unsatisfied hints --------------------------------------------------
    for (const [elementId, meta] of Object.entries(design.meta)) {
      for (const constraint of meta.constraints ?? []) {
        if (constraint.kind !== "near" && constraint.kind !== "decoupling_for") continue
        const target = constraint.kind === "near" ? constraint.target : constraint.component
        const self = elements.find(
          (e) => e.type === "schematic_component" && e.source_component_id === elementId,
        )
        const other = [...view.componentsByName.values()].find((c) => c.name === target)
        if (!self || !other) continue

        const otherElement = elements.find(
          (e) =>
            e.type === "schematic_component" && e.source_component_id === other.source_component_id,
        )
        if (!otherElement) continue

        const a = (self as { center: { x: number; y: number } }).center
        const b = (otherElement as { center: { x: number; y: number } }).center
        const distance = Math.hypot(a.x - b.x, a.y - b.y)
        const limit = constraint.kind === "near" ? (constraint.maxDistanceMm ?? 15) : 15

        // Reported rather than silently dropped: the caller decides whether to care.
        if (distance > limit) {
          unsatisfied.push({
            component: view.components.get(elementId)?.name ?? elementId,
            reason: `wanted within ${limit}mm of ${target}, placed ${distance.toFixed(1)}mm away`,
          })
        }
      }
    }

    return ok({
      elements,
      bounds: {
        minX: Number.isFinite(minX) ? minX : 0,
        minY: Number.isFinite(minY) ? minY : 0,
        maxX: Number.isFinite(maxX) ? maxX : 0,
        maxY: Number.isFinite(maxY) ? maxY : 0,
      },
      unsatisfiedConstraints: unsatisfied,
    })
  }
}

/**
 * Mark points where three or more wire ends meet.
 *
 * Without a junction dot, a schematic cannot distinguish a crossing from a connection —
 * the single most consequential piece of notation on the drawing.
 */
const addJunctions = (elements: AnyCircuitElement[]): void => {
  const counts = new Map<string, number>()
  const key = (p: { x: number; y: number }) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`

  const traces = elements.filter(
    (e): e is Extract<AnyCircuitElement, { type: "schematic_trace" }> =>
      e.type === "schematic_trace",
  )

  for (const trace of traces) {
    for (const edge of trace.edges ?? []) {
      for (const point of [edge.from, edge.to]) {
        if (!point) continue
        counts.set(key(point), (counts.get(key(point)) ?? 0) + 1)
      }
    }
  }

  for (const trace of traces) {
    const junctions: Array<{ x: number; y: number }> = []
    const seen = new Set<string>()
    for (const edge of trace.edges ?? []) {
      for (const point of [edge.from, edge.to]) {
        if (!point) continue
        const k = key(point)
        // Two ends meeting is a corner or a pin; three or more is a junction.
        if ((counts.get(k) ?? 0) >= 3 && !seen.has(k)) {
          seen.add(k)
          junctions.push({ x: point.x, y: point.y })
        }
      }
    }
    trace.junctions = junctions
  }
}

export const elkLayoutStrategy = new ElkLayoutStrategy()
