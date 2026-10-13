/**
 * The scene graph the editor draws and clicks on.
 *
 * Framework-agnostic on purpose. Everything here is plain data and pure functions over
 * it, so the interesting parts — which symbol a point lands on, where a wire snaps, what
 * a drag does — are unit-testable without a browser. React's job is to turn a `Scene`
 * into SVG and turn events into calls back into this module; it owns no geometry.
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  /** Centre, matching circuit-json's own convention for schematic elements. */
  center: Point
  width: number
  height: number
}

/** What a hit test can land on, in the order the editor resolves ties. */
export type NodeKind = "pin" | "wire" | "label" | "symbol"

export interface SymbolNode {
  kind: "symbol"
  id: string
  /** `source_component_id` — what an Operation refers to. */
  sourceComponentId: string
  /** Refdes, drawn beside the symbol and used as the manual-edits selector. */
  name: string
  ftype: string
  /** The `schematic-symbols` entry this draws, e.g. "resistor_right". */
  symbolName?: string
  bounds: Rect
  rotationDeg: number
  /** Value as the author wrote it ("10k"), not the parsed number. */
  value?: string
  primitives: DrawPrimitive[]
  pins: PinNode[]
}

export interface PinNode {
  kind: "pin"
  id: string
  sourcePortId: string
  sourceComponentId: string
  /** Where the wire attaches, in world coordinates. */
  at: Point
  pinNumber: number
  label?: string
  /** True when something is already wired here — the editor draws these differently. */
  connected: boolean
}

export interface WireNode {
  kind: "wire"
  id: string
  /** Polyline in world coordinates; every segment is horizontal or vertical. */
  points: Point[]
  netName?: string
  /** Junction dots: where three or more wire ends meet. */
  junctions: Point[]
}

export interface LabelNode {
  kind: "label"
  id: string
  at: Point
  text: string
  /** Net labels and power symbols anchor differently from refdes text. */
  role: "refdes" | "value" | "net" | "power" | "ground"
  anchor: "start" | "middle" | "end"
}

export type SceneNode = SymbolNode | PinNode | WireNode | LabelNode

/** One drawable, already in world coordinates. Mirrors `schematic-symbols` primitives. */
export type DrawPrimitive =
  | { type: "path"; points: Point[]; closed?: boolean; fill?: boolean; strokeWidth?: number }
  | { type: "circle"; at: Point; radius: number; fill?: boolean }
  | { type: "box"; center: Point; width: number; height: number }
  | { type: "text"; at: Point; text: string; fontSize: number; anchor: "start" | "middle" | "end" }

export interface Scene {
  symbols: SymbolNode[]
  wires: WireNode[]
  labels: LabelNode[]
  /** Everything's extent in mm, for an initial viewport fit. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export interface HitResult {
  node: SceneNode
  /** Distance in mm from the query point; 0 when inside a shape. */
  distance: number
}

/** What the canvas is doing right now. The editor is a small state machine. */
export type EditorMode =
  | { kind: "idle" }
  | { kind: "placing"; partRef: string; ftype: string }
  | { kind: "wiring"; from: PinNode; waypoints: Point[] }
  /**
   * `preview` is where the symbol is being shown *right now*, snapped to the grid.
   *
   * Without it a drag showed nothing until the button came up and the server answered:
   * the symbol sat still under a moving cursor and then jumped. Keeping the preview in
   * the mode rather than in the renderer means the drawn position and the position that
   * will be submitted are the same value, so what the user releases over is what they get.
   */
  | { kind: "dragging"; symbolId: string; grabOffset: Point; preview?: Point }
  | { kind: "selecting"; origin: Point; current: Point }

export interface Viewport {
  /** World mm at the top-left of the visible area. */
  offset: Point
  /** Pixels per mm. */
  scale: number
  widthPx: number
  heightPx: number
}
