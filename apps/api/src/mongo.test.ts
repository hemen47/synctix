/**
 * Connection-string handling.
 *
 * Both of these were found against real databases, and both fail in a way that points
 * away from the cause — which is exactly why they are worth unit tests rather than a
 * comment.
 */

import { describe, expect, it } from "vitest"
import { databaseNameFrom } from "./mongo"

describe("databaseNameFrom", () => {
  it("reads the database out of a plain URL", () => {
    expect(databaseNameFrom("mongodb://127.0.0.1:27017/vikronix_syntrix")).toEqual({
      name: "vikronix_syntrix",
    })
  })

  it("reads it out of an SRV URL with options", () => {
    expect(
      databaseNameFrom("mongodb+srv://u:p@cluster.example.mongodb.net/syntrix?retryWrites=true"),
    ).toEqual({ name: "syntrix" })
  })

  it("rejects a database name that is really a path", () => {
    // The failure this prevents: MongoDB forbids `/` in a namespace, but the driver
    // accepts the URL and connects. Every query then fails with "Invalid namespace
    // specified: vikronix/syntrix.designs" — long after the point where it looked fine.
    const result = databaseNameFrom("mongodb://127.0.0.1:27017/vikronix/syntrix")

    expect(result.name).toBeUndefined()
    expect(result.problem).toMatch(/not a valid database name/)
    // And it says what to use instead, because the fix is not obvious from the error.
    expect(result.problem).toContain("vikronix_syntrix")
  })

  it("rejects the other characters a namespace cannot contain", () => {
    for (const bad of ["a.b", 'a"b', "a$b", "a b c|d"]) {
      expect(databaseNameFrom(`mongodb://host/${bad}`).problem).toBeDefined()
    }
  })

  it("says so when the URL names no database at all", () => {
    // Without this the driver silently uses "test", and a deployment quietly writes to
    // the wrong place.
    expect(databaseNameFrom("mongodb://127.0.0.1:27017").problem).toMatch(/names no database/)
    expect(databaseNameFrom("mongodb://127.0.0.1:27017/").problem).toMatch(/names no database/)
  })
})
