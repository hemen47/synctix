# Running SYNTRIX in development

No Docker, ever. One command, one port, and a MongoDB you already have.

## First time

```bash
pnpm install
cp .env.example .env
```

Then check `.env`. The only lines that matter to start:

```ini
MONGO_URL=mongodb://127.0.0.1:27017/vikronix_syntrix
SYNTRIX_API_KEY=dev-key-change-me
MCP_BEARER_TOKEN=dev-mcp-token-change-me
```

## Every time

```bash
pnpm dev
```

Open **<http://localhost:3015>**. That is the whole app.

Behind it, `pnpm dev` runs two processes:

| Process | Port | What it is                                               |
| ------- | ---- | -------------------------------------------------------- |
| web     | 3015 | Vite: serves the editor, proxies `/api` and `/mcp` below |
| api     | 3016 | REST + SSE + MCP, reloads on save                        |

You never open 3016. It exists so that restarting the API — which `tsx watch` does on
every backend edit — does not tear down the frontend's HMR. In production there is no
watcher and no second process: one Node process serves the app, `/api` and `/mcp` on 3015
(ADR-0029). The app's fetch paths are identical in both.

Ctrl+C stops both and takes their children with them. If a port ever does stay held, it is
a bug in `scripts/dev.mjs` rather than something you should have to clean up by hand.

Run one on its own when you want quieter output:

```bash
pnpm dev:api
pnpm dev:web
```

Check it is alive:

```bash
curl http://localhost:3015/health
```

`status` is `ok` when MongoDB answers, `degraded` when something optional is down, and
`down` — with a 503 — only when a dependency the app genuinely needs is unreachable
(ADR-0027). With `MONGO_URL` unset the database reports `disabled`, which is a deliberate
choice rather than a fault, so the stack still reads `ok`.

## MongoDB

The database is **not** in a container. On a dev machine you usually already have one
installed, and in production it is usually Atlas; running a container by default would
mean a second, empty database competing for port 27017 with the one you are using.

**A database name is a single name, not a path.** MongoDB forbids `/ \ . " $ * < > : | ?`
in a namespace, so a URL like `…/vikronix/syntrix` **connects successfully** and then
fails on every single query with `Invalid namespace specified`. The API checks for this at
startup and refuses to run rather than letting you discover it on the first save. Use
`vikronix_syntrix`.

**Running without a database.** Unset `MONGO_URL` and designs live in memory for the life
of the process. That is a supported way to run — it is what the Playwright suite drives —
just not one that keeps your work.

**Atlas, and the DNS problem.** A `mongodb+srv://` URL makes the driver look up SRV
records before it can connect to anything. If this machine's resolver is a local stub that
is not answering — a VPN client, split-horizon DNS, Docker Desktop's resolver — the lookup
fails with `ECONNREFUSED` and the error names DNS, not Mongo, which sends you looking in
the wrong place. Verified on this machine: the system resolver is `127.0.0.1` and refuses
the query; through `8.8.8.8` the same lookup returns three hosts.

```ini
MONGO_URL=mongodb+srv://user:password@cluster.mongodb.net/syntrix
MONGO_DNS_SERVERS=8.8.8.8,8.8.4.4
```

That overrides the resolver **for the API process only**; it changes nothing on the
machine. The API prints the hint automatically if an SRV connection fails this way.

## The API key

`SYNTRIX_API_KEY` in `.env` guards everything under `/api`. The browser never sends it:
the Vite dev server attaches the header when it proxies. In production the browser and the
API are the same origin, so nothing crosses a boundary that would need one. Shipping a key
to the browser would put it in devtools and in the bundle, which is the one thing
principle 8 is about.

So calling the API by hand needs the header, while the app does not:

```bash
curl -H "x-api-key: dev-key-change-me" http://localhost:3016/api/designs
curl http://localhost:3015/api/designs      # through Vite — no header needed
```

Unset `SYNTRIX_API_KEY` to turn auth off entirely while you are poking at it.

## Exit code 3221226505 on Windows — fixed, and worth knowing about

`0xC0000409` is the Windows fail-fast code, and it used to kill every script in this
repo: `dev`, `build`, `test`, `typecheck` and `lint`.

It was Turborepo, and it only happened with a **real console attached** — redirect the
output to a file or a pipe and it went away, which is why CI and every scripted check
stayed green while the repo was unusable by hand. An earlier attempt blamed turbo's
interactive TUI and set `--ui=stream`; that did not help, because the crash is in pnpm
spawning turbo's Node shim, not in the renderer.

Turbo is gone (ADR-0028). `pnpm -r` runs workspace scripts in topological order, which is
all turbo was doing here. If you see `0xC0000409` again, the first question is which new
tool wrapped a native binary in a Node shim.

## Other useful commands

```bash
pnpm test          # 478 unit tests, once through
pnpm typecheck
pnpm lint
pnpm e2e           # Playwright; starts its own servers on 4173/4175
pnpm build
```

## Running what you would deploy

```bash
pnpm build     # packages, the web bundle, then the server bundle
pnpm start     # http://localhost:3015 — app + api + mcp, one process
```

`pnpm build` ends at `scripts/build-server.mjs`, which bundles the API and everything it
imports into a single `apps/api/dist/server.js` (ADR-0030). That file runs against Node
alone — no `node_modules` beside it, no build tools, no `NODE_ENV` to remember. It serves
the web app because it _is_ the built server, decided at bundle time rather than by an
environment variable that a stray `.env` can get wrong.

## Production

There is no Docker and no Caddy in this repo. Deploying is: build, copy
`apps/api/dist/server.js`, `apps/web/dist/` and your `.env`, then run it under whatever
supervisor and TLS terminator the host already has. Point that terminator at port 3015.

Set these in the server's environment — never in a committed file:

```ini
NODE_ENV=production
PUBLIC_ORIGIN=https://your.domain
MONGO_URL=mongodb+srv://…@syntrix.…mongodb.net/syntrix
MONGO_DNS_SERVERS=8.8.8.8,8.8.4.4
SYNTRIX_API_KEY=<a real secret>
MCP_BEARER_TOKEN=<a real secret>
```

`/live` is the liveness check — it touches nothing external, so a flaky database cannot
get a healthy process restarted. `/health` is the readiness one, and returns 503 only when
a required dependency is unreachable.
