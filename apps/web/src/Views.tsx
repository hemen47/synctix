/**
 * The viewer tabs: one editable schematic, three read-only renders.
 *
 * The schematic tab is our own SVG canvas, because editing needs hit testing, snapping and
 * an operation for every gesture. The other three are **tscircuit's own renderers**
 * (`circuit-to-svg`), served from `/designs/:id/render/:view` — building a second PCB
 * renderer to sit beside a working one would be exactly the mistake principle 1 exists to
 * prevent.
 *
 * They are `<img>` elements rather than inlined markup. An SVG dropped into the DOM brings
 * its own `<style>` and its own ids into the page, and a PCB drawing is large enough that
 * parsing it in JavaScript is visible. An image tag gets loading, decoding and
 * cancellation from the browser for nothing.
 */

import { useEffect, useState } from "react"
import { Canvas } from "./Canvas"
import { useEditor } from "./store"
import { api, type ViewName } from "./api"

const TABS: Array<{ id: ViewName; label: string; blurb: string }> = [
  { id: "schematic", label: "Schematic", blurb: "The circuit diagram. This is the editable one." },
  { id: "pcb", label: "Board", blurb: "The physical board: copper, pads and traces." },
  { id: "assembly", label: "Assembly", blurb: "Where each part sits, for building the board." },
  { id: "pinout", label: "Pinout", blurb: "Every pad with the net it belongs to." },
]

export const Views = () => {
  const view = useEditor((s) => s.view)
  const setView = useEditor((s) => s.setView)

  return (
    <div className="views">
      <div className="views__tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            className={view === tab.id ? "views__tab views__tab--active" : "views__tab"}
            data-testid={`view-${tab.id}`}
            title={tab.blurb}
            onClick={() => setView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="views__body">
        {/* The canvas stays mounted across tab changes. Unmounting it would throw away the
            viewport, so switching to the board and back would lose the user's place. */}
        <div className="views__pane" hidden={view !== "schematic"}>
          <Canvas />
        </div>

        {view !== "schematic" && <Rendered view={view} />}
      </div>
    </div>
  )
}

/**
 * One rendered view.
 *
 * Re-fetched on every design version, which is what keeps the board honest after an edit.
 * A failed render is reported as a message rather than a broken image: the commonest cause
 * is a design that has never been routed, and that has a remedy the user can act on.
 */
const Rendered = ({ view }: { view: Exclude<ViewName, "schematic"> }) => {
  const design = useEditor((s) => s.design)
  const routeBoard = useEditor((s) => s.routeBoard)
  const busy = useEditor((s) => s.busy)

  const [failed, setFailed] = useState(false)
  const src = design ? api.renderUrl(design.id, view, design.version) : undefined

  // A new version is a new render; the previous failure says nothing about it.
  useEffect(() => setFailed(false), [src])

  if (!design) return <p className="views__placeholder">No design open.</p>

  return (
    <div className="views__pane views__pane--render">
      {failed ? (
        <div className="views__failed" data-testid="view-failed">
          <p>
            Nothing to draw yet. This view needs a routed board — the schematic says what connects
            to what, and routing works out where the copper goes.
          </p>
          <button
            type="button"
            className="views__route"
            data-testid="route-board"
            disabled={busy}
            onClick={() => void routeBoard()}
          >
            {busy ? "Routing…" : "Route the board"}
          </button>
        </div>
      ) : (
        <img
          className="views__image"
          data-testid={`render-${view}`}
          src={src}
          alt={`${view} view of ${design.name}`}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  )
}
