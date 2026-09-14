/**
 * Building a `Scene` from circuit-json.
 *
 * The input is the design's schematic layer — whatever `@syntrix/layout` last produced,
 * plus any manual placements. The output is drawable, hit-testable data with no React in
 * it. Symbol artwork comes from `schematic-symbols`, the same package the tscircuit
 * viewers draw with, so an editor symbol and a rendered export are the same shape rather
 * than two drawings of the same part.
 */

import { symbols as SYMBOL_LIBRARY, type SchSymbol } from "schematic-symbols"
import type { AnyCircuitElement } from "circuit-json"
import type { DrawPrimitive, LabelNode, PinNode, Point, Scene, SymbolNode, WireNode } from "./types"

/**
 * ftype → the `schematic-symbols` family name.
 *
 * The library names symbols by orientation (`resistor_right`, `resistor_up`), so the
 * family is chosen here and the orientation is applied from the component's rotation.
 */
const SYMBOL_FAMILY: Record<string, string> = {
  simple_resistor: "resistor",
  simple_capacitor: "capacitor",
  simple_inductor: "inductor",
  simple_diode: "diode",
  simple_led: "led",
  simple_ground: "ground",
  simple_power_source: "power_factor_meter",
  simple_crystal: "crystal",
  simple_fuse: "fuse",
  simple_mosfet: "mosfet_depletion_normally_on",
  simple_potentiometer: "potentiometer",
}

const ORIENTATIONS = ["right", "down", "left", "up"] as const

/**
 * The symbol for a component at a rotation.
 *
 * Rotation is expressed by choosing a different symbol rather than by rotating a
 * transform, because that is how `schematic-symbols` models it: a rotated resistor is a
 * different entry with its ports and its value text already in the right places. Rotating
 * the artwork ourselves would rotate the text with it.
 */
export const symbolFor = (ftype: string, rotationDeg = 0): SchSymbol | undefined => {
  const family = SYMBOL_FAMILY[ftype]
  if (!family) return undefined

  const steps = Math.round(((rotationDeg % 360) + 360) / 90) % 4
  const library = SYMBOL_LIBRARY as unknown as Record<string, SchSymbol | undefined>

  // Prefer the oriented name; fall back through the remaining orientations, then to the
  // horizontal/vertical spellings some families use instead.
  const candidates = [
    `${family}_${ORIENTATIONS[steps]}`,
    ...ORIENTATIONS.map((o) => `${family}_${o}`),
    `${family}_horz`,
    `${family}_vert`,
    family,
  ]
  for (const name of candidates) {
    const found = library[name]
    if (found) return found
  }
  return undefined
}

/** The library's own name for what `symbolFor` resolved, for the scene node. */
export const symbolNameFor = (ftype: string, rotationDeg = 0): string | undefined => {
  const family = SYMBOL_FAMILY[ftype]
  if (!family) return undefined
  const steps = Math.round(((rotationDeg % 360) + 360) / 90) % 4
  const library = SYMBOL_LIBRARY as unknown as Record<string, SchSymbol | undefined>
  const candidates = [
    `${family}_${ORIENTATIONS[steps]}`,
    ...ORIENTATIONS.map((o) => `${family}_${o}`),
    `${family}_horz`,
    `${family}_vert`,
    family,
  ]
  return candidates.find((name) => library[name])
}

type Indexed = Record<string, unknown>

/**
 * Build the scene.
 *
 * Reads only `schematic_*` elements: the source layer says what is connected, the
 * schematic layer says where it is drawn, and the canvas is about where things are.
 * A component with no `schematic_component` is simply not drawn — that is the state
 * between an agent's edit and the next relayout, and it should render as "not placed
 * yet" rather than as a symbol at the origin.
 */
export const buildScene = (
  elements: AnyCircuitElement[],
  options: { componentNames?: Map<string, string> } = {},
): Scene => {
  const names = options.componentNames ?? namesFromElements(elements)
  const connectedPorts = connectedPortIds(elements)

  const portsByComponent = new Map<string, Indexed[]>()
  for (const element of elements) {
    if (element.type !== "schematic_port") continue
    const record = element as unknown as Indexed
    const owner = record["schematic_component_id"]
    if (typeof owner !== "string") continue
    const list = portsByComponent.get(owner) ?? []
    list.push(record)
    portsByComponent.set(owner, list)
  }

  const symbols: SymbolNode[] = []
  for (const element of elements) {
    if (element.type !== "schematic_component") continue
    const record = element as unknown as Indexed
    const id = String(record["schematic_component_id"])
    const sourceComponentId = String(record["source_component_id"] ?? "")
    const center = asPoint(record["center"]) ?? { x: 0, y: 0 }
    const size = record["size"] as { width?: number; height?: number } | undefined
    const rotationDeg = Number(record["rotation"] ?? 0)
    const ftype = String(record["symbol_name"] ?? names.get(`${sourceComponentId}:ftype`) ?? "")

    const bounds = {
      center,
      width: Number(size?.width ?? 2.54),
      height: Number(size?.height ?? 1.27),
    }

    symbols.push({
      kind: "symbol",
      id,
      sourceComponentId,
      name: names.get(sourceComponentId) ?? sourceComponentId,
      ftype,
      ...(symbolNameFor(ftype, rotationDeg)
        ? { symbolName: symbolNameFor(ftype, rotationDeg)! }
        : {}),
      bounds,
      rotationDeg,
      primitives: primitivesFor(ftype, rotationDeg, bounds),
      pins: (portsByComponent.get(id) ?? []).map((port, index) => {
        const at = asPoint(port["center"]) ?? { x: center.x, y: center.y }
        const sourcePortId = String(port["source_port_id"] ?? "")
        const label = firstString(port["port_hints"]) ?? undefined
        return {
          kind: "pin" as const,
          id: String(port["schematic_port_id"] ?? `${id}:${index}`),
          sourcePortId,
          sourceComponentId,
          at,
          pinNumber: Number(port["pin_number"] ?? index + 1),
          ...(label ? { label } : {}),
          connected: connectedPorts.has(sourcePortId),
        }
      }),
    })
  }

  const wires: WireNode[] = []
  for (const element of elements) {
    if (element.type !== "schematic_trace") continue
    const record = element as unknown as Indexed
    const points = tracePoints(record)
    if (points.length < 2) continue
    wires.push({
      kind: "wire",
      id: String(record["schematic_trace_id"]),
      points,
      junctions:
        (record["junctions"] as Point[] | undefined)?.map((j) => ({ x: j.x, y: j.y })) ?? [],
    })
  }

  const labels: LabelNode[] = []
  for (const element of elements) {
    if (element.type !== "schematic_net_label") continue
    const record = element as unknown as Indexed
    const at = asPoint(record["center"]) ?? asPoint(record["anchor_position"])
    if (!at) continue
    const text = String(record["text"] ?? "")
    labels.push({
      kind: "label",
      id: String(record["schematic_net_label_id"]),
      at,
      text,
      role: /gnd|ground/i.test(text) ? "ground" : "net",
      anchor: "middle",
    })
  }

  // Refdes and value text are labels rather than part of the symbol artwork, so the
  // editor can move or hide them without touching the symbol.
  for (const symbol of symbols) {
    labels.push({
      kind: "label",
      id: `${symbol.id}:refdes`,
      at: { x: symbol.bounds.center.x, y: symbol.bounds.center.y - symbol.bounds.height / 2 - 0.9 },
      text: symbol.name,
      role: "refdes",
      anchor: "middle",
    })
    if (symbol.value) {
      labels.push({
        kind: "label",
        id: `${symbol.id}:value`,
        at: {
          x: symbol.bounds.center.x,
          y: symbol.bounds.center.y + symbol.bounds.height / 2 + 0.9,
        },
        text: symbol.value,
        role: "value",
        anchor: "middle",
      })
    }
  }

  return { symbols, wires, labels, bounds: sceneBounds(symbols, wires, labels) }
}

/** Symbol artwork in world coordinates, scaled from the library's unit symbol. */
const primitivesFor = (
  ftype: string,
  rotationDeg: number,
  bounds: { center: Point; width: number; height: number },
): DrawPrimitive[] => {
  const symbol = symbolFor(ftype, rotationDeg)
  if (!symbol) {
    // No library symbol: draw the box the layout engine reserved. A missing symbol should
    // look like a placeholder, not like nothing.
    return [{ type: "box", center: bounds.center, width: bounds.width, height: bounds.height }]
  }

  const sx = symbol.size.width > 0 ? bounds.width / symbol.size.width : 1
  const sy = symbol.size.height > 0 ? bounds.height / symbol.size.height : 1
  const place = (p: { x: number; y: number }): Point => ({
    x: bounds.center.x + (p.x - symbol.center.x) * sx,
    y: bounds.center.y + (p.y - symbol.center.y) * sy,
  })

  const out: DrawPrimitive[] = []
  for (const primitive of symbol.primitives) {
    switch (primitive.type) {
      case "path":
        out.push({
          type: "path",
          points: primitive.points.map(place),
          ...(primitive.closed ? { closed: true } : {}),
          ...(primitive.fill ? { fill: true } : {}),
          ...(primitive.strokeWidth ? { strokeWidth: primitive.strokeWidth * sx } : {}),
        })
        break
      case "circle":
        out.push({
          type: "circle",
          at: place(primitive),
          radius: primitive.radius * sx,
          ...(primitive.fill ? { fill: true } : {}),
        })
        break
      case "box":
        out.push({
          type: "box",
          center: place(primitive),
          width: primitive.width * sx,
          height: primitive.height * sy,
        })
        break
      case "text":
        // The library's `{REFDES}` and `{VAL}` placeholders are drawn as labels from the
        // real component, not as literal text.
        if (/^\{.*\}$/.test(primitive.text)) break
        out.push({
          type: "text",
          at: place(primitive),
          text: primitive.text,
          fontSize: (primitive.fontSize ?? 0.2) * sy,
          anchor: "middle",
        })
        break
    }
  }
  return out
}

const namesFromElements = (elements: AnyCircuitElement[]): Map<string, string> => {
  const names = new Map<string, string>()
  for (const element of elements) {
    if (element.type !== "source_component") continue
    const record = element as unknown as Indexed
    const id = String(record["source_component_id"])
    if (typeof record["name"] === "string") names.set(id, record["name"])
    if (typeof record["ftype"] === "string") names.set(`${id}:ftype`, record["ftype"])
  }
  return names
}

const connectedPortIds = (elements: AnyCircuitElement[]): Set<string> => {
  const connected = new Set<string>()
  for (const element of elements) {
    if (element.type !== "source_trace") continue
    const record = element as unknown as Indexed
    for (const id of (record["connected_source_port_ids"] as string[] | undefined) ?? []) {
      connected.add(id)
    }
  }
  return connected
}

/**
 * A trace's polyline.
 *
 * circuit-json spells this two ways depending on who produced it: `edges`, a list of
 * from/to segments, or a flat `route`. Both appear in documents we have to draw.
 */
const tracePoints = (record: Indexed): Point[] => {
  const edges = record["edges"] as Array<{ from?: Point; to?: Point }> | undefined
  if (edges?.length) {
    const points: Point[] = []
    for (const edge of edges) {
      const from = asPoint(edge.from)
      const to = asPoint(edge.to)
      if (from && (points.length === 0 || !samePoint(points[points.length - 1]!, from))) {
        points.push(from)
      }
      if (to) points.push(to)
    }
    return points
  }

  const route = record["route"] as Array<{ x?: number; y?: number }> | undefined
  return (route ?? []).flatMap((p) => (asPoint(p) ? [asPoint(p)!] : []))
}

const samePoint = (a: Point, b: Point): boolean =>
  Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9

const asPoint = (value: unknown): Point | undefined => {
  const p = value as { x?: unknown; y?: unknown } | undefined
  return typeof p?.x === "number" && typeof p?.y === "number" ? { x: p.x, y: p.y } : undefined
}

const firstString = (value: unknown): string | undefined => {
  const list = value as unknown[] | undefined
  const found = list?.find((v) => typeof v === "string")
  return typeof found === "string" ? found : undefined
}

const sceneBounds = (
  symbols: SymbolNode[],
  wires: WireNode[],
  labels: LabelNode[],
): Scene["bounds"] => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const include = (x: number, y: number): void => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  for (const symbol of symbols) {
    include(
      symbol.bounds.center.x - symbol.bounds.width / 2,
      symbol.bounds.center.y - symbol.bounds.height / 2,
    )
    include(
      symbol.bounds.center.x + symbol.bounds.width / 2,
      symbol.bounds.center.y + symbol.bounds.height / 2,
    )
  }
  for (const wire of wires) for (const p of wire.points) include(p.x, p.y)
  for (const label of labels) include(label.at.x, label.at.y)

  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
}
