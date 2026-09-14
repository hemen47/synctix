/**
 * The editor state machine.
 *
 * Every interaction — clicking, dragging, pressing W — goes through `reduce`, which
 * takes the current mode and an input event and returns a new mode plus, when the
 * interaction completed something, the **Operations** to submit.
 *
 * That last part is the whole point. The canvas never mutates a design (principle 2): it
 * decides what the user meant and emits typed Operations for `@syntrix/core` to validate
 * and apply. A drag that ends produces a `move_component`; a wire that lands on a pin
 * produces a `connect`. If core rejects one, the design simply does not change, and the
 * canvas redraws from whatever core says the design now is.
 */

import type { Operation } from "@syntrix/core"
import { hitOne, orthogonalRoute, snapForWiring, snapToGrid } from "./hit-test"
import type { EditorMode, PinNode, Point, Scene, SymbolNode } from "./types"

export interface EditorState {
  mode: EditorMode
  /** `source_component_id`s, so selection survives a relayout. */
  selection: string[]
  /** The wire being drawn, in world coordinates, for a preview. */
  pending?: Point[]
}

export type EditorEvent =
  | { type: "pointer_down"; at: Point; shiftKey?: boolean }
  | { type: "pointer_move"; at: Point }
  | { type: "pointer_up"; at: Point }
  | { type: "key"; key: string; ctrlKey?: boolean }
  | { type: "start_placing"; partRef: string; ftype: string }
  | { type: "cancel" }

export interface EditorResult {
  state: EditorState
  /** Submitted to core in order. Empty when the interaction is still in progress. */
  operations: Operation[]
}

export const initialState = (): EditorState => ({ mode: { kind: "idle" }, selection: [] })

/**
 * One step of the machine.
 *
 * Pure: same state and event, same result. The caller owns the scene and the design; this
 * function reads the scene and never writes anything.
 */
export const reduce = (state: EditorState, event: EditorEvent, scene: Scene): EditorResult => {
  switch (event.type) {
    case "start_placing":
      return {
        state: { ...state, mode: { kind: "placing", partRef: event.partRef, ftype: event.ftype } },
        operations: [],
      }

    case "cancel":
      // Esc always returns to idle and abandons whatever was in flight. A half-drawn wire
      // must never survive a cancel, or the next click continues it by surprise.
      return { state: { mode: { kind: "idle" }, selection: state.selection }, operations: [] }

    case "key":
      return handleKey(state, event, scene)

    case "pointer_down":
      return handlePointerDown(state, event, scene)

    case "pointer_move":
      return handlePointerMove(state, event, scene)

    case "pointer_up":
      return handlePointerUp(state, event, scene)
  }
}

const handlePointerDown = (
  state: EditorState,
  event: Extract<EditorEvent, { type: "pointer_down" }>,
  scene: Scene,
): EditorResult => {
  switch (state.mode.kind) {
    case "placing": {
      // Placing is one click: add the component, then place it where the click landed.
      // Two operations rather than one, because `add_component` does not take a position
      // — geometry is computed, and a click is a manual edit (principle 4, ADR-0013).
      const at = snapToGrid(event.at)
      const name = nextRefdes(scene, state.mode.ftype)
      return {
        state: { ...state, mode: { kind: "idle" } },
        operations: [
          { type: "add_component", partRef: state.mode.partRef, name, props: {} },
          { type: "move_component", component: name, center: at, layer: "schematic" },
        ],
      }
    }

    case "wiring": {
      const snapped = snapForWiring(scene, event.at)
      if (snapped.pin && snapped.pin.sourcePortId !== state.mode.from.sourcePortId) {
        return {
          state: { mode: { kind: "idle" }, selection: state.selection },
          operations: [connectOperation(scene, state.mode.from, snapped.pin)],
        }
      }
      // Not a pin: record a corner and keep drawing.
      return {
        state: {
          ...state,
          mode: { ...state.mode, waypoints: [...state.mode.waypoints, snapped.point] },
        },
        operations: [],
      }
    }

    default: {
      const hit = hitOne(scene, event.at)

      if (hit?.kind === "pin") {
        return {
          state: { ...state, mode: { kind: "wiring", from: hit, waypoints: [] } },
          operations: [],
        }
      }

      if (hit?.kind === "symbol") {
        const selection = event.shiftKey
          ? toggle(state.selection, hit.sourceComponentId)
          : [hit.sourceComponentId]
        return {
          state: {
            selection,
            mode: {
              kind: "dragging",
              symbolId: hit.sourceComponentId,
              grabOffset: {
                x: event.at.x - hit.bounds.center.x,
                y: event.at.y - hit.bounds.center.y,
              },
            },
          },
          operations: [],
        }
      }

      // Empty space: start a rubber band, and clear the selection unless extending it.
      return {
        state: {
          selection: event.shiftKey ? state.selection : [],
          mode: { kind: "selecting", origin: event.at, current: event.at },
        },
        operations: [],
      }
    }
  }
}

const handlePointerMove = (
  state: EditorState,
  event: Extract<EditorEvent, { type: "pointer_move" }>,
  scene: Scene,
): EditorResult => {
  switch (state.mode.kind) {
    case "wiring": {
      const snapped = snapForWiring(scene, event.at)
      const start = state.mode.from.at
      const corners = state.mode.waypoints
      const last = corners[corners.length - 1] ?? start
      return {
        state: {
          ...state,
          pending: [start, ...corners, ...orthogonalRoute(last, snapped.point).slice(1)],
        },
        operations: [],
      }
    }

    case "selecting":
      return { state: { ...state, mode: { ...state.mode, current: event.at } }, operations: [] }

    default:
      return { state, operations: [] }
  }
}

const handlePointerUp = (
  state: EditorState,
  event: Extract<EditorEvent, { type: "pointer_up" }>,
  scene: Scene,
): EditorResult => {
  switch (state.mode.kind) {
    case "dragging": {
      const { symbolId, grabOffset } = state.mode
      const symbol = scene.symbols.find((s) => s.sourceComponentId === symbolId)
      const center = snapToGrid({
        x: event.at.x - grabOffset.x,
        y: event.at.y - grabOffset.y,
      })

      // A drag that did not move anything is a click, not an edit: emitting a
      // move_component here would put a no-op in the operation log and consume an undo.
      if (symbol && samePoint(symbol.bounds.center, center)) {
        return { state: { ...state, mode: { kind: "idle" } }, operations: [] }
      }

      return {
        state: { ...state, mode: { kind: "idle" } },
        operations: symbol
          ? [{ type: "move_component", component: symbol.name, center, layer: "schematic" }]
          : [],
      }
    }

    case "selecting": {
      const { origin } = state.mode
      const selected = scene.symbols.filter((s) => inRect(s, origin, event.at))
      return {
        state: {
          mode: { kind: "idle" },
          selection: [
            ...new Set([...state.selection, ...selected.map((s) => s.sourceComponentId)]),
          ],
        },
        operations: [],
      }
    }

    default:
      return { state, operations: [] }
  }
}

const handleKey = (
  state: EditorState,
  event: Extract<EditorEvent, { type: "key" }>,
  scene: Scene,
): EditorResult => {
  const key = event.key.toLowerCase()

  if (key === "escape") return reduce(state, { type: "cancel" }, scene)

  if (event.ctrlKey && key === "z") {
    // Undo and redo are the api's business — they replay the operation log — so the
    // canvas reports the intent and submits nothing.
    return { state, operations: [] }
  }

  if (key === "delete" || key === "backspace") {
    return {
      state: { ...state, selection: [] },
      operations: state.selection.flatMap((id) => {
        const symbol = scene.symbols.find((s) => s.sourceComponentId === id)
        return symbol ? [{ type: "remove_component" as const, component: symbol.name }] : []
      }),
    }
  }

  if (key === "r") {
    return {
      state,
      operations: state.selection.flatMap((id) => {
        const symbol = scene.symbols.find((s) => s.sourceComponentId === id)
        if (!symbol) return []
        // Rotation is a move that keeps the position: manual placement and rotation are
        // written by the same operation, and rotating must not un-pin a symbol.
        return [
          {
            type: "move_component" as const,
            component: symbol.name,
            center: symbol.bounds.center,
            rotation: (symbol.rotationDeg + 90) % 360,
            layer: "schematic" as const,
          },
        ]
      }),
    }
  }

  if (key === "w") {
    // W starts a wire from the selected component's first unconnected pin, which is what
    // a keyboard-driven user means by it.
    const symbol = scene.symbols.find((s) => s.sourceComponentId === state.selection[0])
    const pin = symbol?.pins.find((p) => !p.connected) ?? symbol?.pins[0]
    return pin
      ? { state: { ...state, mode: { kind: "wiring", from: pin, waypoints: [] } }, operations: [] }
      : { state, operations: [] }
  }

  return { state, operations: [] }
}

/**
 * The `connect` for a completed wire.
 *
 * Addressed by component name and pin number rather than by port id: that is what the
 * agent and the REST API use, so a wire drawn by hand and a wire asked for in chat go
 * through the same code path and fail the same way.
 */
const connectOperation = (scene: Scene, from: PinNode, to: PinNode): Operation => ({
  type: "connect",
  a: { component: componentName(scene, from), pin: from.pinNumber },
  b: { component: componentName(scene, to), pin: to.pinNumber },
})

const componentName = (scene: Scene, pin: PinNode): string =>
  scene.symbols.find((s) => s.sourceComponentId === pin.sourceComponentId)?.name ??
  pin.sourceComponentId

/**
 * The next free refdes for an ftype.
 *
 * Core assigns one too, but the canvas needs the name *before* the operation is applied,
 * because the `move_component` that follows refers to it. Both walk the same rule, so
 * they agree unless two clients place a part in the same instant — at which point core's
 * duplicate-name check rejects the second, which is the correct outcome.
 */
const REFDES_PREFIX: Record<string, string> = {
  simple_resistor: "R",
  simple_capacitor: "C",
  simple_inductor: "L",
  simple_diode: "D",
  simple_led: "D",
  simple_chip: "U",
  simple_op_amp: "U",
  simple_ground: "GND",
  simple_power_source: "V",
  simple_transistor: "Q",
  simple_mosfet: "Q",
  simple_crystal: "Y",
  simple_fuse: "F",
}

export const nextRefdes = (scene: Scene, ftype: string): string => {
  const prefix = REFDES_PREFIX[ftype] ?? "U"
  const used = new Set(scene.symbols.map((s) => s.name))
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${prefix}${n}`
    if (!used.has(candidate)) return candidate
  }
  return `${prefix}1000`
}

const inRect = (symbol: SymbolNode, a: Point, b: Point): boolean =>
  symbol.bounds.center.x >= Math.min(a.x, b.x) &&
  symbol.bounds.center.x <= Math.max(a.x, b.x) &&
  symbol.bounds.center.y >= Math.min(a.y, b.y) &&
  symbol.bounds.center.y <= Math.max(a.y, b.y)

const samePoint = (a: Point, b: Point): boolean =>
  Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

const toggle = (list: string[], value: string): string[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
