/**
 * The schematic canvas.
 *
 * SVG, drawn straight from the scene graph. React's whole job here is to turn scene nodes
 * into elements and DOM events into world coordinates — every decision about what a click
 * means lives in `@syntrix/ui-canvas`, where it can be tested without a browser.
 *
 * Not React Flow, not a generic diagramming library. A schematic has pins that must land
 * exactly on a 1.27mm grid, wires that are electrical connections rather than decoration,
 * and symbols whose artwork comes from `schematic-symbols`. A generic canvas gives you
 * none of that and takes away control of all of it.
 */

import { useEffect, useRef } from "react"
import { toScreen, zoomAt, panBy, type DrawPrimitive, type Point } from "@syntrix/ui-canvas"
import { useEditor } from "./store"

export const Canvas = () => {
  const svgRef = useRef<SVGSVGElement>(null)
  const panning = useRef<Point | undefined>(undefined)

  const scene = useEditor((s) => s.scene)
  const viewport = useEditor((s) => s.viewport)
  const editor = useEditor((s) => s.editor)
  const selection = useEditor((s) => s.editor.selection)
  const pointer = useEditor((s) => s.pointer)
  const setViewport = useEditor((s) => s.setViewport)
  const dispatch = useEditor((s) => s.dispatch)

  // The view never moves on its own.
  //
  // An earlier version re-fitted whenever the scene changed, and it was wrong twice over:
  // the drawing jumped every time a part was placed, so the next click landed somewhere
  // the user had not aimed; and the mapping from a click to a world coordinate stopped
  // being something either a user or a test could predict. Fitting is a button now.

  // The viewport's size does have to track the DOM, so hit testing and Fit agree with it.
  useEffect(() => {
    const element = svgRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      const current = useEditor.getState().viewport
      if (current.widthPx !== width || current.heightPx !== height) {
        useEditor.getState().setViewport({ ...current, widthPx: width, heightPx: height })
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // Never steal a keystroke from a text field — Del in the parts search box must
      // delete a character, not a component.
      if (target && /^(input|textarea)$/i.test(target.tagName)) return

      if (event.ctrlKey && event.key.toLowerCase() === "z") {
        event.preventDefault()
        void (event.shiftKey ? useEditor.getState().redo() : useEditor.getState().undo())
        return
      }
      if (event.ctrlKey && event.key.toLowerCase() === "y") {
        event.preventDefault()
        void useEditor.getState().redo()
        return
      }
      dispatch({ type: "key", key: event.key, ctrlKey: event.ctrlKey })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [dispatch])

  const local = (event: React.PointerEvent | React.WheelEvent): Point => {
    const rect = svgRef.current!.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  return (
    <svg
      ref={svgRef}
      className="canvas"
      data-testid="canvas"
      onPointerDown={(event) => {
        const at = local(event)
        // Middle button and space-drag pan; left button edits.
        if (event.button === 1) {
          panning.current = at
          return
        }
        pointer("down", at.x, at.y, event.shiftKey)
      }}
      onPointerMove={(event) => {
        const at = local(event)
        if (panning.current) {
          setViewport(panBy(viewport, { x: at.x - panning.current.x, y: at.y - panning.current.y }))
          panning.current = at
          return
        }
        pointer("move", at.x, at.y)
      }}
      onPointerUp={(event) => {
        const at = local(event)
        if (panning.current) {
          panning.current = undefined
          return
        }
        pointer("up", at.x, at.y)
      }}
      onWheel={(event) => {
        const at = local(event)
        setViewport(zoomAt(viewport, at, event.deltaY < 0 ? 1.1 : 1 / 1.1))
      }}
    >
      <Grid viewport={viewport} />

      {scene.wires.map((wire) => (
        <polyline
          key={wire.id}
          className="wire"
          data-testid="wire"
          points={wire.points.map((p) => screen(viewport, p)).join(" ")}
        />
      ))}

      {scene.wires.flatMap((wire) =>
        wire.junctions.map((junction, index) => {
          const at = toScreen(viewport, junction)
          return (
            <circle key={`${wire.id}:j${index}`} className="junction" cx={at.x} cy={at.y} r={2.5} />
          )
        }),
      )}

      {scene.symbols.map((symbol) => (
        <g
          key={symbol.sourceComponentId}
          className={
            selection.includes(symbol.sourceComponentId) ? "symbol symbol--selected" : "symbol"
          }
          data-testid="symbol"
          data-name={symbol.name}
          // The symbol follows the cursor while it is being dragged. A transform on the
          // group rather than recomputed geometry: the scene is the server's answer and
          // must not be rewritten locally, and the drag ends by submitting an operation
          // that makes the real scene match.
          transform={dragTransform(
            editor,
            viewport,
            symbol.sourceComponentId,
            symbol.bounds.center,
          )}
        >
          {/* An invisible hit area over the whole symbol. Without it a click has to land
              exactly on a stroke, because artwork is a set of thin polylines with gaps
              between them — and a resistor is mostly gaps. */}
          <rect
            className="symbol__hit"
            x={
              toScreen(viewport, symbol.bounds.center).x -
              (symbol.bounds.width * viewport.scale) / 2
            }
            y={
              toScreen(viewport, symbol.bounds.center).y -
              (symbol.bounds.height * viewport.scale) / 2
            }
            width={symbol.bounds.width * viewport.scale}
            height={symbol.bounds.height * viewport.scale}
          />
          {symbol.primitives.map((primitive, index) => (
            <Primitive key={index} primitive={primitive} viewport={viewport} />
          ))}
          {symbol.pins.map((pin) => {
            const at = toScreen(viewport, pin.at)
            return (
              <circle
                key={pin.sourcePortId || pin.id}
                className={pin.connected ? "pin pin--connected" : "pin"}
                data-testid="pin"
                data-pin={`${symbol.name}.${pin.pinNumber}`}
                cx={at.x}
                cy={at.y}
                r={3}
              />
            )
          })}
        </g>
      ))}

      {scene.labels.map((label) => {
        const at = toScreen(viewport, label.at)
        return (
          <text
            key={label.id}
            className={`label label--${label.role}`}
            x={at.x}
            y={at.y}
            textAnchor={label.anchor}
          >
            {label.text}
          </text>
        )
      })}

      {/* The wire being drawn, before it is committed. */}
      {editor.pending && editor.pending.length > 1 && (
        <polyline
          className="wire wire--pending"
          data-testid="pending-wire"
          points={editor.pending.map((p) => screen(viewport, p)).join(" ")}
        />
      )}

      {editor.mode.kind === "selecting" && (
        <SelectionBox
          origin={editor.mode.origin}
          current={editor.mode.current}
          viewport={viewport}
        />
      )}
    </svg>
  )
}

const screen = (viewport: Parameters<typeof toScreen>[0], point: Point): string => {
  const at = toScreen(viewport, point)
  return `${at.x},${at.y}`
}

/**
 * The screen-space offset for a symbol being dragged, or `undefined` for every other one.
 *
 * Scaled by the viewport because the shift is expressed in world millimetres and applied
 * to a group already drawn in pixels.
 */
const dragTransform = (
  editor: { mode: { kind: string; symbolId?: string; preview?: Point } },
  viewport: { scale: number },
  symbolId: string,
  center: Point,
): string | undefined => {
  const { mode } = editor
  if (mode.kind !== "dragging" || mode.symbolId !== symbolId || !mode.preview) return undefined

  const dx = (mode.preview.x - center.x) * viewport.scale
  const dy = (mode.preview.y - center.y) * viewport.scale
  return `translate(${dx} ${dy})`
}

const Primitive = ({
  primitive,
  viewport,
}: {
  primitive: DrawPrimitive
  viewport: Parameters<typeof toScreen>[0]
}) => {
  switch (primitive.type) {
    case "path":
      return (
        <polyline
          className={primitive.fill ? "art art--filled" : "art"}
          points={primitive.points.map((p) => screen(viewport, p)).join(" ")}
        />
      )
    case "circle": {
      const at = toScreen(viewport, primitive.at)
      return (
        <circle
          className={primitive.fill ? "art art--filled" : "art"}
          cx={at.x}
          cy={at.y}
          r={primitive.radius * viewport.scale}
        />
      )
    }
    case "box": {
      const at = toScreen(viewport, primitive.center)
      const w = primitive.width * viewport.scale
      const h = primitive.height * viewport.scale
      return <rect className="art" x={at.x - w / 2} y={at.y - h / 2} width={w} height={h} />
    }
    case "text": {
      const at = toScreen(viewport, primitive.at)
      return (
        <text className="art-text" x={at.x} y={at.y} textAnchor={primitive.anchor}>
          {primitive.text}
        </text>
      )
    }
  }
}

const SelectionBox = ({
  origin,
  current,
  viewport,
}: {
  origin: Point
  current: Point
  viewport: Parameters<typeof toScreen>[0]
}) => {
  const a = toScreen(viewport, origin)
  const b = toScreen(viewport, current)
  return (
    <rect
      className="selection-box"
      x={Math.min(a.x, b.x)}
      y={Math.min(a.y, b.y)}
      width={Math.abs(b.x - a.x)}
      height={Math.abs(b.y - a.y)}
    />
  )
}

/**
 * The grid.
 *
 * Drawn as a pattern rather than as thousands of lines, and hidden when zoomed out far
 * enough that the dots would merge into a grey wash.
 */
const Grid = ({ viewport }: { viewport: Parameters<typeof toScreen>[0] }) => {
  const step = 1.27 * viewport.scale
  if (step < 6) return null

  const origin = toScreen(viewport, { x: 0, y: 0 })
  return (
    <>
      <defs>
        <pattern
          id="grid"
          width={step}
          height={step}
          patternUnits="userSpaceOnUse"
          x={origin.x % step}
          y={origin.y % step}
        >
          <circle cx={0} cy={0} r={0.8} className="grid-dot" />
        </pattern>
      </defs>
      <rect className="grid" width="100%" height="100%" fill="url(#grid)" />
    </>
  )
}
