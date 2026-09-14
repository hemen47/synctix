/**
 * A parser for LTspice `.asc`.
 *
 * Written so the exporter can be tested against something other than itself. Asserting
 * that a generated file contains the string "SYMATTR InstName R1" proves only that a
 * template ran; parsing it back into components, values and nets proves the file says
 * what it was meant to say — and, unlike a golden file, it fails for a reason you can
 * read rather than because a coordinate moved by one grid unit.
 *
 * It is not a complete `.asc` implementation and does not try to be. It reads the subset
 * the exporter writes, and treats anything else as a line it does not need.
 */

export interface AscSymbol {
  symbol: string
  x: number
  y: number
  /** Rotation/mirror, e.g. "R0", "R90", "M0". */
  orientation: string
  instName?: string
  value?: string
}

export interface AscFlag {
  x: number
  y: number
  net: string
}

export interface AscWire {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface AscFile {
  version: number
  sheet: { index: number; width: number; height: number }
  symbols: AscSymbol[]
  flags: AscFlag[]
  wires: AscWire[]
  directives: string[]
  comments: string[]
}

export class AscParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`)
    this.name = "AscParseError"
  }
}

export const parseAsc = (source: string): AscFile => {
  const file: AscFile = {
    version: 0,
    sheet: { index: 1, width: 0, height: 0 },
    symbols: [],
    flags: [],
    wires: [],
    directives: [],
    comments: [],
  }

  let current: AscSymbol | undefined

  source.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (line.length === 0) return
    const lineNo = index + 1

    if (line.startsWith("*")) {
      file.comments.push(line.slice(1).trim())
      return
    }

    const [keyword, ...rest] = line.split(/\s+/)

    switch (keyword) {
      case "Version":
        file.version = int(rest[0], lineNo, "Version")
        return

      case "SHEET":
        file.sheet = {
          index: int(rest[0], lineNo, "sheet index"),
          width: int(rest[1], lineNo, "sheet width"),
          height: int(rest[2], lineNo, "sheet height"),
        }
        return

      case "SYMBOL": {
        // A SYMBOL line opens a block: the SYMATTRs that follow belong to it, until the
        // next SYMBOL. That statefulness is the only thing about this format that is not
        // line-independent, and it is why a naive grep-based check would pass on a file
        // whose attributes had drifted onto the wrong symbol.
        current = {
          symbol: required(rest[0], lineNo, "symbol name"),
          x: int(rest[1], lineNo, "symbol x"),
          y: int(rest[2], lineNo, "symbol y"),
          orientation: rest[3] ?? "R0",
        }
        file.symbols.push(current)
        return
      }

      case "SYMATTR": {
        if (!current) throw new AscParseError("SYMATTR before any SYMBOL", lineNo)
        const attr = required(rest[0], lineNo, "attribute name")
        const value = rest.slice(1).join(" ")
        if (attr === "InstName") current.instName = value
        else if (attr === "Value") current.value = value
        return
      }

      case "FLAG":
        file.flags.push({
          x: int(rest[0], lineNo, "flag x"),
          y: int(rest[1], lineNo, "flag y"),
          net: required(rest[2], lineNo, "flag net"),
        })
        return

      case "WIRE":
        file.wires.push({
          x1: int(rest[0], lineNo, "wire x1"),
          y1: int(rest[1], lineNo, "wire y1"),
          x2: int(rest[2], lineNo, "wire x2"),
          y2: int(rest[3], lineNo, "wire y2"),
        })
        return

      case "TEXT": {
        // A TEXT line whose body starts with "!" is a SPICE directive; without it, an
        // annotation. LTspice makes the same distinction.
        const bang = line.indexOf("!")
        if (bang >= 0) file.directives.push(line.slice(bang + 1).trim())
        return
      }

      default:
        // WINDOW, LINE, RECTANGLE and friends: real .asc lines we do not need.
        return
    }
  })

  return file
}

/** Components by instance name, which is how a test wants to ask about them. */
export const componentsByName = (file: AscFile): Map<string, AscSymbol> => {
  const byName = new Map<string, AscSymbol>()
  for (const symbol of file.symbols) {
    if (symbol.instName) byName.set(symbol.instName, symbol)
  }
  return byName
}

/** Net name → the points flagged with it. Two points sharing a flag are connected. */
export const netsFromFlags = (file: AscFile): Map<string, AscFlag[]> => {
  const nets = new Map<string, AscFlag[]>()
  for (const flag of file.flags) {
    const list = nets.get(flag.net) ?? []
    list.push(flag)
    nets.set(flag.net, list)
  }
  return nets
}

const required = (value: string | undefined, line: number, what: string): string => {
  if (value === undefined) throw new AscParseError(`missing ${what}`, line)
  return value
}

const int = (value: string | undefined, line: number, what: string): number => {
  const parsed = Number(required(value, line, what))
  if (!Number.isInteger(parsed)) {
    throw new AscParseError(`${what} must be an integer, got "${value}"`, line)
  }
  return parsed
}
