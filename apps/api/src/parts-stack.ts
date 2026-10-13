/**
 * The parts stack: one library, one index, one resolver, for the whole process.
 *
 * This exists because the resolver and the routers have to be the *same* objects and are
 * built at different moments. `index.ts` needs a `resolvePart` before it can construct a
 * store; `app.ts` needs the index to hand to the palette, the agent and MCP. When each
 * built its own, the symptom was precise and baffling: a custom part could be saved,
 * searched and fetched over HTTP, and then `add_component` rejected it with
 * `PART_NOT_FOUND` — because the store had been given `t0Resolver`, which has never heard
 * of the user's library.
 *
 * Building it in one place and passing it down makes that class of mismatch impossible
 * rather than merely fixed.
 */

import {
  CompositePartsIndex,
  LocalPartsIndex,
  T0_PARTS,
  UserPartsIndex,
  createPartResolver,
  defaultUserPartsPath,
  getT0Part,
  type PartsIndex,
} from "@syntrix/parts"
import type { apply } from "@syntrix/core"

export interface PartsStack {
  /** The user's own library, writable and persisted. */
  userParts: UserPartsIndex
  /** What the palette, the agent and MCP all read: custom parts over the built-in ones. */
  parts: PartsIndex
  /**
   * How core turns a `partRef` into a pinout while applying an operation.
   *
   * Synchronous, because `apply` is. Custom parts are consulted first and T0 is the
   * fallback, matching the search order — so a part the user defined shadows nothing and
   * is found everywhere.
   */
  resolvePart: NonNullable<Parameters<typeof apply>[2]>["resolvePart"]
}

export const createPartsStack = (userPartsPath?: string): PartsStack => {
  const userParts = new UserPartsIndex(userPartsPath ?? defaultUserPartsPath())

  return {
    userParts,
    parts: new CompositePartsIndex(userParts, new LocalPartsIndex(T0_PARTS)),
    resolvePart: createPartResolver((ref) => userParts.lookup(ref) ?? getT0Part(ref)),
  }
}
