/**
 * Bundle the API into one self-contained file: `apps/api/dist/server.js`.
 *
 * `tsc` alone cannot produce a runnable server here. The house style is extensionless
 * local imports (`from "./types"`), and `tsc` emits specifiers unchanged, so its output
 * is not resolvable ESM — Node needs `./types.js`. Putting `.js` on every local import
 * across the workspace was the alternative; bundling is the smaller change (ADR-0030).
 *
 * **Everything is bundled, including node_modules.** Externalising them looked cheaper
 * and was wrong: an external import keeps its bare specifier, so Node re-resolves it from
 * `apps/api/dist/` at runtime — where pnpm has only this package's *direct* dependencies.
 * Anything reached through `@syntrix/agent` or `@syntrix/core` is then unresolvable, and
 * the failure arrives at boot rather than at build. Bundling resolves every import from
 * its real importer at build time, which is the only place the answer is known.
 *
 * The output is one file plus a sourcemap, and it runs against Node alone.
 */

import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const result = await build({
  entryPoints: [join(repoRoot, "apps", "api", "src", "index.ts")],
  outfile: join(repoRoot, "apps", "api", "dist", "server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
  // Read by the bootstrap to know it is the built artifact, and therefore that it serves
  // the web app on the public port. NODE_ENV cannot answer that: a .env says
  // `development` on the machine that builds and on the machine that deploys alike.
  define: { "process.env.SYNTRIX_SERVE_WEB": '"1"' },
  // Some bundled dependencies are CommonJS and call `require`, which an ESM bundle has no
  // binding for. This gives them one.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
})

if (result.warnings.length > 0) {
  console.warn(`[build-server] ${result.warnings.length} warning(s) from esbuild`)
}
