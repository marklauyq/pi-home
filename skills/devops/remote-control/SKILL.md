---
name: remote-control
description: Manage the pi remote-control LAN server (browser SPA + phone-home pi clients) from the agent side. Use when the user asks to start/stop/check the remote server, debug why a device won't connect, or wire up the pi client extension.
---

# Pi Remote Control — server management

The remote-control system has two halves, both living in `~/.pi/agent`:

- **Server** (`remote/server/server.mjs`, driven by `remote/cli.mjs`): LAN WebSocket + HTTP
  server. Serves the browser SPA (`remote/web/`) and relays between browser UIs and
  phone-homing pi devices. No TLS, binds 0.0.0.0 — LAN only.
- **Client** (`extensions/remote-control.ts`): each pi session phones home to the server,
  relays its live events, and accepts remote message/abort. Gated on
  `settings.json → remoteControl`.

## The CLI (the only thing you need for start/stop)

Run from `~/.pi/agent`. The server is a detached daemon, so a plain `bash` call is fine
(not `bg_start`):

```bash
node remote/cli.mjs start   [--port N] [--state <dir>] [--no-docker]
node remote/cli.mjs status  [--state <dir>]
node remote/cli.mjs stop    [--state <dir>]
```

- Default port **4820**, default state dir **`~/.pi/agent/remote/state/`**.
- **Docker-first (2026-08-23):** when `docker` is available, `start` builds + runs the
  container (`remote/docker/docker-compose.yml`, name `pi-remote-relay`, state dir
  mounted at `/state` → same token, no client changes) and `stop` does `compose down`.
  `--no-docker` forces the bare-metal node process; without docker it falls back
  automatically. `status` prints the runtime (`docker container …` or `PID …`).
- `start` refuses if already running (docker or pid); auto-removes a stale pid file;
  deletes pid/meta if the post-start health check fails.
- `status` prints runtime/PID, port (from `server.meta`), uptime, connected devices,
  and the token.
- `stop` sends SIGTERM (bare-metal), waits up to 5s, cleans the pid file. Corrupt pids
  are treated as stale and removed (success).

Docker image: `remote/docker/Dockerfile` (node:22-alpine, copies `server/` + `web/`,
installs the one runtime dep `ws`). Logs: `docker logs pi-remote-relay`. The server
skips writing `server.pid`/`server.meta` when it is PID 1 (container entrypoint), so a
mounted state dir is never polluted with a host-meaningless pid.

**SPA changes need an image rebuild** — `web/` is baked into the image at build time
(only `state/` is a volume). After editing `remote/web/*`: `remote stop && remote start`
(`start` runs `compose up -d --build`), or just `docker compose -f remote/docker/docker-compose.yml up -d --build`.

## State dir layout (`~/.pi/agent/remote/state/`)

| File | Purpose |
| --- | --- |
| `server.pid` / `server.meta` | daemon pid; `{port, startedAt}` (bare-metal only; container skips both) |
| `token` | shared WS auth token, **mode 0600** |
| `server.log` | all server stdout/stderr (bare-metal; docker uses `docker logs`) |
| `devices.json` | persisted device registry (atomic writes) |

In docker mode the whole state dir is the container's `/state` mount, so everything
persists across `compose down` / rebuilds — token, device registry, and the client
settings stay in sync automatically.

Health probe (used by the CLI, also handy for quick checks):

```bash
curl -s http://127.0.0.1:4820/healthz
# → {"ok":true, ...port, uptime, devices}
```

Browser UI: `http://<host>:4820/` (desktop open-webui-style, mobile Claude-Code-style).

## The two client-side extensions (split 2026-08-22)

- `extensions/remote-server.ts` — **server manager only** (no WS code): the
  `/remote-server` command (`start|status|stop` via `remote/cli.mjs`, `add <url> [token]`,
  bare = menu when unconfigured).
- `extensions/remote-control.ts` — **phone-home client only**: the WS relay + the
  `/remote` command. The **WS connection** happens only when merged `settings.json`
  has:

```json
{ "remoteControl": { "url": "ws://<host>:4820", "token": "<token>", "name": "optional-device-name" } }
```

- No `remoteControl.url` → client handlers no-op; bare `/remote-server` in the TUI offers
  "Start local server" (auto-writes the global settings, then `/remote on` to connect)
  or "Add remote server URL…" (interactive prompts). Headless modes get a usage hint.
- **`/remote` — the user's connect choice (box-wide, persisted):**
  - bare `/remote` → status (ON/OFF, url, connected?, device id)
  - `/remote on` → connect now / resume (removes the off marker)
  - `/remote off` → disconnect and **stop all connect attempts on this machine** —
    persisted in `remote/state/client.off` and re-checked dynamically on every
    connect/reconnect, so it applies to every session on the box immediately
    and survives restarts until `/remote on`
  - `connect()` hard-refuses to open a socket while the marker exists (single
    choke point); the "disconnected" toast fires only when a socket that had
    actually opened then drops — a down server never toasts
- **In-process child sessions are skipped** (2026-08-23): subagent/`btw` sessions run in
  the *same* process and share the extension module (ESM cache, same PID) — their
  lifecycle/message events fire the very same handlers as the main session. The
  module tracks one session (`currentSessionId`) and only acts on events whose
  `ctx.sessionManager.getSessionId()` matches it. A session is tracked when
  `session_start` has `reason: "reload"` **or** `ctx.hasUI === true`. The reason
  clause matters: pi's `/reload` re-emits `session_start` for the tracked session
  *before* the runner's UI context is re-attached (agent-session.js `reload()`:
  the emit happens while `uiContext` is still the no-op one), so `hasUI` is false
  there — trusting `reason: "reload"` keeps reloads reconnecting while subagent
  starts (reason `"startup"`, `hasUI: false`, mode `"print"`) stay excluded.
  Result: the remote dashboard shows exactly the interactive sessions — one card
  per user TUI, never per subagent — and remote messages can't be steered into a
  child session.
- Server-manager subcommands: `start|status|stop [--port N]`, `add <url> [token]`
  (writes global `~/.pi/agent/settings.json`), bare = report state.
- `start` with no configured url auto-configures (reads token/port from
  `remote/state/`, writes settings, tells you to `/remote on`); with a configured
  url it's a plain CLI passthrough.
- Wrong/missing token → server closes with 4001, client sets `fatalAuth` and does **not**
  reconnect; user gets one `ui.notify`. Fix the token, then `/remote on`.
- Keepalive: server pings every 15s, 45s pong timeout (4002). A healthy client pongs
  each ping — if 4002s recur the constants are broken again (timeout must exceed interval).
- Reconnects use exponential backoff 2s→30s with jitter; reset on `hello.ok`;
  suppressed entirely while `/remote off` is active.
- Client console chatter is silent unless `PI_REMOTE_DEBUG=1` (it lands in the TUI
  footer, crowding the chat box).

## Troubleshooting

1. **"not responding (pid ... may be stale)"** from `status` → `stop` (cleans the pid),
   check `server.log` tail for why it died, then `start`.
2. **Zombie server — port in use but CLI thinks nothing is running** (`status` says
   "no pid file" yet `curl :4820/healthz` answers): a server started outside the CLI
   (or whose pid file was lost). Find it with `lsof -nP -iTCP:4820 -sTCP:LISTEN`, then
   either restore manageability: `echo <pid> > remote/state/server.pid`, or kill the pid
   and `start` fresh. `start` now verifies the spawned daemon is actually alive, so a
   port collision fails cleanly instead of phantom-successing against the old server.
3. **Port in use** → start with a different `--port N`, and tell the user to point
   browsers/clients at the new port. `status` probes the port stored in `server.meta`,
   so after a custom-port start always use the matching `--port`/state dir.
4. **Device shows offline in the browser** → check `devices.json` + server log
   (`remote/state/server.log` bare-metal, `docker logs pi-remote-relay` in docker mode);
   confirm the client's `remoteControl.url`/`token` match; remember a wrong token is
   *fatal* for the client (no retry).
5. **Docker mode quirks** → `start --no-docker` forces bare-metal; a container that
   starts but fails healthz leaves the image up (`docker logs` then `remote stop`).
   `server.pid`/`server.meta` in the state dir are stale in docker mode (the container
   is PID 1 and skips writing them) — ignore them.
5. **Reconnect churn** (repeated hello/bye in `server.log`) → client can't reach the
   server, or NAT/firewall between LAN devices; backoff caps at 30s so it self-throttles.
6. **Sessions vanished after device disconnect** — they shouldn't: disconnect only marks
   the device offline; sessions/ring buffers survive until server restart or explicit
   unregister.

## Security notes

- Treat `state/token` like a credential: **never print it into the agent's
  conversation context or commit it.** Agent-side rule: when running the CLI via
  bash, redact at the pipe (e.g. `... status | sed -E 's/^Token:.*/Token: <REDACTED>/'`).
  Exception: the **user-facing TUI toast** from `/remote-server status` deliberately
  shows the token in full — the user copies it into the browser UI. Do NOT mask it.
- No TLS: anyone on the LAN with the token can read/drive the pi sessions. Rotate by
  deleting `state/token` and restarting the server (new token generated), then update
  every client's `settings.json`.

## Verification after any server change

```bash
node remote/cli.mjs start && node remote/cli.mjs status && curl -s http://127.0.0.1:4820/healthz
```

All three should report running/ok. Then `node remote/cli.mjs stop` if it shouldn't
keep running.
