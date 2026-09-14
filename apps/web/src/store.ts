/**
 * Editor state.
 *
 * Zustand holds what the UI needs and nothing else. The design itself is server state:
 * every change goes out as an Operation and the server's response replaces what we hold.
 * There is no local mutation and no optimistic update — a design that looked right in the
 * browser and was rejected by the engine is worse than one that takes 20ms to appear.
 *
 * The canvas geometry lives in `@syntrix/ui-canvas`; this file only routes events into it
 * and its operations back out to the API.
 */

import { create } from "zustand"
import {
  buildScene,
  createViewport,
  fitToScene,
  initialState as initialEditorState,
  reduce,
  toWorld,
  type EditorEvent,
  type EditorState,
  type Scene,
  type Viewport,
} from "@syntrix/ui-canvas"
import type { AnyCircuitElement } from "circuit-json"
import { ApiError, api, type DesignResponse, type ErcReport } from "./api"

interface State {
  designId?: string
  design?: DesignResponse
  /** Whatever the last layout produced. Kept apart from the design: it is derived. */
  layoutElements: AnyCircuitElement[]
  scene: Scene
  viewport: Viewport
  editor: EditorState
  erc?: ErcReport
  /** The last rejection, shown with the engine's own hint. */
  problem?: { message: string; hint?: string }
  busy: boolean

  open(id: string): Promise<void>
  createAndOpen(name: string): Promise<string>
  submit(operation: unknown): Promise<void>
  undo(): Promise<void>
  redo(): Promise<void>
  relayout(): Promise<void>
  runErc(): Promise<void>
  startPlacing(partRef: string, ftype: string): void
  dispatch(event: EditorEvent): void
  /** A pointer event in client pixels, relative to the canvas element. */
  pointer(kind: "down" | "move" | "up", px: number, py: number, shiftKey?: boolean): void
  setViewport(viewport: Viewport): void
  dismissProblem(): void
}

const EMPTY_SCENE: Scene = {
  symbols: [],
  wires: [],
  labels: [],
  bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
}

export const useEditor = create<State>((set, get) => ({
  layoutElements: [],
  scene: EMPTY_SCENE,
  // 8 px/mm with the origin at the top-left corner: a click at canvas (x, y) is world
  // (x/8, y/8), which is a mapping a person can hold in their head and a test can assert.
  viewport: createViewport(800, 600),
  editor: initialEditorState(),
  busy: false,

  async open(id) {
    set({ busy: true, problem: undefined })
    try {
      const design = await api.getDesign(id)
      set({ designId: id, design })
      await get().relayout()
    } catch (error) {
      set({ problem: describe(error) })
    } finally {
      set({ busy: false })
    }
  },

  async createAndOpen(name) {
    const created = await api.createDesign(name)
    await get().open(created.id)
    return created.id
  },

  async submit(operation) {
    const { designId, design } = get()
    if (!designId || !design) return

    set({ busy: true, problem: undefined })
    try {
      const updated = await api.submit(designId, operation, design.version)
      set({ design: updated })
      // Relayout after every change. Cheap at this scale, and it keeps the drawing and
      // the document from ever disagreeing — manual placements survive it by contract.
      await get().relayout()
    } catch (error) {
      set({ problem: describe(error) })
      // A rejected operation means our version may be stale; re-read rather than guess.
      if (error instanceof ApiError && error.status === 409) {
        set({ design: await api.getDesign(designId) })
        await get().relayout()
      }
    } finally {
      set({ busy: false })
    }
  },

  async undo() {
    await move(set, get, "undo")
  },

  async redo() {
    await move(set, get, "redo")
  },

  async relayout() {
    const { designId, design } = get()
    if (!designId || !design) return

    const result = await api.layout(designId)
    const scene = buildScene([...design.circuit, ...result.elements])
    set({ layoutElements: result.elements, scene })
  },

  async runErc() {
    const { designId } = get()
    if (!designId) return
    set({ erc: await api.erc(designId) })
  },

  startPlacing(partRef, ftype) {
    get().dispatch({ type: "start_placing", partRef, ftype })
  },

  dispatch(event) {
    const { editor, scene } = get()
    const result = reduce(editor, event, scene)
    set({ editor: result.state })

    // Operations are submitted in order and each waits for the last: two operations from
    // one gesture (add then move) would otherwise race on `expectedVersion`.
    void (async () => {
      for (const operation of result.operations) await get().submit(operation)
    })()
  },

  pointer(kind, px, py, shiftKey) {
    const at = toWorld(get().viewport, { x: px, y: py })
    get().dispatch(
      kind === "down"
        ? { type: "pointer_down", at, ...(shiftKey ? { shiftKey } : {}) }
        : kind === "move"
          ? { type: "pointer_move", at }
          : { type: "pointer_up", at },
    )
  },

  setViewport(viewport) {
    set({ viewport })
  },

  dismissProblem() {
    set({ problem: undefined })
  },
}))

const move = async (
  set: (partial: Partial<State>) => void,
  get: () => State,
  direction: "undo" | "redo",
): Promise<void> => {
  const { designId } = get()
  if (!designId) return

  set({ busy: true, problem: undefined })
  try {
    set({ design: direction === "undo" ? await api.undo(designId) : await api.redo(designId) })
    await get().relayout()
  } catch (error) {
    set({ problem: describe(error) })
  } finally {
    set({ busy: false })
  }
}

const describe = (error: unknown): { message: string; hint?: string } =>
  error instanceof ApiError
    ? { message: error.message, ...(error.hint ? { hint: error.hint } : {}) }
    : { message: error instanceof Error ? error.message : "Something went wrong." }

/** Frame the whole drawing. Bound to the Fit button — never called automatically. */
export const fitCurrentScene = (): void => {
  const { scene, viewport, setViewport } = useEditor.getState()
  setViewport(fitToScene(viewport, scene))
}

// Dev-only handle for end-to-end debugging; harmless in production and never imported.
if (typeof window !== "undefined") {
  ;(window as unknown as { __syntrix?: unknown }).__syntrix = useEditor
}
