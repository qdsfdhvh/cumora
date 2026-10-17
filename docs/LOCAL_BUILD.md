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

**From the app, without a terminal:** Me → Computers → *Add a computer* →
**自动配置本机**. The renderer mints the pairing code (it is the authenticated
client) and the main process runs the same CLI — pinned to the app's version,
with two things done carefully:

- the spawned PATH is **sanitised** first, so session-scoped shims cannot be
  baked into the LaunchAgent (see "If the agents cannot use `gh`" below);
- when unsandboxed engines are allowed, the plist gets
  `CUMORA_BYOA_ALLOW_UNSANDBOXED=1` afterwards and the job is reloaded (the CLI
  installer does not propagate it, and `launchctl kickstart` does not re-read a
  plist).

If a computer is already paired to this workspace, the button mints a **repair**
code for it instead of a fresh pairing code: pairing again would create a second
computer row and strand the agents assigned to the first one. The copy-paste
command stays available as the fallback (browser builds, or a Mac without Node —
the button reports that case instead of failing silently).

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

### If the agents cannot use `gh` (or the wrong `git`)

Symptom: an agent reading a pull request reports
`[Lody GitHub] {"stage":"execute","code":"context_missing"}` while `gh` works
fine in your terminal. Cause: `--install-service` copied the PATH of whatever
shell ran it into the LaunchAgent, so the agents inherit per-session shims (a
`gh`/`git` wrapper that expects that session's context) ahead of your real
binaries.

```bash
node --import tsx scripts/fix-daemon-path.ts --reload   # drops session dirs, restarts the daemon
```

Re-running `--install-service` from such a shell poisons the PATH again — run
the fix afterwards, or install the service from a plain terminal. (The in-app
button sanitises the PATH for you.)

Note: the daemon's state directory is `~/.cumora`; the *repo* honours
`CUMORA_CONFIG_DIR` to override it (so a test or a second install can pair
without touching the running one) — a published CLI older than that change
ignores it.

### Pin the daemon version

`--install-service` also writes `npx -y cumora@latest …`, so every restart of
the service downloads whatever npm published most recently — a daemon can move
under a server you did not upgrade. Pin it to the bundled server's version:

```bash
node --import tsx scripts/pin-daemon-version.ts --reload    # → cumora@<repo version>
node --import tsx scripts/pin-daemon-version.ts --latest    # back to tracking npm
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

There is no cloud to fall back on, so the app backs itself up:

- **Me → 本地服务 → 备份数据…** asks where to save, stops the embedded server
  (which closes the database cleanly), writes a zip, and starts it again — a few
  seconds, the window stays open.
- **Automatic backups** (Me → 本地服务 → 自动备份): **off by default**. Set a
  cadence (daily / weekly) and how many to keep (3 / 7 / 14) and the app writes
  `cumora-<timestamp>.zip` into `<data>/backups`, rotating the oldest out. A
  launch whose schedule is due runs one a few minutes in, in the background.
  Enabling it takes one immediately, so "does it work" is answered at once
  rather than tomorrow. The folder holds only files this feature wrote —
  anything else you drop there is left alone.
- **CLI**, with the app closed:

```bash
node --import tsx scripts/backup-local-data.ts            # → ~/Documents/cumora-backup-<ts>.zip
node --import tsx scripts/backup-local-data.ts --out ~/x.zip
```

The archive holds `pgdata/` (the whole database), `uploads/` (avatars and
attachments), `server.env` and `logs/` — deliberately not whatever else happens
to sit in the data directory. Restoring is unpacking it back into place:

```bash
unzip -o ~/Documents/cumora-backup-<ts>.zip -d "$HOME/Library/Application Support/Cumora/local"
```

The CLI refuses to run while the server is answering, because copying a live
PGlite directory can produce a torn archive — the in-app button is the
convenient path when the app is open.

`Me → 本地服务 → 打开数据目录` reveals the directory itself.

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

## Opening the app

The window paints before the embedded server finishes booting, which used to
mean a bad first impression: `/auth/me` and `/auth/providers` could fail on a
connection error, and a failed probe was treated as an expired session — so the
app looked like a fresh install on every launch and asked you to sign in again.

The renderer and the gate now survive that window:

- the session is **cached** (`cumora.auth.user`, `cumora.auth.companies`), so the
  first frame already renders the real shell instead of a spinner;
- the `/auth/me` probe **retries** while the server boots and only clears the
  session on a real `401` — a transient connection error leaves it alone;
- the sign-in screen waits for the server, retries `/auth/providers`, and only
  then decides whether this is really a first run.

So a launch goes straight to the conversations. The sign-in screen appears only
after an explicit sign-out (remembered in `cumora.auth.signedOut`), and its one
button signs the local account back in.

### Debugging a running app

The packaged app can expose the renderer's Chrome DevTools Protocol port — off
by default, because a live CDP session can read localStorage (which holds the
session token):

```bash
printf '9223' > "$HOME/Library/Application Support/Cumora/enable-devtools"   # or: touch …
open /Applications/Cumora.app
curl -s localhost:9223/json/list          # pick the page target, drive it with CDP
rm "$HOME/Library/Application Support/Cumora/enable-devtools"               # turn it off
```

That is how the boot timing above was measured (`Page.reload` plus polling
`document.body.innerText`).

## Branding and identity

Everything here is local, so there is no provider to read any of it from:

| what | endpoint | where it shows |
|---|---|---|
| your name / email / avatar | `PATCH /api/me`, `POST /api/me/avatar` | profile card, message authors, roster |
| an agent's portrait | `POST /agents/:id/avatar` (or `/avatar/generate`) | every place the agent appears |
| workspace name / logo | `PATCH /companies/:id`, `POST /companies/:id/logo` | title bar, workspace switcher, sign-in screen |

Images are stored under `<userData>/local/uploads/avatars/` and served from the
API origin, so nothing leaves the machine and no CDN is involved.

## Background work on a local machine

The cloud build ran several idle workers on cadences sized for a shared
deployment. Embedded mode slows the ones that only exist for multi-replica
safety, and leaves the functional ones alone (calendar dispatch, poll
expiry, scanner, idle ticks, stale-run and offline-computer sweeps):

| worker | shared | embedded | why |
|---|---|---|---|
| realtime outbox | 1 s poll | 15 s poll | delivery is nudge-driven (`nudgeRealtimeOutbox` fires on every enqueue); the poll only catches a missed nudge |
| db-gc | 5 min | 30 min | retention sweeps over a laptop-sized database |
| workspace cleanup | 1 min | 15 min | only relevant after deleting a workspace |
| email retry | 1 min | 15 min | outbound mail is mock without `RESEND_API_KEY` |
| llm rollup | 2 min | 15 min | the local UI is the only reader |

Each stays overridable: `REALTIME_OUTBOX_INTERVAL_MS`, `DB_GC_INTERVAL_MS`,
`WORKSPACE_CLEANUP_INTERVAL_MS`, `EMAIL_RETRY_INTERVAL_MS`,
`LLM_ROLLUP_INTERVAL_MS`.

## Running on a different model service (DeepSeek, Moonshot, local models)

The server-side LLM calls — the classifiers that triage your inbox, the agenda
classifier, conversation summaries, convene speech — go to whatever endpoint
this is pointed at. By default that is OpenAI. To move them somewhere else, set:

```bash
CUMORA_LLM_BASE_URL=https://api.deepseek.com/v1   # any OpenAI-compatible endpoint
CUMORA_LLM_API_KEY=sk-…                            # falls back to OPENAI_API_KEY
OPENAI_MODEL=deepseek-chat                         # main model
OPENAI_MODEL_SUPPORT=deepseek-chat                 # cheap/classifier model
OPENAI_COMPACTION_MODEL=deepseek-chat              # summaries
```

The app writes these for you in **Me → 本地服务 → 模型服务**: pick a preset
(OpenAI / DeepSeek / custom), and **测试连接** does one tiny round-trip so you see
the provider's own answer — or its own error — instead of a silent agent. A key
entered for a custom provider is stored separately (`CUMORA_LLM_API_KEY`), so
switching providers does not overwrite the OpenAI key; selecting **OpenAI** and
saving clears the custom fields and goes back to the defaults.

Two things are worth knowing before you switch:

- **Model names are passed through untouched.** `OPENAI_MODEL` has to name a
  model the endpoint actually serves; nothing is renamed for you, because a
  silently renamed model is harder to debug than a clear 404. The endpoint must
  support **tool calling and streaming** — that is what agent turns need.
- **Images are a separate setting, because they are a separate capability.**
  `CUMORA_IMAGE_BASE_URL` / `CUMORA_IMAGE_API_KEY` / `OPENAI_IMAGE_MODEL` point
  at whatever can draw, so DeepSeek for text with OpenAI for images is fine (the
  panel in **模型服务** has the fields). With a custom text endpoint and no image
  endpoint, AI avatars are **unavailable** — the app disables 生成 in the agent's
  portrait panel and says why, instead of failing after the click. Uploading a
  picture always works, and new agents simply skip the auto-portrait.
- Embeddings are unnecessary here: the embedded database has no `pgvector`, so
  memory search runs without them, and `embedText` already fails soft.

Local endpoints work the same way — `CUMORA_LLM_BASE_URL=http://127.0.0.1:8080/v1`
for llama.cpp, Ollama or vLLM.

### Local gateways such as Magpie

A gateway that routes by its own model ids and serves the Responses API natively
(Magpie: `~/.config/magpie`, loopback only) should **not** go through the
Chat-Completions translation — it would work, but it would throw away the native
streamed events the turn loop consumes. Pick the **本地网关（Magpie）** preset, or
set:

```bash
CUMORA_LLM_BASE_URL=http://127.0.0.1:3425/v1
CUMORA_LLM_RESPONSES_NATIVE=1          # the panel's checkbox
OPENAI_MODEL=group/daily-coding        # a group the gateway routes
OPENAI_MODEL_SUPPORT=group/cheap-and-feat
CUMORA_IMAGE_BASE_URL=http://127.0.0.1:3425/v1   # gateways usually proxy images too
OPENAI_IMAGE_MODEL=codex/gpt-image-2.5
```

No API key is needed for a loopback gateway; anything non-empty satisfies the
SDK. The boot log then says `(native Responses)` instead of
`(OpenAI-compatible, translated)`.

## Write durability

The embedded database commits with Postgres' default `synchronous_commit = on`
(every commit is flushed before it returns). `CUMORA_DURABILITY=fast` turns that
off, or use **Me → 本地服务 → 写入持久性 → 快速**.

It is opt-in because the measured gain here is small — PGlite writes through a
WASM/FS layer, not a raw block device:

```text
synchronous_commit=on    200 single-row commits → 37ms  (0.18 ms/commit)
synchronous_commit=off   200 single-row commits → 31ms  (0.16 ms/commit)  ≈1.2×
```

The trade: after a power loss or kernel panic the last few committed writes may
be missing. The database stays consistent (`synchronous_commit` affects *how
much* is durable, never whether the data files are torn), and the app already
repairs the one startup failure mode a hard kill can produce (see below).

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
