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
import {
  ApiError,
  api,
  runAgent,
  type AgentStatus,
  type DesignResponse,
  type ErcReport,
  type TraceEvent,
  type ViewName,
} from "./api"

/**
 * One turn in the chat.
 *
 * The trace lives on the assistant turn rather than in a separate log, because that is
 * how it is read: "what did it do when I asked for that", not "what happened at 14:32".
 * A turn keeps its trace after the run ends, so scrolling back explains an old answer.
 */
export interface ChatTurn {
  id: string
  role: "user" | "assistant"
  text: string
  trace: TraceEvent[]
  /** Set while the run is in flight, so the bubble can show it is still working. */
  running?: boolean
  error?: { message: string; hint?: string }
  summary?: {
    iterations: number
    toolCalls: number
    erc: { pass: boolean; errorCount: number; warningCount: number }
    stopReason: string
  }
}

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

  /** Which viewer pane is showing. The schematic is the editable one. */
  view: ViewName
  chat: ChatTurn[]
  agent?: AgentStatus
  /** Cancels the run in flight. Its presence is what "a run is in flight" means. */
  cancelRun?: () => void

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

  setView(view: ViewName): void
  loadAgentStatus(): Promise<void>
  ask(prompt: string): Promise<void>
  stopRun(): void
  clearChat(): void
  /** Route the board through tscircuit's autorouter, so the PCB views have something. */
  routeBoard(): Promise<void>
  download(format: string): Promise<void>
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
  view: "schematic",
  chat: [],

  async open(id) {
    set({ busy: true, problem: undefined })
    try {
      const design = await api.getDesign(id)
      set({ designId: id, ...(await withLayout(id, design)) })

      // The view is deliberately not fitted here. Auto-fitting on open was tried and
      // reverted: it makes a reload move the drawing under the cursor, so a click does
      // not land where the last one did, and the e2e suite asserts that stability. The
      // legibility problem it was meant to solve is handled by the default zoom instead,
      // and Fit is one button away.
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
      // The design and the drawing are published in one `set`, never two.
      //
      // Setting the design first and relaying out afterwards left a window — one network
      // round trip wide — in which the status bar said "v3" while the canvas was still
      // drawing v2. A drag was the visible case: the symbol snapped back to where it
      // started, sat there, and then jumped to the new position when the layout arrived.
      // It reads as a canvas fighting the cursor, and it is what makes an editor feel
      // broken rather than slow.
      set({ ...(await withLayout(designId, updated)), busy: false })
    } catch (error) {
      set({ problem: describe(error) })
      // A rejected operation means our version may be stale; re-read rather than guess.
      if (error instanceof ApiError && error.status === 409) {
        set(await withLayout(designId, await api.getDesign(designId)))
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
    // Idle pointer movement means nothing to the state machine, and dispatching it anyway
    // ran `reduce` and a store write on every pixel of cursor travel across the canvas —
    // for a scene the result was identical to. Dropping it is most of the difference
    // between a canvas that feels heavy and one that does not.
    if (kind === "move" && get().editor.mode.kind === "idle") return

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

  setView(view) {
    set({ view })
  },

  async loadAgentStatus() {
    try {
      set({ agent: await api.agentStatus() })
    } catch {
      // A status probe that fails is not worth a banner. The chat panel treats a missing
      // status as "unknown" and lets the run itself report the real problem.
      set({ agent: { available: false, roles: [], detail: "The agent status is unavailable." } })
    }
  },

  /**
   * Ask the agent for something.
   *
   * The user's turn and an empty assistant turn are pushed before the request goes out, so
   * the panel shows the question immediately and has somewhere to stream into. Trace
   * events land on that turn as they arrive.
   */
  async ask(prompt) {
    const { designId, cancelRun } = get()
    if (!designId || cancelRun) return

    const turnId = `turn_${Date.now()}`
    set({
      chat: [
        ...get().chat,
        { id: `${turnId}_u`, role: "user", text: prompt, trace: [] },
        { id: turnId, role: "assistant", text: "", trace: [], running: true },
      ],
      problem: undefined,
    })

    const patch = (change: Partial<ChatTurn>): void => {
      set({
        chat: get().chat.map((turn) => (turn.id === turnId ? { ...turn, ...change } : turn)),
      })
    }

    await new Promise<void>((resolve) => {
      const cancel = runAgent(designId, prompt, {
        onTrace: (event) => {
          const turn = get().chat.find((t) => t.id === turnId)
          if (!turn) return

          // The model's prose is the answer; everything else is the trace. Keeping the
          // last message as the turn's text means a long run still reads as a reply.
          patch({
            trace: [...turn.trace, event],
            ...(event.kind === "message" ? { text: event.text } : {}),
          })
        },

        onDone: (done) => {
          patch({
            text: done.text || get().chat.find((t) => t.id === turnId)?.text || "",
            running: false,
            summary: {
              iterations: done.iterations,
              toolCalls: done.toolCalls,
              erc: done.erc,
              stopReason: done.stopReason,
            },
          })
        },

        onError: (message, hint) => {
          patch({ running: false, error: { message, ...(hint ? { hint } : {}) } })
        },
      })

      set({
        cancelRun: () => {
          cancel()
          patch({ running: false, error: { message: "Stopped." } })
          resolve()
        },
      })

      // The stream ending is what resolves this, via whichever terminal handler fired.
      const settle = setInterval(() => {
        if (!get().chat.find((t) => t.id === turnId)?.running) {
          clearInterval(settle)
          resolve()
        }
      }, 120)
    })

    set({ cancelRun: undefined })

    // The design has almost certainly changed. Re-read it rather than trusting the
    // stream: the document is an addressable resource and this is the one path to it.
    const id = get().designId
    if (id) {
      try {
        set(await withLayout(id, await api.getDesign(id)))
        // ERC after an agent run, always. The loop guarantees it ran server-side; this
        // puts the result in the inspector so the user sees it without asking.
        await get().runErc()
      } catch (error) {
        set({ problem: describe(error) })
      }
    }
  },

  stopRun() {
    get().cancelRun?.()
  },

  clearChat() {
    if (get().cancelRun) return
    set({ chat: [] })
  },

  async routeBoard() {
    const { designId } = get()
    if (!designId) return

    set({ busy: true, problem: undefined })
    try {
      const routed = await api.route(designId)
      set(await withLayout(designId, await api.getDesign(designId)))
      if (routed.routingFailed) {
        set({
          problem: {
            message: "The autorouter could not complete every trace.",
            hint: "Some connections are unrouted. Try moving parts apart, or route the rest by hand.",
          },
        })
      }
    } catch (error) {
      set({ problem: describe(error) })
    } finally {
      set({ busy: false })
    }
  },

  /**
   * Export and save a file.
   *
   * The artifact comes back as text or base64 and is turned into a blob here. Server-side
   * download URLs would be tidier, but the export route is a POST returning JSON and
   * changing it to suit the browser would make it worse for every other caller.
   */
  async download(format) {
    const { designId } = get()
    if (!designId) return

    set({ busy: true, problem: undefined })
    try {
      const result = await api.exportDesign(designId, format)

      for (const artifact of result.artifacts) {
        const body = artifact.text
          ? new Blob([artifact.text], { type: artifact.mime })
          : new Blob([Uint8Array.from(atob(artifact.bytes ?? ""), (c) => c.charCodeAt(0))], {
              type: artifact.mime,
            })

        const url = URL.createObjectURL(body)
        const link = document.createElement("a")
        link.href = url
        link.download = artifact.filename
        document.body.append(link)
        link.click()
        link.remove()
        URL.revokeObjectURL(url)
      }
    } catch (error) {
      set({ problem: describe(error) })
    } finally {
      set({ busy: false })
    }
  },
}))

/**
 * A design plus the drawing that matches it, as one state patch.
 *
 * Every path that changes the document goes through this, so the version in the status
 * bar and the geometry on the canvas are always published together. Two separate `set`
 * calls can be observed in between; one cannot.
 */
const withLayout = async (
  designId: string,
  design: DesignResponse,
): Promise<Pick<State, "design" | "layoutElements" | "scene">> => {
  const layout = await api.layout(designId)
  return {
    design,
    layoutElements: layout.elements,
    scene: buildScene([...design.circuit, ...layout.elements]),
  }
}

const move = async (
  set: (partial: Partial<State>) => void,
  get: () => State,
  direction: "undo" | "redo",
): Promise<void> => {
  const { designId } = get()
  if (!designId) return

  set({ busy: true, problem: undefined })
  try {
    const design = direction === "undo" ? await api.undo(designId) : await api.redo(designId)
    set(await withLayout(designId, design))
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
