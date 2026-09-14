/**
 * Result type. Domain failures are returned, never thrown — an LLM tool call that fails
 * must come back as data the model can read and correct, not as a stack trace.
 *
 * Throw only for programmer error (a broken invariant, an impossible branch).
 */

export type Ok<T> = { readonly ok: true; readonly value: T }
export type Err<E> = { readonly ok: false; readonly error: E }
export type Result<T, E> = Ok<T> | Err<E>

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value })
export const err = <E>(error: E): Err<E> => ({ ok: false, error })

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok

/** Map the success value, passing failures through untouched. */
export const mapResult = <T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> =>
  r.ok ? ok(fn(r.value)) : r

/** Chain a fallible step. The canonical way to sequence operations. */
export const andThen = <T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> => (r.ok ? fn(r.value) : r)

/** Map the error value, passing successes through untouched. */
export const mapErr = <T, E, F>(r: Result<T, E>, fn: (error: E) => F): Result<T, F> =>
  r.ok ? r : err(fn(r.error))

/** Unwrap or fall back. Never throws. */
export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T => (r.ok ? r.value : fallback)

/**
 * Unwrap or throw. For tests and for call sites that have already checked `ok`.
 * Not for domain control flow.
 */
export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value
  throw new Error(`unwrap() on an Err: ${JSON.stringify(r.error)}`)
}

/**
 * Collect an array of Results into a Result of an array, accumulating **all** errors
 * rather than stopping at the first. Operations report every problem at once so the
 * agent can fix them in one turn instead of discovering them one call at a time.
 */
export const collect = <T, E>(results: readonly Result<T, E[]>[]): Result<T[], E[]> => {
  const values: T[] = []
  const errors: E[] = []
  for (const r of results) {
    if (r.ok) values.push(r.value)
    else errors.push(...r.error)
  }
  return errors.length > 0 ? err(errors) : ok(values)
}
