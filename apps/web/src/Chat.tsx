/**
 * The agent panel.
 *
 * The thing this file is really for is **making the agent's work legible to someone who
 * cannot read a schematic yet**. A chat box that returns "done!" is useless here: the user
 * cannot check the answer, so the only way to earn trust is to show the work — the part it
 * searched for, the pinout it read, the connection the engine rejected and what it did
 * next. That trace is rendered as plain sentences, not as raw JSON, because the audience
 * is someone learning the domain.
 *
 * Failures are shown, never swallowed. A rejected tool call is the most informative event
 * in a run and it stays visible with the engine's hint attached.
 */

import { useEffect, useRef, useState } from "react"
import { useEditor, type ChatTurn } from "./store"
import type { TraceEvent } from "./api"

/** What a beginner can type to see the thing work. */
const EXAMPLES = [
  "Build a 555 timer LED blinker running at about 1 Hz",
  "Add a 3.3V regulator from a 5V input, with input and output capacitors",
  "Make a low-pass RC filter with a 1 kHz corner frequency",
]

export const Chat = () => {
  const chat = useEditor((s) => s.chat)
  const agent = useEditor((s) => s.agent)
  const running = useEditor((s) => s.cancelRun !== undefined)
  const ask = useEditor((s) => s.ask)
  const stopRun = useEditor((s) => s.stopRun)
  const clearChat = useEditor((s) => s.clearChat)
  const loadAgentStatus = useEditor((s) => s.loadAgentStatus)

  const [draft, setDraft] = useState("")
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadAgentStatus()
  }, [loadAgentStatus])

  // Follow the stream. `chat` changes on every trace event, which is exactly when a
  // reader wants the newest line in view.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [chat])

  const send = (text: string): void => {
    const prompt = text.trim()
    if (prompt.length === 0 || running) return
    setDraft("")
    void ask(prompt)
  }

  const unavailable = agent && !agent.available

  return (
    <section className="chat" data-testid="chat">
      <header className="chat__header">
        <h2 className="pane__title">Assistant</h2>
        {chat.length > 0 && !running && (
          <button type="button" className="chat__clear" onClick={clearChat}>
            Clear
          </button>
        )}
      </header>

      {unavailable && (
        <div className="chat__unavailable" data-testid="agent-unavailable">
          <strong>The assistant is not configured.</strong>
          {/* Naming the variable is the entire value of this panel: "unavailable" with no
              remedy is what sends someone to the source code. */}
          <p>
            {agent.roles.find((role) => !role.available)?.detail ??
              agent.detail ??
              "No model provider is available."}
          </p>
          <p className="chat__hint">
            Add a key to <code>.env</code> in the project root, then restart <code>pnpm dev</code>.
            The editor works without it — you can place and wire parts by hand.
          </p>
        </div>
      )}

      <div className="chat__log">
        {chat.length === 0 && !unavailable && (
          <div className="chat__empty">
            <p>
              Describe the circuit you want in plain English. Every change the assistant makes is a
              normal edit — you can undo it.
            </p>
            <ul className="chat__examples">
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    className="chat__example"
                    data-testid="chat-example"
                    onClick={() => send(example)}
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {chat.map((turn) => (
          <Turn key={turn.id} turn={turn} />
        ))}
        <div ref={endRef} />
      </div>

      <form
        className="chat__composer"
        onSubmit={(event) => {
          event.preventDefault()
          send(draft)
        }}
      >
        <textarea
          className="chat__input"
          data-testid="chat-input"
          rows={3}
          placeholder={
            unavailable ? "Set a provider API key to enable the assistant" : "Ask for a circuit…"
          }
          disabled={running || unavailable}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter makes a newline. A multi-line description is
            // common enough that the textarea has to keep working as one.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              send(draft)
            }
          }}
        />

        <div className="chat__actions">
          {running ? (
            <button type="button" className="chat__stop" data-testid="chat-stop" onClick={stopRun}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="chat__send"
              data-testid="chat-send"
              disabled={draft.trim().length === 0 || unavailable}
            >
              Send
            </button>
          )}
        </div>
      </form>
    </section>
  )
}

const Turn = ({ turn }: { turn: ChatTurn }) => {
  if (turn.role === "user") {
    return (
      <div className="turn turn--user" data-testid="turn-user">
        {turn.text}
      </div>
    )
  }

  return (
    <div className="turn turn--assistant" data-testid="turn-assistant">
      {turn.trace.length > 0 && <Trace events={turn.trace} running={turn.running ?? false} />}

      {turn.text && <p className="turn__text">{turn.text}</p>}

      {turn.running && turn.trace.length === 0 && <p className="turn__thinking">Thinking…</p>}

      {turn.error && (
        <div className="turn__error" data-testid="turn-error">
          <strong>{turn.error.message}</strong>
          {turn.error.hint && <span>{turn.error.hint}</span>}
        </div>
      )}

      {turn.summary && (
        <div className="turn__summary" data-testid="turn-summary">
          <span
            className={
              turn.summary.erc.pass ? "turn__erc turn__erc--pass" : "turn__erc turn__erc--fail"
            }
          >
            {turn.summary.erc.pass ? "ERC passed" : `ERC: ${turn.summary.erc.errorCount} error(s)`}
            {turn.summary.erc.warningCount > 0 && `, ${turn.summary.erc.warningCount} warning(s)`}
          </span>
          <span>
            {turn.summary.toolCalls} action{turn.summary.toolCalls === 1 ? "" : "s"} ·{" "}
            {turn.summary.iterations} step{turn.summary.iterations === 1 ? "" : "s"}
          </span>
          {/* "Finished" is the uninteresting case; the other two mean the answer is
              incomplete and the user needs to know before they trust it. */}
          {turn.summary.stopReason !== "finished" && (
            <span className="turn__stop-reason">
              {turn.summary.stopReason === "max_iterations"
                ? "Stopped at the step limit — the design may be unfinished."
                : "Stopped at the cost limit."}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The run, as a list of steps.
 *
 * Collapsed once the run is over, because a finished answer should read as an answer.
 * While it is running it is open, because that is the only thing to look at.
 */
const Trace = ({ events, running }: { events: TraceEvent[]; running: boolean }) => {
  const [open, setOpen] = useState(true)
  const wasRunning = useRef(running)

  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false)
    wasRunning.current = running
  }, [running])

  const steps = events.filter((event) => event.kind !== "message")

  return (
    <details className="trace" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="trace__summary">
        {running ? (
          <>
            <span className="trace__spinner" aria-hidden /> Working — {steps.length} step
            {steps.length === 1 ? "" : "s"}
          </>
        ) : (
          `${steps.length} step${steps.length === 1 ? "" : "s"}`
        )}
      </summary>

      <ol className="trace__list" data-testid="trace-list">
        {steps.map((event, index) => (
          <Step key={index} event={event} />
        ))}
      </ol>
    </details>
  )
}

const Step = ({ event }: { event: TraceEvent }) => {
  switch (event.kind) {
    case "tool_call":
      return (
        <li className="trace__item trace__item--call" data-testid="trace-call">
          <span className="trace__verb">{describeTool(event.tool)}</span>
          <code className="trace__args">{summarizeInput(event.input)}</code>
        </li>
      )

    case "tool_result":
      return (
        <li
          className={`trace__item ${event.ok ? "trace__item--ok" : "trace__item--fail"}`}
          data-testid="trace-result"
        >
          {/* A rejection is shown in full. It is the engine's own message and hint, and
              it explains what the next step in the trace is about to do. */}
          {event.ok ? (
            <span className="trace__tick">✓</span>
          ) : (
            <span className="trace__cross">✕</span>
          )}
          <span className="trace__result">{event.summary}</span>
        </li>
      )

    case "erc":
      return (
        <li className="trace__item trace__item--erc">
          Checked the design: {event.pass ? "no errors" : `${event.errorCount} error(s)`}
          {event.warningCount > 0 && `, ${event.warningCount} warning(s)`}
        </li>
      )

    case "error":
      return (
        <li className="trace__item trace__item--fail">
          <span className="trace__cross">✕</span>
          <span className="trace__result">{event.message}</span>
        </li>
      )

    default:
      return null
  }
}

/**
 * A tool name as something a person would say.
 *
 * `add_component` is jargon twice over — the underscore and the word "component". The
 * audience for this panel is someone who does not yet know what a net is, and the trace is
 * where they find out.
 */
const describeTool = (tool: string): string => {
  const phrases: Record<string, string> = {
    add_component: "Added a part",
    remove_component: "Removed a part",
    set_prop: "Set a value",
    rename: "Renamed",
    connect: "Wired up",
    disconnect: "Disconnected",
    create_net: "Created a net (a named wire)",
    rename_net: "Renamed a net",
    add_net_label: "Labelled a net",
    add_power_symbol: "Added a power symbol",
    place_hint: "Noted where it should sit",
    batch: "Applied several changes at once",
    inspect_design: "Read the current design",
    run_erc: "Checked for electrical errors",
    search_parts: "Searched the parts catalog",
    get_pinout: "Looked up the pinout",
    simulate: "Simulated the circuit",
    generate_tsx_circuit: "Generated the circuit",
    export: "Exported the design",
  }
  return phrases[tool] ?? tool.replace(/_/g, " ")
}

/** The arguments, short enough to sit on one line. */
const summarizeInput = (input: unknown): string => {
  if (input === null || typeof input !== "object") return ""

  const entries = Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => {
      const rendered = typeof value === "object" ? JSON.stringify(value) : String(value)
      // A TSX snippet is thousands of characters and belongs nowhere near a one-line
      // summary; its result is the interesting part anyway.
      return `${key}=${rendered.length > 40 ? `${rendered.slice(0, 40)}…` : rendered}`
    })

  return entries.join("  ")
}
