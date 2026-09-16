# Pi Remote Control — Design & Wire Protocol

## Goal
Every pi instance with `remoteControl` in its settings phones home (outbound WebSocket)
to a small LAN server. A browser UI (desktop = open-webui-style panes, mobile = Claude
Code app look, catppuccin-mocha colors) lets you watch live sessions, read historical
transcripts, send messages into a live TUI session, and interrupt it.

v1 scope decisions (agreed with owner):
- Messages go into the **live pi TUI session** only. No spawning headless sessions. No "new chat".
- **Interrupt** supported (Esc equivalent). No permission-approval prompts.
- **LAN only**, single shared token, no TLS. Server binds 0.0.0.0.
- Tool calls render as a **simple one-liner** (e.g. "Ran a command", "Edited foo.md"). No diff details, no expanding sheets, no running-task indicator, no context-limit banner.
- History: device lists its `sessions/*.jsonl`; browser can open a historical session
  **read-only** (transcript rendered by the device and sent back).
- Plain JavaScript (ESM) everywhere — **no build step, no frameworks, no runtime deps
  beyond `ws` for the server**. UI is a static SPA served by the server.

## Repository layout (inside `~/.pi/agent`)

```
remote/
  DESIGN.md            this file (protocol contract)
  cli.mjs              node remote/cli.mjs start|status|stop [--port N]
  server/
    server.mjs         entry: node remote/server/server.mjs [--port 4820] (foreground)
    lib/
      config.mjs       port/token/state-dir resolution, token generation
      registry.mjs     devices + live-session + history-session maps, ring buffers
      relay.mjs        ws plumbing for device sockets and browser sockets
      http.mjs         static files, /healthz
  client/
    extension.ts       pi extension (auto-discovered via remote/client → symlink? NO:
                       discovered from ~/.pi/agent/extensions/ — see "Installation")
  web/
    index.html
    app.js             SPA (vanilla JS, event-sourced from ui.* messages)
    styles.css         catppuccin-mocha
    render.js          minimal text rendering (inline code, code blocks, bold, links, escape)
```

Node ESM (`"type":"module"` not required: use `.mjs`). Server deps: only `ws`
(installed at repo root `package.json` — add it there). Client extension: plain TS,
no imports beyond Node builtins (uses global `WebSocket` — Node ≥22 has it; pi runs
on Node ≥22). Web: zero deps.

## Installation / activation

- **Server**: `node remote/cli.mjs start` (detached daemon, survives session close) or
  `/remote-server start` (extension command, shell-executes the CLI via child_process
  detached + unref). State dir: `~/.pi/agent/remote/state/` (`token`, `server.pid`,
  `server.log`, `devices.json` snapshot).
- **Client**: extension lives at `extensions/remote-control.ts` in this repo
  (auto-discovered; it re-exports `remote/client/extension.ts` OR is implemented
  directly there). Settings gate:
  ```json
  "remoteControl": { "url": "ws://host:4820", "token": "…", "name": "inference-dgx" }
  ```
  No `remoteControl` in (merged) settings → extension registers nothing (no-op load).
  Settings read: merge `~/.pi/agent/settings.json` + `<cwd>/.pi/settings.json`
  (project overrides global, nested merge — read manually, simple recursive merge).
  `settings.json` is gitignored; `settings.json.dist` (committed) carries the template.

## Wire protocol

All frames are single JSON objects. Version: `"v":1` in hello only.

### Client → Server (device socket, `ws://host:port/ws?token=…`)

| msg | fields | notes |
|---|---|---|
| `hello` | `token` (also in query), `device:{id,name,host,platform,cwd,agent:"pi"}` | `device.id` = stable: `name` if set else hostname. `name` = settings `name` else OS hostname. |
| `session.register` | `sessionId, cwd, model:{provider,id}, startedAt, label?` | sent on connect and on every `session_start` (new/resume/fork) |
| `session.unregister` | `sessionId, reason` | on `session_shutdown` / disconnect |
| `sessions.history` | `sessions:[{file, updatedAt, lastUserText, model?, cwd?, messageCount}]` | top 50 by mtime; sent after hello and on `req.history` |
| `stream.assistant_delta` | `sessionId, messageId, text` | incremental assistant text (`message_update`); `messageId` = stable key for ONE assistant message (e.g. per-turn counter) — browser accumulates per messageId |
| `stream.assistant_end` | `sessionId, messageId, text` | full final text of the finished assistant message (`message_end`) — browser may replace the partial |
| `message.user` | `sessionId, text, source:"local"\|"remote"` | user input seen on device (both local typing and remote-injected) |
| `tool.line` | `sessionId, text` | one-line summary, e.g. `Ran git status` / `Edited foo.md`. `tool_execution_start` or `_end` — one line per tool call |
| `state` | `sessionId, running` | true on turn start / streaming, false on turn end / idle |
| `transcript` | `sessionKey, items` | response to `req.transcript`; `sessionKey` echoed from the request (server routes by it). `items` = rendered list, see "Transcript items" |
| `pong` | `t` | reply to `ping` |

### Server → Client

| msg | fields | notes |
|---|---|---|
| `hello.ok` | `server:{name:"pi-remote",version}` | else server closes with `hello.error {code:"bad_token",...}` |
| `cmd.message` | `sessionId, text` | device calls `pi.sendUserMessage(text, {deliverAs})`; if text starts with `/` set `expandPromptTemplates:true` |
| `cmd.abort` | `sessionId` | device aborts current turn |
| `req.history` | — | device re-scans sessions dir, replies `sessions.history` |
| `req.transcript` | `sessionKey, file` | server assigns the sessionKey; device reads jsonl, replies `transcript` echoing `sessionKey` |
| `ping` | `t` | every 30s; no `pong` in 20s → drop device |

### Server ↔ Browser (ui socket, `ws://host:port/ui?token=…`)

Server → browser:
| msg | fields | notes |
|---|---|---|
| `ui.init` | `ok:true` | else `ui.error {code}` and close |
| `ui.sessions` | `devices:[{id,name,host,connected}], live:[{sessionKey,sessionId,device,cwd,model,state,startedAt}], history:[{sessionKey,file,device,updatedAt,lastUserText,model?,cwd?,messageCount}]` | pushed on any change (device connect/disconnect, register/unregister, history refresh). Full list each time (simple). |
| `ui.session.recent` | `sessionKey, items` | ring buffer of the live session's recent events (see "Live replay"), sent on `ui.subscribe` |
| `ui.event` | `sessionKey, item` | relay of a single live item (delta/line/state/user/assistant_end) to subscribed browsers |
| `ui.transcript` | `sessionKey, items` | relayed device response for a historical session |
| `ui.send.ack` | `sessionKey, ok, error?` | e.g. unknown session, device offline |
| `ping` | `t` | keepalive |

Browser → server:
| msg | fields |
|---|---|
| `ui.subscribe` | `sessionKey` |
| `ui.unsubscribe` | `sessionKey` |
| `ui.send` | `sessionKey, text` |
| `ui.abort` | `sessionKey` |
| `ui.transcript.request` | `sessionKey` |

`sessionKey` = live: `${deviceId}~${sessionId}`; historical: `${deviceId}~f~${basename(file)}`.

### Live replay (ring buffer)
Server keeps the last 200 items (and full text of last 20 assistant messages) per
live session. When a browser subscribes, server first replays buffer as
`ui.session.recent`, then streams. Deltas are per assistant-message: item
`{type:"assistant_delta", messageId, text}`; browser accumulates per messageId until
`{type:"assistant_end", messageId, text}` (use final `text` when present).

### Transcript items (shared shape, used for live replay + historical transcripts)
```js
{ type:"user", text }
{ type:"assistant_delta", messageId, text }
{ type:"assistant_end", messageId, text? }   // text optional → keep accumulated
{ type:"tool", text }                        // one-line tool summary
{ type:"state", running }                    // informational only
```
Historical transcripts: device parses the jsonl (entries: user/assistant messages +
tool results). One item per user text, one per assistant text, one `tool` line per
tool call (name + first arg summary, e.g. bash→command, read/edit/write→path).

## Server behavior (detail)
- `start`: if pid file alive → error "already running". Spawn detached
  `node remote/server/server.mjs --port N --state <dir>`, unref, log to
  `state/server.log`. Print URL + token.
- `status`: show pid, port (from /healthz or pidfile meta), token, connected devices.
- `stop`: SIGTERM to pid, wait, remove pid file.
- `/healthz` → `{ok, port, devices, uptime}`.
- Unknown sessionKey on `ui.send` → `ui.send.ack {ok:false,error:"unknown_session"}`.
- Device offline on `ui.send` → `ui.send.ack {ok:false,error:"device_offline"}`.
- Persist `devices.json` snapshot (last-seen meta) so `status` works after restart.
- No auth beyond token compare (timing-safe). Wrong token → close code 4001.

## Client extension behavior (detail)
- Gate on `remoteControl.url`; else return from factory (log nothing).
- WS with reconnect backoff 2s→30s (jitter). On reconnect: re-hello, re-register
  current session, re-send history.
- `pi.on` handlers → protocol mapping:
  - `message_update` (assistant streaming) → `stream.assistant_delta`
    (extract incremental text — delta vs previous snapshot; keep last snapshot per messageId).
  - `message_end` (assistant) → `stream.assistant_end` with full text.
  - `message_start`/`message_end` with user role → `message.user {source:"local"}`
    (detect locally-typed user messages; remote ones get `source:"remote"` from the cmd path).
  - `tool_execution_start` (or `_end`, pick the one with clean input data) →
    `tool.line` one-line summary:
    bash→`Ran <cmd truncated 60>`, read→`Read <path>`, write→`Created <path>`,
    edit→`Edited <path>`, else→`<toolName> …`.
  - `turn_start`→`state running:true`, `turn_end`→`state running:false`.
    (Verify event names against docs/extensions.md — adapt if different.)
- `cmd.message` handler: if agent busy use `deliverAs:"steer"`; else plain send.
  Slash prefix → `expandPromptTemplates:true`. Emit `message.user {source:"remote"}`
  is NOT needed — pi itself will emit the user message event; but if pi does not emit
  for injected messages, send it explicitly (check during verification).
- `cmd.abort` handler: `ctx.abort()` — capture latest `ctx` from any handler into
  module-level `let lastCtx` (handlers always run in-session). Guard: only abort when
  `!ctx.isIdle()`.
- `req.history`: scan sessions dir (default `~/.pi/agent/sessions` — use
  `ctx.sessionManager`'s known dir or env `PI_CODING_AGENT_SESSION_DIR` if set),
  top 50 by mtime; `lastUserText` = last user text entry in file (cheap tail scan),
  `messageCount` = line-ish count.
- `req.transcript`: parse jsonl fully, map to items, reply.
- Also register command `/remote-server start|status|stop` (thin wrapper over CLI
  via child_process `node <repo>/remote/cli.mjs …` — repo dir = agent dir, which the
  extension can find from its own file location `dirname(import.meta.url)` or
  `~/.pi/agent`).
- TUI status line: `pi.setWidget`/notify on connect/disconnect (best-effort, optional).

## Web UI (detail)
- Palette: catppuccin-mocha (base #1e1e2e, mantle #181825, crust #11111b,
  surface0 #313244, text #cdd6f4, subtext-0 #a6adc8, green #a6e3a1, red #f38ba8,
  blue #89b4fa, mauve #cba6f7, overlay #6c7086). CSS vars in `styles.css`.
- **Desktop (≥820px)**: left nav rail (48px: home icon, settings gear) + session
  list column (grouped: "Live" then "Today / This week / Older") + chat pane.
  Settings pane = server URL/token display (read from location/query; mostly static).
- **Mobile (<820px)**: home = "Code" header (big, light) + devices row + grouped
  session cards (code icon tile, title, time-ago, green "Connected"/"Disconnected"
  dot, cwd subtitle, last-message preview line). Tap → chat view: top bar
  (back arrow, device name + "Remote control", ⋮), scrollable message area,
  composer bottom (rounded, placeholder "Message…", stop button while running).
- Chat rendering: user = right-aligned card; assistant = left full-width, minimal
  markdown (escape first, then code fences, inline code, **bold**, links);
  `tool` items = dim one-line with ⚙/▶ glyph; running state shows animated dot in
  composer / top bar; disconnect → banner "Device offline — read only".
- Send: `ui.send`; disable composer while waiting for first delta if device offline.
- Time-ago helper; auto-scroll on new items when near bottom.
- No history persistence in browser; live state purely from `ui.*` messages.

## Verification plan (owner does integration)
1. `node remote/cli.mjs start` → healthz OK, token printed.
2. Open browser via agent-browser → home renders, no device yet.
3. In a worktree pi session with remoteControl set → device appears "Connected".
4. Send message → appears as user bubble, agent streams back; interrupt works.
5. Historical session opens read-only.
6. Close pi session → device drops; restart → reconnects.

## Non-goals (v1)
No TLS/tunnels, no multi-user auth, no mobile app, no new-chat/spawn, no tool detail
sheets, no rate limiting, no i18n, no tests suite (manual verification + type-check
via `node --check`).
