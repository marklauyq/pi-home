# NOTES-web.md — Web UI Implementation Notes

## Review Fixes (2026-08-21)

All Critical, Important, and selected Minor review findings have been fixed.

### Critical fixes

1. **Delta accumulation corruption** — `deltaAccum` now stores raw accumulated text per `messageId` instead of DOM elements. A separate `assistantEls` Map stores DOM element references. The `assistant_delta` handler accumulates raw text (`deltaAccum.set(id, (deltaAccum.get(id)||'') + item.text)`) and renders with `el.innerHTML = renderMessage(raw)`. The `assistant_end` handler always cleans up both maps regardless of whether `text` was provided.

2. **`ui.sessions` forces `connected: true`** — Changed from `{ ...d, connected: true }` to just `d`, preserving the server's `connected` flag so offline detection works.

3. **`javascript:` URLs become live links** — `renderMessage` now only emits `href` for URLs matching `^\s*(https?:|mailto:)` or starting with `/` or `.`. Unsafe URLs are rendered as plain text.

4. **`openSession` never unsubscribes old live session** — Added unsubscribe at the top of `openSession`: if a live session was open and its key differs, send `{type:'ui.unsubscribe', sessionKey: old}`.

5. **Reconnect loses subscription and silently drops sends** — Added `wasConnected` tracking: on ws `onopen` after a reconnect, re-sends `ui.subscribe` if `currentSession` is live. On `onclose`, shows "Reconnecting…" placeholder, resets `pendingSend`, and re-enables composer. `send()` when socket not open shows offline hint / inline error instead of silent drop.

### Important fixes

6. **Error shape** — `ui.error` handler now reads `msg.code` first, falls back to `msg.error`. Auth-type codes (`bad_token`, `unauthorized`, `token_required`, `invalid_token`) show login overlay; other codes just display error text.

7. **Reconnect loop** — Replaced unbounded 3s retry with exponential backoff (2s→30s). `ui.error` with auth-type code cancels pending reconnects and shows login overlay. Transient errors reset backoff to 2s.

8. **`assistant_end` without final text** — Both `deltaAccum` and `assistantEls` entries are deleted regardless of whether `text` was provided, preventing later id-reuse merging.

9. **Composer for offline device** — `updateDeviceStatus` now disables `composerInput` when the device for a live session is offline. Re-enables on `ui.sessions` when device reconnects.

10. **DOM growth cap** — `renderEvent` removes the oldest 200 message elements when `messages.length >= 500`, keeping the DOM bounded.

### Minor fixes (done)

- **`white-space: 1.5em` → `white-space: nowrap`** in `.session-card-title`, `.session-card-cwd`, `.chat-title-text` (+ `text-overflow: ellipsis; overflow: hidden` where intended).
- **`.session-card-preview`** — Added `white-space: nowrap` for single-line truncation.
- **Mobile settings unreachable** — Added gear button (`#btn-settings-mobile`) in mobile home header that opens the same settings panel. CSS shows settings pane as full-screen overlay on mobile when not hidden.
- **Gate `ui.send.ack`** — Now checks `msg.sessionKey === currentSession?.sessionKey` before resetting `pendingSend`.
- **Session cards accessibility** — Added `tabindex="0"` + `role="button"` to both live and history session cards. Added `keydown` handler for Enter/Space activation.

### `ui.sessions` handler fix

The `ui.sessions` handler now only calls `renderHome()` when on the home view. When in the chat view, it just updates the device status (showing the offline banner), preventing the chat view from being hidden on device disconnect.

## Ambiguities & Decisions

### 1. `ui.sessions` device field shape
The DESIGN.md says `devices:[{id,name,host,connected}]` but live sessions reference `device` as an object. I handle both: if `s.device` is an object, use it; otherwise look up by `s.deviceId` in the devices map.

### 2. Session title for live sessions
DESIGN.md says "use first user message text from replay if available, else sessionId short." I use `session.label` if present, otherwise fall back to first 20 chars of `sessionId`. The first user message text would only be available after subscribing and receiving `ui.session.recent`.

### 3. `ui.event` relay timing
The DESIGN.md says `ui.event` is "relay of a single live item." I render it immediately for the currently open session. Items for non-current sessions are silently dropped.

### 4. Historical session device offline detection
DESIGN.md says "if device offline → banner 'Device offline'." I check if the device for the session's `sessionKey` is connected in the `devices` map. For historical sessions, the device might have disconnected since the session ended.

### 5. Mobile layout architecture
I use a `data-view="home|chat"` attribute on the `#app` element to control visibility of the session list vs chat pane on mobile, combined with CSS `data-view` selectors. This avoids needing JS to toggle CSS classes on resize.

### 6. Mobile chat header placement
The mobile chat header (`#mobile-chat-header`) was initially outside `#app`, causing it to be covered by the chat pane. Moved inside `#app` so it renders above the chat content.

### 7. CSS `[hidden]` handling
The CSS explicitly sets `display: flex` on `.overlay` and `.app`, which overrides the HTML `hidden` attribute. Added `[hidden] { display: none !important; }` to fix this.

### 8. ESM script loading
Both `render.js` and `app.js` use `type="module"` so that `app.js` can `import` from `render.js`.

## Protocol → UI State Mapping

| ui.* message | UI effect |
|---|---|
| `ui.init {ok:true}` | Show app, hide login overlay |
| `ui.sessions` | Full refresh: devices, live sessions, history sessions → re-render home |
| `ui.session.recent` | On subscribe: clear chat, render all items as messages |
| `ui.event` | Render single item (user/assistant_delta/assistant_end/tool/state) |
| `ui.transcript` | Render full historical transcript |
| `ui.send.ack` | Clear send state, show error if `ok:false` |
| `ping` | Ignored (keepalive, no action needed) |

## Files Changed
- `remote/web/index.html` — SPA shell with login overlay, desktop layout (rail + list + chat), mobile header/chat header, settings panel
- `remote/web/styles.css` — Catppuccin Mocha CSS vars, desktop 3-pane layout, mobile responsive layout with `data-view` attribute control, message styling, composer styling
- `remote/web/render.js` — Pure functions: `escapeHtml`, `renderMessage` (fenced code, inline code, bold, links, line breaks), `timeAgo`, `groupHistory`
- `remote/web/app.js` — Event-sourced SPA: WS connection, token handling, home rendering, chat rendering, mobile/desktop view switching, session management, send/abort
- `remote/NOTES-web.md` — this file

## Verification
- `node --check` passes on both JS files ✓
- Mock server tested with agent-browser at mobile (390x844) and desktop (1280x800)
- Screenshots captured at both viewports showing: home view, chat view, mobile back navigation, send functionality, historical session view
- Known issues: agent-browser viewport testing required `agent-browser set viewport` command due to daemon reuse

## Deviations from DESIGN.md
1. Desktop chat pane shows "Select a session to start chatting" empty state instead of being completely hidden
2. Settings panel shows server URL, connection status, and online/offline indicator (simple readout)
3. Tool items use ⚙ glyph (not ▶) as specified in DESIGN.md
4. No animated pulse dot on assistant messages (only on session list "running" state)
5. Stop button only visible on mobile (DESIGN.md says "on mobile also a stop/interrupt button")
