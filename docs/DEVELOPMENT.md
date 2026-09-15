# Running SYNTRIX in development

No Docker required. Two Node processes and a MongoDB you already have.

## First time

```bash
pnpm install
make env            # or: copy .env.example .env
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

That starts both servers:

| Service | URL                     | What it is                     |
| ------- | ----------------------- | ------------------------------ |
| web     | <http://localhost:3016> | the editor — **open this one** |
| api     | <http://localhost:3017> | REST + SSE, reloads on save    |

Vite proxies `/api` to the API, so the browser only ever talks to port 3016. In
production Caddy does the same routing, which is why the app's fetch paths are identical
in both.

Run one on its own when you want quieter output:

```bash
pnpm dev:api
pnpm dev:web
```

Check it is alive:

```bash
curl http://localhost:3017/health
```

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
the Vite dev server attaches the header when it proxies, and in production the reverse
proxy does the same. Shipping a key to the browser would put it in devtools and in the
bundle, which is the one thing principle 7 is about.

So calling the API by hand needs the header, while the app does not:

```bash
curl -H "x-api-key: dev-key-change-me" http://localhost:3017/api/designs
curl http://localhost:3016/api/designs      # through Vite — no header needed
```

Unset `SYNTRIX_API_KEY` to turn auth off entirely while you are poking at it.

## If `pnpm dev` crashes with exit code 3221226505

That code is `0xC0000409`, a Windows process crash, and it comes from Turborepo's
interactive terminal UI rather than from anything in this project — it only happens in a
real terminal, which is why piping the output makes it disappear.

Already fixed: `turbo.json` sets `"ui": "stream"`, and the `dev` script passes
`--ui=stream` as well. If you still hit it, skip Turbo entirely:

```bash
pnpm dev:raw       # pnpm --parallel, no turbo
```

## Other useful commands

```bash
pnpm test          # 448 unit tests
pnpm typecheck
pnpm lint
pnpm e2e           # Playwright; starts its own servers on 4173/4175
pnpm build
```

## Docker, when you do want it

Three required services — `proxy`, `web`, `api` — with everything else opt-in:

```bash
make dev                       # web on http://localhost:3015
make dev PROFILES=mongo        # add a containerised MongoDB
make dev PROFILES="kicad search"
```

With the containers, the API reaches a host MongoDB through
`host.docker.internal`, which is already the default `MONGO_URL` in compose.

## Production

Set these in the server's environment — never in a committed file:

```ini
NODE_ENV=production
MONGO_URL=mongodb+srv://…@syntrix.…mongodb.net/syntrix
MONGO_DNS_SERVERS=8.8.8.8,8.8.4.4
SYNTRIX_API_KEY=<a real secret>
MCP_BEARER_TOKEN=<a real secret>
```

See `docs/DEPLOY_VPS.md` for the Caddy and TLS setup.
