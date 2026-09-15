/**
 * `@syntrix/core/tsx` — TSX compilation, for server-side callers only.
 *
 * Kept out of the main entry point so the browser bundle never resolves
 * `@tscircuit/eval`. See `./tsx` for why.
 */

export * from "./tsx"
export * from "./pcb"
