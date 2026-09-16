# Remote Control — Client Extension Notes

## Review Fixes (2026-08-21)

All 14 review items applied. See `extensions/remote-control.ts` for the implementation.

### Critical Fixes

1. **`pi` out of scope in `handleRemoteMessage`** — Captured `pi` at factory time as module-level `let api`. All `sendUserMessage` calls go through `api?.sendUserMessage(...)`.

2. **`deviceRegistered` never set true** — Set `deviceRegistered = true` in the `hello.ok` handler. After `hello.ok`, sends `session.register` + `sessions.history` (idempotent: guarded by `isConnected && deviceRegistered` check on `session_start`).

3. **Reconnect flow** — On every `open` → `sendHello()`. On `hello.ok` → re-register current session + re-send sessions.history. Matches DESIGN.md.

4. **JSONL parse wrong shape** — Real entries: `{"type":"message",...,"message":{"role":"user"|"assistant"|"toolResult",...}}`. Fixed `listSessionsTop50` (lastUserText from `entry.message.role==="user"`) and `parseTranscript` (user/assistant text from `entry.message`). Tool lines from tool-related entries use `toolSummary()` for bash→command, read/edit/write→path. Model comes from `model_change` entries ({provider, modelId}), not from the header.

### Warning Fixes

5. **WS lifecycle moved to session events** — Removed `connect(rc)` from factory. Connect on `session_start` (with idempotent guard: `if (!ws) connect(rc)`). Disconnect on `session_shutdown` (calls `disconnect()`).

6. **WS message dispatch wrapped in try/catch** — The entire `ws.on("message", ...)` handler is wrapped in try/catch (logs, never crashes pi). Also wrapped `sendUserMessage` in try/catch in `handleRemoteMessage` so a throw can't kill the process.

7. **Path traversal guard in `req.transcript`** — Requires `basename(file) === file`, rejects "/" or "..", resolves and verifies the path stays inside the sessions directory.

8. **Session dir: env-var pre-check removed** — `getSessionsDir()` now calls `ctx.sessionManager.getSessionDir()` only. No `PI_CODING_AGENT_SESSION_DIR` env var check. Documented as a limitation below.

9. **Delta keying per TURN** — Replaced `event.message.id` keying with `currentAssistantKey` that increments on each assistant `message_start`. Snapshot stored per-turn key. Reset at assistant end.

10. **Remote-message tagging: positional flag** — Replaced `pendingRemoteTexts` Set with `nextUserMessageIsRemote` boolean flag. Set `true` right after calling `sendUserMessage` in `handleRemoteMessage`; consumed on the next user-role `message_start` (sets `source:"remote"`, else `"local"`).

11. **`hello.error` (bad token)** — Sets `fatalAuth = true`; does NOT schedule reconnect. Notifies the user once via `ctx.ui.notify()` with the error code.

### Suggestion Fixes

12. **Exponential backoff with jitter** — Attempt counter `reconnectAttempts`. Delay = `min(2000 * 2^attempts, 30000)` ± 25% jitter. Reset on `hello.ok`.

13. **Skip empty `assistant_end`** — In `onMessageEnd`, if the accumulated full text is empty, skip sending `stream.assistant_end` entirely.

14. **`listSessionsTop50`: one read + one split per file** — Reads the file once, splits into lines once, then scans from end (for last user text) and from beginning (for model/cwd). Previously read the file 3 times per session.

### Additional: Recursive session scan

Sessions are stored in cwd-named subdirectories under `~/.pi/agent/sessions/`. Added recursive `scan()` function to `listSessionsTop50` to find all `.jsonl` files across subdirectories.

## Second Review Fixes (2026-08-22)

Six targeted fixes applied to `extensions/remote-control.ts`.

1. **Transcript tool lines now have real summaries** — `parseTranscript` now does a two-pass scan: first builds a `toolCallId → {toolName, args}` map from assistant entries' `toolCall` content blocks, then uses it when processing `toolResult` entries so `toolSummary()` receives real args (bash→`Ran <cmd>`, read→`Read <path>`, etc.). Previously tool entries only had `{}` and produced empty summaries.

2. **`getRepoRoot()` off-by-one** — Changed `dirname(dirname(__dirname))` to `dirname(__dirname)`. `__dirname` is already the repo's `extensions/` dir, so one level up is the repo root where `remote/cli.mjs` lives.

3. **`sendSessionRegister` unused parameter removed** — The `settings` parameter was never used inside the function (all values come from module state). Dropped the parameter and updated both call sites.

4. **Remote-tag flag leak** — `nextUserMessageIsRemote = true` is now reset in the `catch` block of `handleRemoteMessage` so that if `api?.sendUserMessage()` throws or `api` is null, the flag doesn't persist and mislabel the next local user message.

5. **Dead code cleanup** — Removed unused `currentAssistantFullText` module variable (declared, assigned, but never read). Also removed its assignments in `onMessageEnd` and `onSessionShutdown`.

6. **Path traversal guard tightened** — Removed the overly-broad `file.includes("..")` check from the `req.transcript` guard. The `basename(file) !== file` check plus the `resolve().startsWith()` containment check are sufficient.

## Design Interpretations & Decisions

### 1. Remote Message Source Detection (`message.user {source}`)

**Challenge**: Distinguish locally-typed user messages from remote-injected ones.

**Approach (FIXED per review #10)**: Uses a positional flag `nextUserMessageIsRemote`. When `handleRemoteMessage()` calls `api.sendUserMessage()`, it sets `nextUserMessageIsRemote = true` immediately after. When `message_start` fires for a user message, the flag is checked — if true → `source:"remote"`, else `source:"local"`. The flag is consumed (set to false) after matching.

**Rationale**: The previous text-set matching approach (`pendingRemoteTexts` Set with 30s TTL) was fragile — identical text from different sources could collide. The positional flag is deterministic and doesn't require TTL cleanup.

**Limitation**: If a local user message happens to be injected between the `sendUserMessage` call and the `message_start` event, it could be incorrectly tagged. In practice this is extremely unlikely since pi processes messages synchronously.

### 2. `sessions.history` Response

**DESIGN.md**: `sessions.history` has no `sessionId` field in the response table.

**Decision**: Omit `sessionId` from the `sessions.history` response. The server knows which device is sending it (one-to-one WebSocket).

**Fields sent** (per DESIGN.md):
- `file` — basename only (not full path)
- `updatedAt` — mtime in ms
- `lastUserText` — scanned from end of file
- `model` — from session header (optional)
- `cwd` — from session header (optional)
- `messageCount` — line count

### 3. `sessions.history` Send Timing

**DESIGN.md**: "sent after hello and on `req.history`"

**Decision**: Send `sessions.history` only after hello (on connect) and in response to `req.history`. Do NOT send it on `session_start` — only `session.register` is sent on `session_start` (per DESIGN.md: "sent on connect and on every `session_start`").

### 4. `tool.line` at `tool_execution_start`

**DESIGN.md**: "`tool_execution_start` or `_end` — one line per tool call"

**Decision**: Use `tool_execution_start` because the input data (`args`) is cleanest there. The `tool_execution_end` has `result` data which is less useful for a one-line summary.

**Format** (per DESIGN.md):
- bash → `Ran <cmd truncated 60>`
- read → `Read <path>`
- write → `Created <path>`
- edit → `Edited <path>`
- other → `<toolName> …` (or `<toolName> <firstArg>` if available)

### 5. Transcript Parsing

**DESIGN.md**: "parse the jsonl fully, map entries to the shared 'Transcript items' shape"

**FIXED per review #4**: Real JSONL shape is `{"type":"message",...,"message":{"role":"...",...}}`. Model comes from `"type":"model_change"` entries.

**Handled entry types**:
- `type: "message", message.role: "user"` → `{ type: "user", text }`
- `type: "message", message.role: "assistant"` → `{ type: "assistant_delta", messageId, text: "" }` + `{ type: "assistant_end", messageId, text }`
- `type: "message", message.role: "toolResult"` → `{ type: "tool", text: toolSummary(toolName, {}) }`
- `type: "session"` (header) → skipped
- `type: "model_change"` → tracks last model as `{provider}/{modelId}` (used in history, not transcript)
- `type: "thinking_level_change"` → skipped

**FIXED per review #13**: Skips `assistant_end` when accumulated text is empty.

**FIXED per review #14**: One read + one split per file in `listSessionsTop50`.

### 6. TUI Feedback

**Approach**: Use `ctx.ui.notify()` for connect/disconnect events. This is the correct method per pi docs — `ctx.ui.notify()` works in both TUI and RPC modes (and is a no-op in print/JSON modes).

**NOT using**: `pi.notify()` — this method does not exist in the pi ExtensionAPI.

### 7. WebSocket Global

**DESIGN.md**: "uses global `WebSocket` — Node ≥22 has it"

**Decision**: Use `globalThis.WebSocket` (Node 22+ global). No `node:ws` import.

### 8. Sessions Directory

**DESIGN.md**: "default `~/.pi/agent/sessions` — use `ctx.sessionManager`'s known dir or env `PI_CODING_AGENT_SESSION_DIR` if set"

**FIXED per review #8**: Uses `ctx.sessionManager.getSessionDir()` only. Removed `PI_CODING_AGENT_SESSION_DIR` env var override.

**Caveat**: `getSessionDir()` returns the current session's directory (e.g., `~/.pi/agent/sessions/--cwd--`). For `listSessionsTop50`, the function now recursively scans subdirectories under the sessions root to find all `.jsonl` files. This means the effective behavior is cwd-scoped unless the top-level sessions dir is passed.

### 9. `ctx.isIdle()` for Abort Guard

**DESIGN.md**: "Guard: only abort when `!ctx.isIdle()`"

**Decision**: Check `ctx.isIdle()` before calling `ctx.abort()`. If idle, do nothing (nothing to abort).

### 10. `cmd.message` — `deliverAs` and `expandPromptTemplates`

**DESIGN.md**: "if agent is busy (ctx.isIdle() false) → pi.sendUserMessage(text, {deliverAs:'steer'}), else pi.sendUserMessage(text). If text starts with '/' add {expandPromptTemplates:true}"

**Decision**: 
- Idle → `pi.sendUserMessage(text)` (no options needed)
- Busy → `pi.sendUserMessage(text, { deliverAs: "steer" })`
- Slash prefix → add `{ expandPromptTemplates: true }` to either case

### 11. `sessions.history` in `req.history` Response

**DESIGN.md**: `req.history` → device re-scans sessions dir, replies `sessions.history`

**Decision**: The response is a plain `sessions.history` message with just the `sessions` array (no `sessionId`).

### 12. `transcript` Response

**DESIGN.md**: `transcript` → `sessionId, items`

**Decision**: Include `sessionId` from the original `req.transcript` request, plus the parsed `items` array.

### 13. `file` in `sessions.history`

**DESIGN.md**: `file` in the history list format — interpreted as basename (consistent with how the server references files via `${deviceId}~f~${basename(file)}` for historical sessions).

**Decision**: Return basename only, not full path.

### 14. `/remote-server` Command

**DESIGN.md**: "shell-executes the CLI via child_process detached + unref"

**Decision**: Use `execFileAsync("node", [cliPath, ...cliArgs])` with `pi.exec()` equivalent. The repo root is computed from `dirname(dirname(__dirname))` since the extension lives at `extensions/remote-control.ts`.

**Output**: Shown via `ctx.ui.notify()` (works in TUI and RPC modes).

### 15. `agent_start` for `lastCtx`

**DESIGN.md**: "capture the latest `ctx` from any handler into module-level `let lastCtx`"

**Decision**: Capture `ctx` in both `session_start` and `agent_start` handlers. `agent_start` ensures we have a valid ctx even if session_start happened long ago and the session was reloaded.

### 16. `tool.line` — No `tool_execution_end` Emission

**DESIGN.md**: "one `tool.line` per tool call" (singular)

**Decision**: Only emit at `tool_execution_start`. Do NOT emit at `tool_execution_end` to avoid duplicates.

## Verification

### No-op Path (no `remoteControl` in settings)
- `inspect_extension` on `extensions/remote-control.ts` reports: "loaded, but registered/rendered nothing observable"
- This is the expected behavior — factory returns early when `remoteControl.url` is not found
- No errors, no warnings

### Settings-Gated Code
The settings gate is cleanly separated:
```typescript
const settings = readSettings();
const rc = getRemoteControlSettings(settings);
if (!rc) return; // register nothing
```
This makes the no-op path trivially testable.

### TypeScript Compilation
- No external imports (only `@earendil-works/pi-coding-agent` types and Node builtins)
- All types are inline or local interfaces
- No `node:ws` import (uses global WebSocket)

## Deviations from DESIGN.md (if any)

None significant. All protocol messages match the DESIGN.md wire format tables.

## Known Limitations

1. **No ping timer**: The DESIGN.md says server sends ping every 30s and drops device if no pong in 20s. We handle pong replies but don't implement a client-side ping timer (server handles the timeout).

2. **No TLS**: Per DESIGN.md non-goals, this is LAN-only with no TLS.

3. **Single session**: We only control the current session. Messages for other sessionIds are ignored (per DESIGN.md: "ignore if sessionId doesn't match current").

4. **No fatal auth reconnect**: On `hello.error` (bad token), the extension sets a `fatalAuth` flag and does NOT attempt reconnect. The user is notified once. This is per review fix #11.

5. **Cwd-scoped sessions dir**: `getSessionsDir()` uses `ctx.sessionManager.getSessionDir()` which returns the current session's directory. The `listSessionsTop50` function recursively scans subdirectories to find all sessions, but the root is scoped to the current session's directory. If sessions are organized differently across machines, this may not find all sessions.

## Protocol Alignment

Updated to match the DESIGN.md wire protocol revision (server-side worker changed remote/server files in parallel). No git commit — server changes tracked separately.

### 1. `req.transcript` → `transcript` key rename (`sessionId` → `sessionKey`)

- **Request**: Server now sends `req.transcript {sessionKey, file}` instead of `{sessionId, file}`. `sessionKey` is the canonical identifier (e.g. `${deviceId}~f~${basename}` for historical sessions).
- **Reply**: `sendTranscript` now takes `sessionKey` and sends `{ type: "transcript", sessionKey, items }` instead of `{ sessionId, items }`.
- **Guard removed**: The `sessionId === currentSessionId || !currentSessionId` guard was removed from the `req.transcript` handler. Historical transcripts belong to this device regardless of the currently open session. (The guard remains on `cmd.message` and `cmd.abort` — those are live-session commands where the guard is correct.)

### 2. File lookup: recursive basename search

- `file` in `req.transcript` is a basename. Sessions live in cwd-named subdirectories under the sessions dir.
- Replaced `resolve(sessionsDir, file)` (which only works for files directly in the sessions root) with a recursive `findFile()` that walks depth ≤ 2, matching `basename(p) === file` and verifying `resolved.startsWith(resolve(sessionsDir))`.
- First match wins. Existing path-traversal guards (`basename(file) !== file`, `resolved.startsWith(sessionsDir)`) are preserved.

### 3. `stream.assistant_delta` / `stream.assistant_end` now include `messageId`

- DESIGN.md table requires `messageId` on both delta and end frames.
- Added `messageId: currentAssistantKey` to both `sendAssistantDelta()` and `sendAssistantEnd()` calls.
- `currentAssistantKey` is the per-turn counter already used for delta snapshotting — stable key for ONE assistant message.

### 4. `cmd.message` / `cmd.abort` unchanged

- Both still use `sessionId` from the server and compare against `currentSessionId` (or accept if `!currentSessionId`). No changes.