/**
 * MongoDB connection.
 *
 * Two things here are not boilerplate, and both were found by running against the real
 * databases rather than by reading the driver docs.
 *
 * **1. `mongodb+srv://` needs DNS that works.** Atlas publishes its hosts as SRV records,
 * so the driver does a DNS lookup before it can connect to anything. On a machine whose
 * resolver is a local stub that is not actually answering — a VPN client, a corporate
 * split-DNS setup, Docker Desktop's resolver — that lookup fails with `ECONNREFUSED` and
 * the error names DNS, not Mongo, which sends people looking in the wrong place. Setting
 * `MONGO_DNS_SERVERS=8.8.8.8,8.8.4.4` makes Node resolve through a public server for this
 * process only; it does not touch the machine's settings.
 *
 * **2. A database name cannot contain `/`.** `mongodb://host/vikronix/syntrix` *connects*
 * — the driver happily takes `vikronix/syntrix` as the database — and then every single
 * operation fails with "Invalid namespace specified". The connection succeeding is what
 * makes this worth checking up front rather than discovering on the first query.
 */

import { setServers } from "node:dns"
import { MongoClient, type Collection, type Db } from "mongodb"

export interface MongoOptions {
  url: string
  /** Comma-separated resolvers, from `MONGO_DNS_SERVERS`. */
  dnsServers?: string
  /** Fail fast rather than hanging when the server is unreachable. */
  serverSelectionTimeoutMS?: number
}

export interface MongoConnection {
  client: MongoClient
  db: Db
  collection<T extends Document = Document>(name: string): Collection<T>
  close(): Promise<void>
}

/** MongoDB rejects these in a namespace. `/` is the one people hit, via a URL path. */
const ILLEGAL_DB_CHARS = /[/\\. "$*<>:|?]/

/**
 * Pull the database name out of a connection string and check it is usable.
 *
 * Returns the name, or an explanation of why the URL will not work. Checked before
 * connecting, because "connects fine, every query fails" is a bad way to learn this.
 */
export const databaseNameFrom = (url: string): { name?: string; problem?: string } => {
  const withoutScheme = url.replace(/^mongodb(\+srv)?:\/\//, "")
  const afterHost = withoutScheme.slice(withoutScheme.indexOf("/") + 1)
  const name = withoutScheme.includes("/") ? afterHost.split("?")[0] : ""

  if (!name) {
    return { problem: "the URL names no database — add one, e.g. .../syntrix" }
  }

  if (ILLEGAL_DB_CHARS.test(name)) {
    const suggestion = name.replace(ILLEGAL_DB_CHARS, "_")
    return {
      problem:
        `"${name}" is not a valid database name: MongoDB forbids / \\ . " $ * < > : | ? in a ` +
        `namespace. The URL will connect and then fail on every query. Use "${suggestion}" ` +
        `instead (a database is a single name, not a path).`,
    }
  }

  return { name }
}

/** Apply a DNS override for this process. Needed for `mongodb+srv` on some networks. */
export const applyDnsServers = (servers?: string): string[] | undefined => {
  const list = (servers ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (list.length === 0) return undefined

  setServers(list)
  return list
}

export const connectMongo = async (options: MongoOptions): Promise<MongoConnection> => {
  const { name, problem } = databaseNameFrom(options.url)
  if (problem) throw new Error(`MONGO_URL: ${problem}`)

  if (options.url.startsWith("mongodb+srv://")) applyDnsServers(options.dnsServers)

  const client = new MongoClient(options.url, {
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 8000,
  })

  await client.connect()
  const db = client.db(name)

  return {
    client,
    db,
    collection: (collectionName) => db.collection(collectionName) as never,
    close: () => client.close(),
  }
}

/**
 * A one-shot check, for the health endpoint and for startup.
 *
 * Reports rather than throws: a stack that cannot reach its database should say so and
 * keep serving what it can, not refuse to start.
 */
export const pingMongo = async (
  options: MongoOptions,
): Promise<{ ok: boolean; detail?: string; latencyMs?: number }> => {
  const started = Date.now()
  let connection: MongoConnection | undefined
  try {
    connection = await connectMongo({ ...options, serverSelectionTimeoutMS: 3000 })
    await connection.db.command({ ping: 1 })
    return { ok: true, latencyMs: Date.now() - started }
  } catch (cause) {
    return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    await connection?.close().catch(() => undefined)
  }
}
