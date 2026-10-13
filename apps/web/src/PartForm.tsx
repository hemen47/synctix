/**
 * Define a part of your own.
 *
 * The form a person fills in when the catalog does not have the thing in front of them —
 * a module off a marketplace, a connector from a drawer, a chip nobody has indexed.
 *
 * **It refuses rather than warns.** A part whose footprint has fewer pads than it has
 * pins is a board that comes back from the fab and cannot be assembled, which is the most
 * expensive mistake this tool can help someone make. The server validates against the
 * real footprinter and returns the engine's own errors, and they are shown here verbatim
 * — "the footprint has 2 pads but the part has 4 pins" is actionable in a way that
 * "invalid part" is not.
 *
 * The pin table is the part that must not be fiddly, because it is the part with real
 * content in it. Rows are added and removed inline, numbering is automatic unless the
 * user overrides it, and nothing is lost by tabbing through.
 */

import { useState } from "react"
import { ApiError, PIN_KINDS, api, type PinKind, type UserPartInput } from "./api"

interface PinRow {
  number: string
  name: string
  kind: PinKind
}

const emptyPin = (): PinRow => ({ number: "", name: "", kind: "passive" })

/** Common packages, so the footprint field is a choice rather than a guess. */
const FOOTPRINT_EXAMPLES = [
  "0402",
  "0603",
  "0805",
  "1206",
  "sot23",
  "sot223",
  "soic8",
  "soic14",
  "tssop20",
  "qfn32",
  "dip8",
  "pinrow4",
]

export const PartForm = ({ onSaved, onCancel }: { onSaved(): void; onCancel(): void }) => {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState("")
  const [footprint, setFootprint] = useState("")
  const [datasheetUrl, setDatasheetUrl] = useState("")
  const [pins, setPins] = useState<PinRow[]>([emptyPin(), emptyPin()])

  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Array<{ message: string; hint?: string }>>([])

  const setPin = (index: number, change: Partial<PinRow>): void => {
    setPins((current) => current.map((pin, i) => (i === index ? { ...pin, ...change } : pin)))
  }

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setErrors([])

    // Blank rows are how someone leaves the table tidy, not pins they meant to define.
    const named = pins.filter((pin) => pin.name.trim().length > 0)

    const part: UserPartInput = {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(category.trim() ? { category: category.trim() } : {}),
      ...(footprint.trim() ? { footprinterString: footprint.trim() } : {}),
      ...(datasheetUrl.trim() ? { datasheetUrl: datasheetUrl.trim() } : {}),
      pins: named.map((pin, index) => ({
        number: pin.number.trim() === "" ? index + 1 : pin.number.trim(),
        name: pin.name.trim(),
        kind: pin.kind,
      })),
    }

    try {
      await api.createPart(part)
      onSaved()
    } catch (error) {
      // The server sends every problem at once; showing one at a time would make this
      // form a guessing game.
      setErrors(
        error instanceof ApiError
          ? [{ message: error.message, ...(error.hint ? { hint: error.hint } : {}) }]
          : [{ message: error instanceof Error ? error.message : "The part could not be saved." }],
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="part-form" data-testid="part-form" onSubmit={(e) => void submit(e)}>
      <div className="part-form__header">
        <h3 className="pane__subtitle">New part</h3>
        <button type="button" className="part-form__cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <label className="part-form__field">
        <span>Name</span>
        <input
          data-testid="part-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="BME280 module"
          required
        />
      </label>

      <label className="part-form__field">
        <span>What it is</span>
        <input
          data-testid="part-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Temperature, humidity and pressure sensor"
        />
      </label>

      <div className="part-form__row">
        <label className="part-form__field">
          <span>Category</span>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="sensor"
          />
        </label>

        <label className="part-form__field">
          <span>Package</span>
          <input
            data-testid="part-footprint"
            value={footprint}
            onChange={(e) => setFootprint(e.target.value)}
            placeholder="soic8"
            list="footprint-examples"
          />
          <datalist id="footprint-examples">
            {FOOTPRINT_EXAMPLES.map((example) => (
              <option key={example} value={example} />
            ))}
          </datalist>
        </label>
      </div>

      {/* Said plainly, because "footprinter string" means nothing to someone who has not
          used tscircuit, and leaving it blank is a legitimate choice. */}
      <p className="part-form__note">
        The package decides the copper pads on the board. Leave it blank if you only want the part
        on the schematic for now.
      </p>

      {/* Where the pinout below came from. Worth recording: a part is only as trustworthy
          as its source, and in six months this is the link you will want. */}
      <label className="part-form__field">
        <span>Datasheet</span>
        <input
          data-testid="part-datasheet"
          type="url"
          value={datasheetUrl}
          onChange={(e) => setDatasheetUrl(e.target.value)}
          placeholder="https://…"
        />
      </label>

      <div className="part-form__pins">
        <div className="part-form__pins-head">
          <span>Pins</span>
          <button
            type="button"
            className="part-form__add"
            data-testid="add-pin"
            onClick={() => setPins((current) => [...current, emptyPin()])}
          >
            + Add pin
          </button>
        </div>

        <ol className="part-form__pin-list">
          {pins.map((pin, index) => (
            <li key={index} className="part-form__pin">
              <input
                className="part-form__pin-number"
                aria-label={`Pin ${index + 1} number`}
                value={pin.number}
                onChange={(e) => setPin(index, { number: e.target.value })}
                placeholder={String(index + 1)}
              />
              <input
                className="part-form__pin-name"
                data-testid="pin-name"
                aria-label={`Pin ${index + 1} name`}
                value={pin.name}
                onChange={(e) => setPin(index, { name: e.target.value })}
                placeholder="VCC"
              />
              <select
                className="part-form__pin-kind"
                aria-label={`Pin ${index + 1} role`}
                value={pin.kind}
                onChange={(e) => setPin(index, { kind: e.target.value as PinKind })}
              >
                {PIN_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="part-form__remove"
                aria-label={`Remove pin ${index + 1}`}
                onClick={() => setPins((current) => current.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </li>
          ))}
        </ol>

        {/* The roles are what ERC checks against, so they are worth one sentence. */}
        <p className="part-form__note">
          The role tells the checker what each pin does — a power input with nothing driving it is
          an error it can catch for you.
        </p>
      </div>

      {errors.length > 0 && (
        <div className="part-form__errors" data-testid="part-form-errors" role="alert">
          {errors.map((error, index) => (
            <div key={index}>
              <strong>{error.message}</strong>
              {error.hint && <span>{error.hint}</span>}
            </div>
          ))}
        </div>
      )}

      <button
        type="submit"
        className="part-form__save"
        data-testid="save-part"
        disabled={saving || name.trim().length === 0}
      >
        {saving ? "Checking…" : "Save part"}
      </button>
    </form>
  )
}
