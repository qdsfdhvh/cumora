# Local build — operations guide

How to build, run, and service the single-machine (personal) build. For the
"what changed vs. Cumora Cloud" summary see the top of [`../README.md`](../README.md).

## What runs where

```text
Cumora.app (Electron main)                       — window, tray, notifications
└── utilityProcess: server.cjs                   — Express + ws API (127.0.0.1:5181)
    ├── @electric-sql/pglite                     — embedded Postgres (WASM), single backend
    │   └── <userData>/local/pgdata              — the entire database, on disk
    ├── local-redis.ts                           — in-process Redis-compatible store
    └── storage (local disk)                     — <userData>/local/uploads
BYOA daemon (LaunchAgent, launchd)               — `cumora agent computer`
    └── pi / claude / codex / … engines          — runs the agent turns on this machine
```

Nothing above talks to `cumora.ai`. The only outbound calls are the ones you
configure: OpenAI (or another model provider) for the agent loop, and the
optional BYO integrations (Resend, R2, Tavily).

## Build and install

```bash
npm install
npm run electron:build:mac
open release/mac-arm64/Cumora.app          # or copy it to /Applications
```

`electron:build:mac` = `build:server` (esbuild bundle → `build/local-dist/`,
PGlite staged beside it) + `build` (Vite renderer) + `electron-builder --mac
dir --arm64` + an ad-hoc `codesign`.

The explicit signing step matters: `mac.identity` is `null` (no Developer ID
here), so electron-builder skips signing, and macOS terminates an unsigned
arm64 bundle on launch — the app dies within ~200 ms with no crash report and
no JavaScript executed. The build script signs the outer bundle with
`build/entitlements.mac.plist`, which seals `dist/` + `local-dist/` and grants
Electron its JIT/unsigned-memory entitlements.

## First run

1. The app creates `<userData>/local/`, opens the embedded database, and runs
   the schema migrations (a few hundred ms on first boot).
2. If `server.env` has no `OPENAI_API_KEY`, the sign-in screen shows the key
   form. "Skip for now" leaves chat/boards/docs/calendar working and pauses
   only the LLM-backed agent features.
3. **Enter Cumora** calls `POST /api/auth/local`, which find-or-creates the
   machine's single user, its workspace, and `#all-hands`.

Later launches do not ask for anything: once the local account exists the app
signs it in automatically (the screen only appears after an explicit sign-out,
which is remembered in `cumora.auth.signedOut`). Name, email, and avatar are
edited in **Me → 个人资料 → 身份**; the workspace name and logo in
**Me → 个人资料 → 工作区** — the logo then stands in for the built-in mark in
the title bar, the workspace switcher, and the sign-in screen.

Secrets live in `<userData>/local/server.env` (mode `0600`), written by the
app's **Me → Local server** pane or by hand:

```ini
OPENAI_API_KEY=sk-…
AGENT_RUNTIME_SECRET=<64 hex chars, generated on first boot>
```

## Agents (BYOA only)

Agent turns always run on a computer you pair; the server itself never calls a
model on behalf of an agent. Pairing is the point where the starter team is
seeded and unassigned agents are adopted.

```bash
# In the app: Me → Computers → Add a computer → copy the command, then run it.
npx cumora@latest agent computer --pair <code> --server http://127.0.0.1:5181 --engine pi --install-service
```

`--install-service` writes `~/Library/LaunchAgents/io.cumora.daemon.plist`
(`RunAtLoad` + `KeepAlive`) so the daemon comes back after a reboot and
reconnects whenever the app's server is up.

### Two gotchas worth knowing

- **Unsandboxed engines need an explicit opt-in.** `pi`, `grok`, `cursor`,
  `opencode`, `gemini`, `qwen`, and `antigravity` are refused unless
  `CUMORA_BYOA_ALLOW_UNSANDBOXED=1` is in the daemon's environment. The
  installer does not add it, so put it in the plist:

  ```bash
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:CUMORA_BYOA_ALLOW_UNSANDBOXED string 1" \
    ~/Library/LaunchAgents/io.cumora.daemon.plist
  ```

- **`launchctl kickstart` does not re-read the plist.** After editing it you
  must reload the job, otherwise the daemon keeps the old environment (and
  keeps reporting only the sandboxed engines):

  ```bash
  launchctl bootout   gui/$(id -u)/io.cumora.daemon
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.cumora.daemon.plist
  ```

Check what the daemon can actually reach before blaming the app:

```bash
npx cumora@latest agent computer --doctor      # per-engine probe: auth, quota, wake path
npx cumora@latest agent computer --status
tail -f ~/.cumora/daemon.log
```

The server records what a computer advertised, which is the fastest way to see
the effect of an env fix:

```bash
curl -s localhost:5181/api/computers -H "authorization: Bearer $TOKEN" \
  -H "x-company-id: $COMPANY" | jq '.[0].available_engines'
```

## Data, backup, and logs

```text
<userData>/local/               # userData = ~/Library/Application Support/Cumora
├── pgdata/                     # the whole database (PGlite/Postgres files)
├── uploads/                    # avatars/ and attachments/ (local disk)
├── server.env                  # OPENAI_API_KEY + AGENT_RUNTIME_SECRET (0600)
└── logs/server.log             # the forked server's stdout/stderr
```

Backing up the app is copying that directory. `Me → Local server → Show data
folder` opens it.

Health and logs, without the GUI:

```bash
curl -s localhost:5181/api/health          # {"ok":true,…}
tail -50 ~/Library/Application\ Support/Cumora/local/logs/server.log
```

## Migrating a Cumora Cloud workspace

One-off, read-only against the cloud API, idempotent on re-run:

```bash
CUMORA_DATA_DIR="$HOME/Library/Application Support/Cumora/local" \
CUMORA_UPLOADS_BASE=http://127.0.0.1:5181 \
CUMORA_CLOUD_TOKEN=<session token> CUMORA_CLOUD_COMPANY=co-xxxxxxxx \
node --import tsx scripts/import-cloud-workspace.ts --display-name=Seiko
```

It imports participants (agents), conversations, messages, avatars, and
attachment images. Cloud human ids are remapped to the local user, agents
arrive with `computer_id = NULL` so the next pairing adopts them, and
`companies.starter_seeded_at` is stamped so pairing does not seed a duplicate
starter team. Run it with the app **closed** — the database allows a single
writer.

## Branding and identity

Everything here is local, so there is no provider to read any of it from:

| what | endpoint | where it shows |
|---|---|---|
| your name / email / avatar | `PATCH /api/me`, `POST /api/me/avatar` | profile card, message authors, roster |
| an agent's portrait | `POST /agents/:id/avatar` (or `/avatar/generate`) | every place the agent appears |
| workspace name / logo | `PATCH /companies/:id`, `POST /companies/:id/logo` | title bar, workspace switcher, sign-in screen |

Images are stored under `<userData>/local/uploads/avatars/` and served from the
API origin, so nothing leaves the machine and no CDN is involved.

## Embedded-database constraints

`server/src/db/embedded.ts` runs the whole server against one PGlite backend
and emulates the `pg` pool contract:

- `pool.query(...)` takes the backend for one statement.
- `pool.connect()` + `BEGIN` takes it exclusively until `COMMIT`/`ROLLBACK`;
  other statements queue FIFO, so transactions keep their isolation.
- Both `query(text, values)` and `query({ name, text, values })` are accepted
  (the statement name is ignored — no prepared-statement cache).
- **Do not touch the pool while holding an open transaction** (e.g. calling a
  helper that does `pool.query` inside a `BEGIN … COMMIT` block). The gate
  serializes transactions, so that nests into a deadlock; it fails fast with
  `[embedded-pg] backend wait timeout` after 20 s rather than hanging forever.
  Hoist such reads above the transaction.
- Every statement runs under a **statement timeout** (default 30 s,
  `CUMORA_EMBEDDED_STATEMENT_TIMEOUT_MS`). One backend means one runaway query
  would freeze the whole app — no HTTP, no timers, no signal handling — so the
  ceiling is what keeps a bad query a *logged error* instead of a hung window.
  Statements slower than 3 s (`CUMORA_EMBEDDED_SLOW_QUERY_MS`) are logged with
  their SQL to `logs/server.log`, which is how you find the culprit.
- `pg_advisory_lock` is single-session here — fine for one server instance.
- The server **binds 127.0.0.1** in embedded mode. `POST /api/auth/local` mints
  a session without any credential, so the port must not be reachable from the
  LAN; `CUMORA_BIND_HOST` overrides it if you really want otherwise.
- `pgvector` is unavailable, so agent memory degrades to the recency-only path
  the code already supports; `pg_trgm` ships with PGlite and is used normally.

Local-storage URLs are absolute (`CUMORA_UPLOADS_BASE`): the packaged renderer
runs on `app://cumora`, where a relative `/uploads/...` would resolve against
the app scheme and 404 every avatar and attachment.

## If the database is damaged

PGlite dies with the process. **Quitting the app closes it cleanly** (that is
what `Me → Quit`, ⌘Q, and the tray menu do), but a hard kill — `kill -9`, a
force-quit from Activity Monitor, a kernel panic, a power loss — can leave it
needing repair. Never SIGKILL the server process to "fix" a slow app; if you
must stop it, send SIGTERM and let it shut down.

Two failure modes, both recoverable:

| symptom | cause | remedy |
|---|---|---|
| App shows nothing and `logs/server.log` ends in `PGlite failed to initialize properly` (Postgres log: `xlog flush request … is not satisfied`) | a hard kill left an FSM page past the end of the WAL | automatic: startup quarantines the `*_fsm` files next to `pgdata` and retries (they are disposable hints) |
| A query that should take milliseconds spins forever / every request about one table times out | corrupt tuples in a table's heap (a HOT-chain cycle makes scans loop) | `node --import tsx scripts/local-db-doctor.ts --repair` |

Diagnose and repair with the app **closed** — the database takes a single
writer:

```bash
node --import tsx scripts/local-db-doctor.ts                    # integrity report
node --import tsx scripts/local-db-doctor.ts --repair           # VACUUM FULL / REINDEX what is broken
node --import tsx scripts/local-db-doctor.ts --reset-stuck-runs # close runs left 'running' by a crash
```

The report uses Postgres' own tools: `verify_heapam` (amcheck) per table and
`bt_index_check` per b-tree index. A crash can lose the transactions that were
in flight — in practice the last few messages; everything committed earlier is
durable, and `logs/server.log` shows what the process was doing.

## Verification checklist

```bash
npm run typecheck && npm run server:typecheck
npm test                                     # no external Postgres/Redis needed
```

Against the packaged artifact (no display required — this runs the app's own
bundled server under Electron's Node):

```bash
APP=/Applications/Cumora.app
ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/Cumora" \
  "$APP/Contents/Resources/local-dist/server.cjs"     # with the app's env vars
curl -s localhost:5181/api/health
```

Then, with the app running: pair a computer, send a message that mentions an
agent, and confirm the reply lands in the conversation — that exercises the
local database, scheduler wake, daemon wake stream, engine turn, and write-back
in one pass.
