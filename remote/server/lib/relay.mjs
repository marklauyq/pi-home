/**
 * Relay: WebSocket plumbing for device sockets (/ws) and browser sockets (/ui).
 * Routes messages between them, manages ping/pong keepalive.
 */

import { WebSocketServer } from 'ws';
import { timingSafeEqual } from 'node:crypto';

// Keepalive constants. IMPORTANT: PONG_TIMEOUT must be greater than
// PING_INTERVAL, or the timeout fires before the next ping/pong round
// completes and every healthy peer gets 4002'd ~20s after connecting.
// 45s timeout with 15s pings tolerates a missed round before dropping.
const PING_INTERVAL = 15000; // 15 seconds
const PONG_TIMEOUT = 45000; // 45 seconds
const CLOSE_BAD_TOKEN = 4001;

/**
 * Timing-safe compare of two strings.
 */
export function safeCompare(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  return timingSafeEqual(bufA, bufB);
}

/**
 * Parse query parameters from a URL string.
 */
export function parseQuery(urlStr) {
  const q = urlStr.split('?')[1];
  if (!q) return {};
  const params = {};
  for (const pair of q.split('&')) {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return params;
}

// ── Socket registries ──────────────────────────────────────────────────────────────────────

/** deviceId → Set<WebSocket> (device clients).
 * A host runs many pi sessions that all share the hostname as device id, so
 * one device id maps to MANY sockets. The device is only offline when the
 * LAST socket for it closes.
 */
const deviceSockets = new Map();

/** sessionKey → WebSocket that registered the session (for precise UI→device routing). */
const sessionSockets = new Map();

/** Browser WebSocket → { sessionKey } if subscribed */
const browserSubscriptions = new Map(); // ws → Set<sessionKey>

// ── Backfill buffering ─────────────────────────────────────────────────────────────────────
// Map<browserWs, Map<sessionKey, { items: [], timer: null }>>
// Used to buffer live events while waiting for a transcript backfill,
// then flush them after the transcript so the browser sees
// full history first, then live events — without duplicates.
const pendingBackfills = new Map(); // ws → Map<sessionKey, { items: [], timer: null }>

function getPendingBackfill(ws, sessionKey) {
  if (!pendingBackfills.has(ws)) return undefined;
  return pendingBackfills.get(ws).get(sessionKey);
}

function setPendingBackfill(ws, sessionKey, data) {
  if (!pendingBackfills.has(ws)) {
    pendingBackfills.set(ws, new Map());
  }
  pendingBackfills.get(ws).set(sessionKey, data);
}

function clearPendingBackfill(ws, sessionKey) {
  const wsMap = pendingBackfills.get(ws);
  if (wsMap) {
    wsMap.delete(sessionKey);
    if (wsMap.size === 0) pendingBackfills.delete(ws);
  }
}

function flushPendingBackfill(ws, sessionKey) {
  const bf = getPendingBackfill(ws, sessionKey);
  if (bf) {
    // Clear timeout
    if (bf.timer) clearTimeout(bf.timer);
    // Send buffered items
    for (const item of bf.items) {
      send(ws, { type: 'ui.event', ...item });
    }
    // Clear pending state
    clearPendingBackfill(ws, sessionKey);
  }
}

// ── Public API ─────────────────────────────────────────────────────

/** Register a device WebSocket (refcounted — many sockets per device id). */
export function registerDeviceSocket(deviceId, ws) {
  let set = deviceSockets.get(deviceId);
  if (!set) {
    set = new Set();
    deviceSockets.set(deviceId, set);
  }
  set.add(ws);
}

/** Remove a device socket; device is offline when the set drains. */
export function removeDeviceSocket(deviceId, ws) {
  const set = deviceSockets.get(deviceId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) deviceSockets.delete(deviceId);
}

export function hasDeviceSockets(deviceId) {
  const set = deviceSockets.get(deviceId);
  return !!set && set.size > 0;
}

/** Fallback routing target: any OPEN socket for the device. */
export function getDeviceSocket(deviceId) {
  const set = deviceSockets.get(deviceId);
  if (!set) return null;
  for (const w of set) {
    if (w.readyState === 1) return w;
  }
  return null;
}

/** Precise routing target: the socket that registered this session. */
export function getSessionSocket(sessionKey) {
  return sessionSockets.get(sessionKey) ?? null;
}

function pickOpen(ws) {
  return ws && ws.readyState === 1 ? ws : null;
}

/** Register a browser WebSocket. */
export function registerBrowserSocket(ws) {
  browserSubscriptions.set(ws, new Set());
}

/** Unregister a browser WebSocket. */
export function unregisterBrowserSocket(ws) {
  browserSubscriptions.delete(ws);
}

/**
 * Send a JSON message over a WebSocket.
 * Waits for the socket to be ready before sending.
 */
export function send(ws, obj) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (_e) {}
  } else if (ws.readyState === 0) {
    ws.once('open', () => {
      try { ws.send(JSON.stringify(obj)); } catch (_e) {}
    });
  }
}

// ── Relay helpers ──────────────────────────────────────────────────

/**
 * Relay a message to all browsers subscribed to a session key.
 * If a browser has a pending backfill for this sessionKey, buffer
 * the event instead of sending — it will be flushed after the
 * transcript arrives (so the browser sees full history first).
 */
function relayToSubscribers(sessionKey, type, payload) {
  for (const [ws, subs] of browserSubscriptions) {
    if (subs.has(sessionKey)) {
      // Check if this browser+session pair has a pending backfill
      const bf = getPendingBackfill(ws, sessionKey);
      if (bf) {
        // Buffer the event instead of sending
        bf.items.push({ type, ...payload });
      } else {
        send(ws, { type, ...payload });
      }
    }
  }
}

/**
 * Broadcast a message to all connected browsers.
 */
export function broadcastToAllBrowsers(type, payload) {
  for (const [ws] of browserSubscriptions) {
    send(ws, { type, ...payload });
  }
}

/**
 * Get the browser subscriptions Map (for external tracking).
 */
export function getBrowserSubscriptions() {
  return browserSubscriptions;
}

// ── Connection handlers ────────────────────────────────────────────

/**
 * Handle a device WebSocket connection (after hello is received).
 * Sets up ping/pong keepalive and message routing.
 * Returns a resetPongTimeout callback for application-level pong handling.
 */
export function handleDeviceConnection(ws, deviceInfo, registry) {
  // Already registered by server.mjs via registerDeviceSocket()

  // Track pong timeout
  let pongTimeoutTimer = null;

  const clearPongTimeout = () => {
    if (pongTimeoutTimer) {
      clearTimeout(pongTimeoutTimer);
      pongTimeoutTimer = null;
    }
  };

  const resetPongTimeout = () => {
    clearPongTimeout();
    pongTimeoutTimer = setTimeout(() => {
      if (ws.readyState === 1) {
        ws.close(4002, 'Pong timeout');
      }
    }, PONG_TIMEOUT);
    pongTimeoutTimer.unref?.();
  };

  resetPongTimeout();

  // Start ping keepalive — first ping immediately so the initial
  // pong-timeout window (20s) can't expire before the first 30s tick.
  const pingNow = () => {
    if (ws.readyState === 1) send(ws, { type: 'ping', t: Date.now() });
  };
  pingNow();
  const pingTimer = setInterval(() => {
    if (ws.readyState !== 1) {
      clearInterval(pingTimer);
      return;
    }
    pingNow();
  }, PING_INTERVAL);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Issue 18: honor application-level pong (reset pong timer)
      if (msg.type === 'pong') {
        resetPongTimeout();
        return;
      }
      handleDeviceMessage(msg, deviceInfo, registry, ws);
    } catch (_e) {
      // Ignore malformed JSON
    }
  });

  ws.on('pong', () => {
    resetPongTimeout();
  });

  ws.on('close', () => {
    // Per-socket cleanup (timers live in this closure). The socket map is
    // refcounted: the device only goes offline when the LAST socket closes,
    // which server.mjs's close handler detects via hasDeviceSockets().
    clearInterval(pingTimer);
    clearPongTimeout();
    removeDeviceSocket(deviceInfo.id, ws);
  });
}

/**
 * Handle a browser WebSocket connection.
 * Called from the server after token validation.
 * Issue 20: adds pong-timeout drop for browser sockets.
 */
export function handleBrowserConnection(ws, registry) {
  registerBrowserSocket(ws);

  // Send ui.init first, then ui.sessions
  send(ws, { type: 'ui.init', ok: true });
  send(ws, { type: 'ui.sessions', ...registry.buildSessionsPayload() });

  // Issue 20: pong timeout for browser sockets (mirror device pattern)
  let browserPongTimeoutTimer = null;
  const clearBrowserPongTimeout = () => {
    if (browserPongTimeoutTimer) {
      clearTimeout(browserPongTimeoutTimer);
      browserPongTimeoutTimer = null;
    }
  };
  const resetBrowserPongTimeout = () => {
    clearBrowserPongTimeout();
    browserPongTimeoutTimer = setTimeout(() => {
      if (ws.readyState === 1) {
        ws.close(4002, 'Pong timeout');
      }
    }, PONG_TIMEOUT);
    browserPongTimeoutTimer.unref?.();
  };
  resetBrowserPongTimeout();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleBrowserMessage(msg, ws, registry);
      // Issue 20: reset pong timeout on any valid message from browser
      resetBrowserPongTimeout();
    } catch (_e) {
      // Ignore malformed JSON
    }
  });

  ws.on('close', () => {
    clearInterval(browserPingTimer);
    clearBrowserPongTimeout();
    unregisterBrowserSocket(ws);
  });

  // Ping keepalive for browser — first ping immediately (same 20s/30s window issue)
  const browserPingNow = () => {
    if (ws.readyState === 1) send(ws, { type: 'ping', t: Date.now() });
  };
  browserPingNow();
  const browserPingTimer = setInterval(() => {
    if (ws.readyState !== 1) {
      clearInterval(browserPingTimer);
      return;
    }
    browserPingNow();
  }, PING_INTERVAL);
}

// ── Device message routing ─────────────────────────────────────────

/**
 * Route a message from a device.
 */
export function handleDeviceMessage(msg, deviceInfo, registry, ws) {
  const { id: deviceId } = deviceInfo;

  if (msg.type === "hello") {
    // Re-hello is owned by server.mjs's deviceConnect handler — ignore here
    // (this listener only runs after the first hello succeeded).
  } else if (msg.type === "session.register") {
    const sessionKey = `${deviceId}~${msg.sessionId}`;
    registry.registerSession(sessionKey, {
      sessionId: msg.sessionId,
      deviceId,
      cwd: msg.cwd,
      model: msg.model,
      state: 'idle',
      startedAt: msg.startedAt,
    });
    if (ws) sessionSockets.set(sessionKey, ws); // precise UI→device routing
    broadcastToAllBrowsers('ui.sessions', registry.buildSessionsPayload());
  } else if (msg.type === 'session.unregister') {
    const sessionKey = `${deviceId}~${msg.sessionId}`;
    registry.unregisterSession(sessionKey);
    registry.unregisterHistory(sessionKey);
    sessionSockets.delete(sessionKey);
    broadcastToAllBrowsers('ui.sessions', registry.buildSessionsPayload());
  } else if (msg.type === 'sessions.history') {
    if (msg.sessions) {
      // Issue 7: replace-per-device — delete old history for this device first
      for (const [key] of registry.historySessions) {
        if (key.startsWith(deviceId + '~f~')) {
          registry.unregisterHistory(key);
        }
      }
      for (const s of msg.sessions) {
        const sessionKey = `${deviceId}~f~${s.file.replace(/\.jsonl$/, '')}`;
        registry.registerHistory(sessionKey, {
          file: s.file,
          device: deviceId,
          updatedAt: s.updatedAt,
          lastUserText: s.lastUserText,
          model: s.model,
          cwd: s.cwd,
          messageCount: s.messageCount,
        });
      }
      broadcastToAllBrowsers('ui.sessions', registry.buildSessionsPayload());
    }
  } else if (msg.type === 'stream.assistant_delta') {
    const sessionKey = `${deviceId}~${msg.sessionId}`;
    const item = { type: 'assistant_delta', messageId: msg.messageId, text: msg.text };
    registry.pushEvent(sessionKey, item);
    relayToSubscribers(sessionKey, 'ui.event', { sessionKey, item });
  } else if (msg.type === 'stream.assistant_end') {
    const sessionKey = `${deviceId}~${msg.sessionId}`;
    const item = { type: 'assistant_end', messageId: msg.messageId, text: msg.text };
    registry.pushEvent(sessionKey, item);
    relayToSubscribers(sessionKey, 'ui.event', { sessionKey, item });
  } else if (msg.type === 'message.user') {
    const sessionKey = `${deviceId}~${msg.sessionId}`;
    const item = { type: 'user', text: msg.text };
    registry.pushEvent(sessionKey, item);
    relayToSubscribers(sessionKey, 'ui.event', { sessionKey, item });
  } else if (msg.type === 'tool.line') {
    const sessionKey = `${deviceId}~${msg.sessionId}`;
    const item = { type: 'tool', text: msg.text };
    registry.pushEvent(sessionKey, item);
    relayToSubscribers(sessionKey, 'ui.event', { sessionKey, item });
  } else if (msg.type === 'state') {
    const sessionKey = `${deviceId}~${msg.sessionId}`;
    const item = { type: 'state', running: msg.running };
    registry.updateSessionState(sessionKey, msg.running ? 'running' : 'idle');
    registry.pushEvent(sessionKey, item);
    relayToSubscribers(sessionKey, 'ui.event', { sessionKey, item });
    broadcastToAllBrowsers('ui.sessions', registry.buildSessionsPayload());
  } else if (msg.type === 'transcript') {
    // Issue 4: device replies with sessionKey (not sessionId)
    // Flush any pending backfill for this sessionKey so the transcript
    // reaches the browser first, then buffered live events follow.
    for (const [browserWs, sessionMap] of pendingBackfills) {
      const bf = sessionMap.get(msg.sessionKey);
      if (bf) {
        // Send the transcript to this browser
        send(browserWs, { type: 'ui.transcript', sessionKey: msg.sessionKey, items: msg.items });
        // Flush buffered items after the transcript
        flushPendingBackfill(browserWs, msg.sessionKey);
      }
    }
  }
}

// ── Browser message routing ────────────────────────────────────────

/**
 * Route a message from a browser.
 */
function handleBrowserMessage(msg, browserWs, registry) {
  if (msg.type === 'ui.subscribe') {
    const subs = browserSubscriptions.get(browserWs);
    if (subs) {
      subs.add(msg.sessionKey);
      // Replay recent events
      const session = registry.getLiveSession(msg.sessionKey);
      if (session) {
        send(browserWs, {
          type: 'ui.session.recent',
          sessionKey: msg.sessionKey,
          items: session.ring.getAll(),
        });
      }
    }
  } else if (msg.type === 'ui.unsubscribe') {
    const subs = browserSubscriptions.get(browserWs);
    if (subs) {
      subs.delete(msg.sessionKey);
    }
  } else if (msg.type === 'ui.send') {
    const sessionKey = msg.sessionKey;
    // Check if session exists
    const session = registry.getLiveSession(sessionKey);
    if (!session) {
      send(browserWs, { type: 'ui.send.ack', sessionKey, ok: false, error: 'unknown_session' });
      return;
    }
    const deviceWs = pickOpen(getSessionSocket(sessionKey)) ?? getDeviceSocket(session.deviceId);
    if (deviceWs) {
      send(deviceWs, { type: 'cmd.message', sessionId: session.sessionId, text: msg.text });
      send(browserWs, { type: 'ui.send.ack', sessionKey, ok: true });
    } else {
      send(browserWs, { type: 'ui.send.ack', sessionKey, ok: false, error: 'device_offline' });
    }
  } else if (msg.type === 'ui.abort') {
    const sessionKey = msg.sessionKey;
    const session = registry.getLiveSession(sessionKey);
    if (!session) {
      send(browserWs, { type: 'ui.send.ack', sessionKey, ok: false, error: 'unknown_session' });
      return;
    }
    const deviceWs = pickOpen(getSessionSocket(sessionKey)) ?? getDeviceSocket(session.deviceId);
    if (deviceWs) {
      send(deviceWs, { type: 'cmd.abort', sessionId: session.sessionId });
      send(browserWs, { type: 'ui.send.ack', sessionKey, ok: true });
    } else {
      send(browserWs, { type: 'ui.send.ack', sessionKey, ok: false, error: 'device_offline' });
    }
  } else if (msg.type === 'ui.transcript.request') {
    const sessionKey = msg.sessionKey;
    // Check if it's a historical session (contains ~f~)
    if (sessionKey.includes('~f~')) {
      // Historical: extract deviceId and file
      const deviceId = sessionKey.split('~')[0];
      const file = sessionKey.slice(sessionKey.indexOf('~f~') + 3) + '.jsonl';
      const deviceWs = getDeviceSocket(deviceId);
      if (deviceWs) {
        // Subscribe this browser to the key so the device's `transcript` reply
        // (routed via relayToSubscribers) reaches it.
        const subs = browserSubscriptions.get(browserWs);
        if (subs) subs.add(sessionKey);
        // Issue 4: send sessionKey (not sessionId) so device echoes it back
        send(deviceWs, { type: 'req.transcript', sessionKey, file });
        send(browserWs, { type: 'ui.send.ack', sessionKey, ok: true });
      } else {
        send(browserWs, { type: 'ui.send.ack', sessionKey, ok: false, error: 'unknown_session' });
      }
    } else {
      // Live session — resolve the live session and request transcript from device.
      // Buffer live events while backfill is pending, then flush after transcript.
      const session = registry.getLiveSession(sessionKey);
      if (session) {
        const deviceId = session.deviceId;
        const sessionId = session.sessionId;
        const file = sessionId + '.jsonl';
        const deviceWs = pickOpen(getSessionSocket(sessionKey)) ?? getDeviceSocket(deviceId);
        if (deviceWs) {
          // Ensure browser is subscribed (it may already be from ui.subscribe)
          const subs = browserSubscriptions.get(browserWs);
          if (subs) subs.add(sessionKey);

          // Start pending backfill (buffer live events)
          if (!pendingBackfills.has(browserWs)) {
            pendingBackfills.set(browserWs, new Map());
          }
          const existing = pendingBackfills.get(browserWs).get(sessionKey);
          setPendingBackfill(browserWs, sessionKey, {
            items: existing?.items ?? [],
            timer: null,
          });

          // Send req.transcript to device (sessionKey + file: sessionId.jsonl)
          send(deviceWs, { type: 'req.transcript', sessionKey, file });

          // Ack ok to browser immediately
          send(browserWs, { type: 'ui.send.ack', sessionKey, ok: true });

          // 10s timeout: if device never replies, flush buffered items
          const timer = setTimeout(() => {
            flushPendingBackfill(browserWs, sessionKey);
          }, 10000);
          setPendingBackfill(browserWs, sessionKey, {
            items: pendingBackfills.get(browserWs).get(sessionKey).items,
            timer,
          });
        } else {
          send(browserWs, { type: 'ui.send.ack', sessionKey, ok: false, error: 'device_offline' });
        }
      } else {
        send(browserWs, { type: 'ui.send.ack', sessionKey, ok: false, error: 'unknown_session' });
      }
    }
  }
}