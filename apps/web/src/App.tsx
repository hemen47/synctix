/**
 * The editor shell: palette | canvas | inspector, with a status bar.
 *
 * Every pane is a thin client of the engine. The palette searches parts through the API,
 * the canvas submits Operations, the inspector reads the design the server last returned.
 * Nothing here computes geometry or decides what a circuit means.
 */

import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type PartHit } from "./api"
import { Chat } from "./Chat"
import { PartForm } from "./PartForm"
import { Views } from "./Views"
import { fitCurrentScene, useEditor } from "./store"

/**
 * Open the design named in the URL, or create one and put it there.
 *
 * A design needs an address. Without one a reload silently starts a new empty document,
 * which loses the user's work and makes "send someone this schematic" impossible. The
 * hash is enough — there is no server-side routing to arrange and it survives a refresh.
 *
 * The promise is held outside React so a re-render, a remount, or StrictMode's double
 * invocation all join the same one instead of racing to create a second empty design.
 */
let opening: Promise<string> | undefined

const ensureDesign = (
  create: (name: string) => Promise<string>,
  open: (id: string) => Promise<void>,
): Promise<string> => {
  opening ??= (async () => {
    const fromUrl = window.location.hash.replace(/^#/, "")
    if (fromUrl) {
      await open(fromUrl)
      // An id that no longer exists (a cleared store, a shared stale link) falls through
      // to a fresh design rather than leaving an empty editor and an error.
      if (useEditor.getState().design) return fromUrl
    }

    const id = await create("Untitled")
    window.location.hash = id
    return id
  })()

  return opening
}

export const App = () => {
  const design = useEditor((s) => s.design)
  const busy = useEditor((s) => s.busy)
  const problem = useEditor((s) => s.problem)
  const dismissProblem = useEditor((s) => s.dismissProblem)
  const createAndOpen = useEditor((s) => s.createAndOpen)
  const open = useEditor((s) => s.open)

  // One design, created on first load. Multi-document comes with the project list; the
  // editor itself does not care how many exist.
  //
  // The guard is module-scoped rather than a `designId` check, because React StrictMode
  // invokes this effect twice in development and both invocations run before the first
  // `await` resolves — so a state check sees "no design yet" twice and creates two. A
  // promise the second caller can join is the only guard that holds across an await.
  useEffect(() => {
    void ensureDesign(createAndOpen, open)
  }, [createAndOpen, open])

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__brand">SYNTRIX</span>
        <span className="app__tagline">agentic EDA — schematic, simulation, PCB</span>
        <span className="app__spacer" />
        <Toolbar />
      </header>

      {problem && (
        <div className="problem" role="alert" data-testid="problem">
          <strong>{problem.message}</strong>
          {/* The engine writes hints for a model to act on; they read well to a person
              too, and are far more use than "operation failed". */}
          {problem.hint && <span className="problem__hint">{problem.hint}</span>}
          <button type="button" onClick={dismissProblem} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="app__body">
        <aside className="pane pane--left">
          <Palette />
        </aside>

        <main className="pane pane--center">
          <Views />
        </main>

        <aside className="pane pane--right">
          <Chat />
          <Inspector />
        </aside>
      </div>

      <footer className="app__status" data-testid="status">
        <span>{design ? `${design.name} · v${design.version}` : "no design"}</span>
        <span>{busy ? "working…" : "ready"}</span>
        <span className="app__hint">W wire · R rotate · Del remove · Ctrl+Z undo · Esc cancel</span>
      </footer>
    </div>
  )
}

/**
 * The export formats, all of them tscircuit's (principle 1).
 *
 * Each label says what the file is *for*, not what it is called. "KiCad project" means
 * nothing to someone who has never opened KiCad; "open it in KiCad" tells them whether
 * they want it.
 */
const EXPORTS: Array<{ id: string; label: string }> = [
  { id: "svg", label: "Schematic image (SVG)" },
  { id: "pcb-svg", label: "Board image (SVG)" },
  { id: "kicad", label: "KiCad project — to keep editing elsewhere" },
  { id: "gerber", label: "Gerber + drill — to have the board made" },
  { id: "bom-csv", label: "Bill of materials — the parts to buy" },
  { id: "pnp-csv", label: "Pick and place — for assembly" },
  { id: "spice", label: "SPICE netlist — to simulate" },
  { id: "ltspice-asc", label: "LTspice schematic" },
  { id: "dsn", label: "Specctra DSN — for another autorouter" },
]

const Toolbar = () => {
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const relayout = useEditor((s) => s.relayout)
  const runErc = useEditor((s) => s.runErc)
  const routeBoard = useEditor((s) => s.routeBoard)
  const download = useEditor((s) => s.download)
  const busy = useEditor((s) => s.busy)

  return (
    <div className="toolbar">
      <button type="button" data-testid="undo" onClick={() => void undo()} title="Ctrl+Z">
        Undo
      </button>
      <button type="button" data-testid="redo" onClick={() => void redo()} title="Ctrl+Shift+Z">
        Redo
      </button>
      <span className="toolbar__divider" />
      <button
        type="button"
        data-testid="relayout"
        onClick={() => void relayout()}
        title="Tidy the drawing automatically. Parts you dragged stay where you put them."
      >
        Tidy up
      </button>
      <button type="button" data-testid="fit" onClick={fitCurrentScene} title="Frame the drawing">
        Fit
      </button>
      <span className="toolbar__divider" />
      <button
        type="button"
        data-testid="run-erc"
        onClick={() => void runErc()}
        title="Check the circuit for electrical mistakes"
      >
        Check
      </button>
      <button
        type="button"
        data-testid="route"
        disabled={busy}
        onClick={() => void routeBoard()}
        title="Work out where the copper goes on the physical board"
      >
        Route board
      </button>

      {/* A select rather than buttons: nine formats is a menu, and the blank first option
          keeps it from looking like a setting that is currently "svg". */}
      <select
        className="toolbar__export"
        data-testid="export"
        value=""
        disabled={busy}
        onChange={(event) => {
          if (event.target.value) void download(event.target.value)
        }}
      >
        <option value="">Download…</option>
        {EXPORTS.map((format) => (
          <option key={format.id} value={format.id}>
            {format.label}
          </option>
        ))}
      </select>
    </div>
  )
}

const Palette = () => {
  const [query, setQuery] = useState("")
  const [adding, setAdding] = useState(false)
  const startPlacing = useEditor((s) => s.startPlacing)
  const mode = useEditor((s) => s.editor.mode)
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ["parts", query],
    queryFn: () => api.searchParts(query),
  })

  // Whether this deployment can store a part at all. A form that silently forgets what
  // you typed at the next restart is worse than no form.
  const { data: capabilities } = useQuery({
    queryKey: ["parts-capabilities"],
    queryFn: () => api.partsCapabilities(),
    staleTime: Infinity,
  })

  const refreshParts = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["parts"] })
  }

  const remove = async (id: string): Promise<void> => {
    await api.deletePart(id)
    refreshParts()
  }

  return (
    <>
      <div className="palette__header">
        <h2 className="pane__title">Palette</h2>
        {capabilities?.canAddParts && !adding && (
          <button
            type="button"
            className="palette__new"
            data-testid="new-part"
            onClick={() => setAdding(true)}
            title="Define a part the catalog does not have"
          >
            + New part
          </button>
        )}
      </div>

      {adding ? (
        <PartForm
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            refreshParts()
          }}
        />
      ) : (
        <>
          <input
            className="palette__search"
            data-testid="part-search"
            placeholder="resistor, 3.3V LDO, NE555…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          {mode.kind === "placing" && (
            <p className="palette__placing" data-testid="placing">
              Click the canvas to place it. Esc to cancel.
            </p>
          )}

          <ul className="palette__list">
            {isLoading && <li className="palette__empty">searching…</li>}
            {data?.results.map((part) => (
              <PartRow
                key={part.id}
                part={part}
                onPick={() => startPlacing(part.id, ftypeOf(part))}
                onRemove={part.id.startsWith("user:") ? () => void remove(part.id) : undefined}
              />
            ))}
            {data && data.results.length === 0 && (
              <li className="palette__empty">nothing matched</li>
            )}
          </ul>
        </>
      )}
    </>
  )
}

const PartRow = ({
  part,
  onPick,
  onRemove,
}: {
  part: PartHit
  onPick: () => void
  /** Present only for a part the user defined; built-in parts are not deletable. */
  onRemove?: () => void
}) => (
  <li className="palette__row">
    <button
      type="button"
      className="palette__item"
      data-testid="part"
      data-part={part.id}
      onClick={onPick}
    >
      <span className="palette__mpn">
        {part.mpn ?? part.id}
        {onRemove && <em className="palette__mine"> yours</em>}
      </span>
      <span className="palette__desc">{part.description}</span>
      <span className="palette__meta">
        {part.package ?? part.category}
        {/* An unverified footprint is a board that does not fit its parts — the most
            expensive failure in this domain, so it is marked in the palette, not
            discovered at assembly. */}
        {!part.footprintVerified && <em className="palette__unverified"> unverified</em>}
      </span>
    </button>
    {onRemove && (
      <button
        type="button"
        className="palette__delete"
        data-testid="delete-part"
        aria-label={`Delete ${part.mpn ?? part.id}`}
        title="Delete this part"
        onClick={onRemove}
      >
        ×
      </button>
    )}
  </li>
)

/**
 * The ftype for a search hit.
 *
 * The summary does not carry one, and the canvas needs it to pick a refdes prefix before
 * the operation is applied. Derived from the category, which is what the catalog keys on.
 */
const ftypeOf = (part: PartHit): string => {
  const byCategory: Record<string, string> = {
    resistor: "simple_resistor",
    capacitor: "simple_capacitor",
    inductor: "simple_inductor",
    diode: "simple_diode",
    led: "simple_led",
    transistor: "simple_transistor",
    mosfet: "simple_mosfet",
    crystal: "simple_crystal",
    ground: "simple_ground",
    connector: "simple_pin_header",
  }
  return byCategory[part.category.toLowerCase()] ?? "simple_chip"
}

const Inspector = () => {
  const design = useEditor((s) => s.design)
  const selection = useEditor((s) => s.editor.selection)
  const scene = useEditor((s) => s.scene)
  const erc = useEditor((s) => s.erc)

  const selected = scene.symbols.filter((s) => selection.includes(s.sourceComponentId))

  // A single element, not a fragment. The right pane is a flex column, and a fragment
  // spills every heading and list into it as a separate flex child — each one taking its
  // own share of the height and its own separator, which crushed the chat above it.
  return (
    <div className="inspector">
      <h2 className="pane__title">Inspector</h2>

      {selected.length === 0 && <p className="pane__placeholder">Nothing selected.</p>}

      {selected.map((symbol) => (
        <dl key={symbol.id} className="inspector__props" data-testid="inspector-props">
          <dt>Name</dt>
          <dd>{symbol.name}</dd>
          <dt>Type</dt>
          <dd>{symbol.ftype.replace(/^simple_/, "")}</dd>
          <dt>Pins</dt>
          <dd>{symbol.pins.length}</dd>
          <dt>Rotation</dt>
          <dd>{symbol.rotationDeg}°</dd>
        </dl>
      ))}

      <h3 className="pane__subtitle">ERC</h3>
      {!erc && <p className="pane__placeholder">Not run yet.</p>}
      {erc && erc.violations.length === 0 && <p className="erc__clean">No violations.</p>}
      <ul className="erc__list" data-testid="erc-list">
        {erc?.violations.map((violation, index) => (
          <li key={index} className={`erc__item erc__item--${violation.severity}`}>
            <strong>{violation.rule}</strong> {violation.message}
          </li>
        ))}
      </ul>

      <h3 className="pane__subtitle">Design</h3>
      <p className="pane__placeholder" data-testid="element-count">
        {design ? `${design.circuit.length} elements · ${design.logLength} operations` : "—"}
      </p>
    </div>
  )
}
