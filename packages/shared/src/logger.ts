/**
 * Logging.
 *
 * A tiny interface rather than a direct pino dependency, because `@syntrix/core` runs in
 * the browser as well as on the server. The API and worker install a pino-backed logger
 * at startup; everything else gets the console logger or a silent one in tests.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
  /** A logger that tags every line with a scope, e.g. `child("layout")`. */
  child(scope: string): Logger
}

const LEVEL_ORDER: Record<Exclude<LogLevel, "silent">, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export const createConsoleLogger = (level: LogLevel = "info", scope?: string): Logger => {
  const threshold = level === "silent" ? Infinity : LEVEL_ORDER[level]

  const emit = (
    method: Exclude<LogLevel, "silent">,
    message: string,
    context?: Record<string, unknown>,
  ): void => {
    if (LEVEL_ORDER[method] < threshold) return
    const prefix = scope ? `[${scope}]` : ""
    const line = `${prefix} ${message}`.trim()
    // Only warn and error go to their console counterparts; debug and info would be
    // filtered out of most production log collectors as stderr noise.
    if (method === "error") console.error(line, context ?? "")
    else if (method === "warn") console.warn(line, context ?? "")
    else console.log(line, context ?? "")
  }

  return {
    debug: (m, c) => emit("debug", m, c),
    info: (m, c) => emit("info", m, c),
    warn: (m, c) => emit("warn", m, c),
    error: (m, c) => emit("error", m, c),
    child: (childScope) =>
      createConsoleLogger(level, scope ? `${scope}:${childScope}` : childScope),
  }
}

/** Discards everything. The default in tests, so a passing suite is quiet. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
}

/**
 * The configured level, read without assuming Node.
 *
 * `@syntrix/shared` is imported by the browser bundle as well as the server, and reaching
 * for `globalThis.process` directly makes the whole package require Node's types — which
 * then fails to compile in a DOM-only project.
 */
const envLogLevel = (): LogLevel | undefined => {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } }
  const level = runtime.process?.env?.["LOG_LEVEL"]
  return level ? (level as LogLevel) : undefined
}

let activeLogger: Logger = createConsoleLogger(envLogLevel() ?? "info")

export const setLogger = (logger: Logger): void => {
  activeLogger = logger
}

export const getLogger = (scope?: string): Logger =>
  scope ? activeLogger.child(scope) : activeLogger
