# Remote Control Server — Notes & Deviations

## Review fixes (2026-01-XX)

All 20 review findings have been addressed:

### CRITICAL fixes
1. **Double-processed device frames** — `deviceConnect` in server.mjs now returns early after
   hello succeeds; `handleDeviceConnection`'s message listener owns all subsequent frames.
2. **Re-hello stacking** — Added `helled` flag; second hello on same socket only updates
   registry without calling `handleDeviceConnection` again.
3. **Stale-socket close clobbers new socket** — `registerDeviceSocket` now closes old socket
   when replaced. Both close handlers have identity guards (`deviceSockets.get(id) !== ws`).
4. **Historical transcript routing** — `req.transcript` now sends `sessionKey` (not `sessionId`);
   device replies `transcript {sessionKey, items}`; server routes by `msg.sessionKey`.
5. **Live ui.transcript.request** — Removed live branch; browser gets
   `ui.send.ack {error:"unsupported"}`.

### IMPORTANT fixes
6. **Device disconnect no longer deletes live sessions** — `deviceDisconnect` calls
   `unsetDevice` (marks offline), keeps all sessions/ring buffers, broadcasts `ui.sessions`.
7. **History replace-per-device** — `sessions.history` now first deletes all `${deviceId}~f~*`
   keys, then upserts new list.
8. **Static web root** — Resolved from module location via `fileURLToPath(import.meta.url)`.
9. **cli status port** — Uses `meta?.port ?? args.port` for display AND healthz probe.
10. **Port validation** — Integer 1–65535 validated in both cli.mjs and config.mjs parseArgs.
    On cmdStart health check failure, pid/meta files are deleted before exit.
11. **cmdStop hygiene** — Both wait intervals cleared in `finally` block. Non-numeric/corrupt
    pidfile treated as stale (removed, success exit).

### MINOR fixes
12. **Token file permissions** — `writeFileSync(tokenPath, token, { mode: 0o600 })`.
13. **HOME typo** — Fixed `process.env.HOME || process.env.HOME` → `|| process.env.HOMEPATH`.
14. **Atomic devices.json write** — Uses tmp file + renameSync.
15. **URL pathname matching** — `/ws` and `/ui` now match via `new URL(url, 'x').pathname === '/ws'`.
16. **buildSessionsPayload** — Uses Map key directly instead of O(n²) `_findKeyBySession` scan.
17. **Static file confinement** — Watertight check: `resolved === webDir || resolved.startsWith(webDir + sep)`;
    blocks path segments starting with `.`.
18. **Application-level pong** — `msg.type === 'pong'` resets pong timer in handleDeviceConnection.
19. **Dropped assistantFullTexts** — Removed unused `assistantFullTexts` store from RingBuffer.
20. **Browser pong-timeout** — Added 20s pong-timeout drop for browser sockets (mirrors device pattern).

## Deviations from DESIGN.md

### 1. `--state` flag passthrough
The CLI accepts `--state <dir>` to override the default state directory (`~/.pi/agent/remote/state/`).
This was added for testing purposes. The server.mjs also accepts `--state` via the shared `parseArgs` function.

### 2. `--port` flag format
Both `--port 4899` and `--port=4899` formats are supported in both CLI and server argument parsing.

### 3. Token auth for /ws endpoint
The DESIGN.md says devices connect via `ws://host:port/ws?token=…`. The server validates the token
using timing-safe comparison before allowing any messages. Wrong token → close 4001.

### 4. `cmd.message` field name
The DESIGN.md shows `cmd.message` with `sessionId` and `text`. The server sends `sessionId` as the
raw sessionId (not the sessionKey), because the device needs the raw sessionId to deliver the
message to the correct TUI turn. The browser sends `sessionKey` in `ui.send`, and the server
looks up the raw `sessionId` from the live session registry before forwarding.

### 5. `ui.send` error handling
- Unknown sessionKey → `ui.send.ack {ok:false, error:"unknown_session"}` (checked first)
- Device offline → `ui.send.ack {ok:false, error:"device_offline"}` (checked second)

### 6. `ui.abort` error handling
Same as `ui.send` — unknown session → `unknown_session`, device offline → `device_offline`.

### 7. `req.transcript` handling
For historical sessions, `req.transcript` is sent with `sessionKey` (the full key like
`device~f~sess-001`) and `file` set to the jsonl filename (e.g., `sess-001.jsonl`).
The device echoes back `sessionKey` in its `transcript` reply, and the server routes by it.
For live sessions, `req.transcript` is no longer sent — the browser receives
`ui.send.ack {error:"unsupported"}` instead (Issue 5 fix).

### 8. History session key format
Historical session keys use the format `${deviceId}~f~${basename(file)}` (without `.jsonl` extension),
matching the DESIGN.md specification. The `file` field in `req.transcript` includes the `.jsonl`
extension. On `sessions.history` receipt, old history entries for the device are first purged
(Issue 7 fix) before upserting the new list.

### 9. Ping/pong keepalive
- 30s ping interval to both devices and browsers
- 20s pong timeout — device/browser dropped if no pong within 20s
- Pong timeout timer is reset on each received pong

### 10. State persistence
`devices.json` is persisted after device connect, disconnect, and on server shutdown. Uses atomic
write (tmp file + renameSync) to prevent corruption (Issue 14). The `status` subcommand reads the
stored port from `server.meta` when available (Issue 9 fix). Sessions are NOT deleted on device
disconnect — only on explicit `session.unregister` or server restart (Issue 6 fix).

### 11. HTTP static serving
The server serves static files from `remote/web/` relative to the current working directory.
If the directory doesn't exist, unknown paths return 404. The `/healthz` endpoint always works.

### 12. PID file management
- `start`: writes `server.pid` and `server.meta` (with port and start time)
- `status`: reads pid/port/token, probes `/healthz`
- `stop`: sends SIGTERM, waits for exit, removes pid file
- Stale pid files are detected by probing `/healthz`

### 13. Log file
Server stdout/stderr is written to `state/server.log`. The CLI creates the log file on start.

### 14. No TLS
As specified in DESIGN.md, the server binds to 0.0.0.0 with no TLS (LAN only).

### 15. Ring buffer
Live sessions keep the last 200 events in a ring buffer. Full text of up to 20 assistant messages
is stored separately for replay.

## Verification Results

All tests passed:
- Server starts on specified port with --state flag
- /healthz returns correct JSON with port, devices, uptime
- Token auth works (correct token accepted, wrong token rejected with close 4001)
- Device client: hello → hello.ok, session.register, stream deltas, assistant_end, user messages, tool lines, state changes, sessions.history
- Browser client: ui.init → ui.sessions, ui.subscribe → ui.session.recent, ui.event relay, ui.send → cmd.message to device, ui.abort → cmd.abort to device
- Error handling: unknown_session and device_offline errors for ui.send/ui.abort
- History sessions are registered and visible in ui.sessions
- Device disconnect cleans up sessions and persists devices.json

## Files Created

- `remote/server/server.mjs` — main server entry point
- `remote/server/lib/config.mjs` — port/token/state-dir resolution
- `remote/server/lib/registry.mjs` — device/session/history registry with ring buffers
- `remote/server/lib/relay.mjs` — WebSocket plumbing for device and browser sockets
- `remote/server/lib/http.mjs` — HTTP server with static files and /healthz
- `remote/cli.mjs` — CLI with start|status|stop subcommands
- `remote/NOTES-server.md` — this file