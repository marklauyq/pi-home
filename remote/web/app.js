/**
 * app.js — pi remote control SPA (vanilla JS, ESM).
 * Event-sourced from ui.* messages over WebSocket.
 */
import { escapeHtml, renderMessage, timeAgo, groupHistory } from './render.js';

// ── DOM refs ──────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const loginOverlay = $('#login-overlay');
const tokenInput = $('#token-input');
const tokenSubmit = $('#token-submit');
const loginError = $('#login-error');
const appEl = $('#app');
const rail = $('#rail');
const sessionList = $('#session-list');
const chatPane = $('#chat-pane');
const chatEmpty = $('#chat-empty');
const chatContent = $('#chat-content');
const chatHeader = $('#chat-header');
const chatTitleText = $('#chat-title-text');
const chatSubtitle = $('#chat-subtitle');
const offlineBanner = $('#offline-banner');
const readonlyHint = $('#readonly-hint');
const chatMessages = $('#chat-messages');
const genStatus = $('#gen-status');
const composer = $('#composer');
const composerInput = $('#composer-input');
const btnSend = $('#btn-send');
const btnStop = $('#btn-stop');
const btnHome = $('#btn-home');
const btnSettings = $('#btn-settings');
const btnBack = $('#btn-back');
const btnBackMobile = $('#btn-back-mobile');
const btnMore = $('#btn-more');
const btnMoreMobile = $('#btn-more-mobile');
const settingsPane = $('#settings-pane');
const settingUrl = $('#setting-url');
const settingStatus = $('#setting-status');
const settingConnected = $('#setting-connected');
const deviceListEl = $('#device-list');
const historyListEl = $('#history-list');
const mobileHeader = $('#mobile-header');
const mobileTitle = $('#mobile-title');
const mobileChatHeader = $('#mobile-chat-header');
const mobileChatTitleText = $('#mobile-chat-title-text');
const btnSettingsMobile = $('#btn-settings-mobile');
const settingsSheet = $('#settings-sheet');
const settingsSheetClose = $('#settings-sheet-close');
const settingUrlM = $('#setting-url-m');
const settingStatusM = $('#setting-status-m');
const settingConnectedM = $('#setting-connected-m');

// ── State ─────────────────────────────────────────────────────────────
let ws = null;
let token = '';
let devices = new Map();          // id → {id, name, host, connected}
let liveSessions = new Map();     // sessionKey → {sessionKey, sessionId, device, cwd, model, state, startedAt}
let historySessions = [];         // [{sessionKey, file, device, updatedAt, lastUserText, model, cwd, messageCount}]
let currentSession = null;        // {sessionKey, isLive}
let messages = [];                // ordered array of rendered msg elements
let deltaAccum = new Map();       // messageId → accumulated raw text
let assistantEls = new Map();     // messageId → DOM element (separate from text accumulation)
let backfill = null; // { at: number, messageIds: Set, texts: Set } — dedupe window for post-backfill flushed events
let wasConnected = false;         // track if we were previously connected (for reconnect)
let reconnectDelay = 2000;        // exponential backoff start (ms)
const RECONNECT_MAX = 30000;      // exponential backoff max (ms)
let reconnectTimer = null;        // current reconnect timer
let isHistorical = false;
let isDeviceOffline = false;
let isRunning = false;
let lastDeltaAt = 0;            // ts of last assistant_delta — typing vs thinking
let wsConnected = false;
let pendingSend = false;
let lastSent = null;               // { text, at } — dedupes the device echo of our own optimistic bubble

// ── Token extraction / caching ──────────────────────────────────────
function getTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || null;
}

// Cache the token so a page refresh doesn't ask for it again.
// Cleared the moment the server rejects it (4001 / rotated token).
const TOKEN_STORAGE_KEY = 'piRemoteToken';
function cacheToken(t) {
  if (!t) return;
  try { localStorage.setItem(TOKEN_STORAGE_KEY, t); } catch { /* private mode etc. */ }
}
function readCachedToken() {
  try { return localStorage.getItem(TOKEN_STORAGE_KEY) || null; } catch { return null; }
}
function clearCachedToken() {
  try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch { /* ignore */ }
}

// ── WebSocket ─────────────────────────────────────────────────────────
function connect(tokenVal) {
  token = tokenVal;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ui?token=${encodeURIComponent(token)}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    // Socket is open with a token the server accepted — cache it.
    cacheToken(token);
    if (wasConnected) {
      // Re-connected after a disconnect — re-subscribe if we have a live session
      if (currentSession && currentSession.isLive) {
        send({ type: 'ui.subscribe', sessionKey: currentSession.sessionKey });
      }
      wasConnected = false;
    }
    wsConnected = true;
    updateSettings();
    // Set initial view
    appEl.dataset.view = 'home';
    // Show mobile header, hide mobile chat header
    mobileHeader.hidden = false;
    mobileChatHeader.hidden = true;
    // Clear reconnecting hint
    if (composerInput) composerInput.placeholder = 'Message…';
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    } catch (err) {
      console.error('parse error', err);
    }
  };

  ws.onclose = (ev) => {
    // 4001 = the token was rejected (bad, or rotated server-side).
    // Drop the cached token, force the login screen, do NOT reconnect:
    // retrying with a rotated-out token would loop forever.
    if (ev && ev.code === 4001) {
      clearCachedToken();
      token = '';
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectDelay = 2000;
      wasConnected = false;
      wsConnected = false;
      updateSettings();
      loginError.textContent = 'Token rejected by server (rotated?) — enter the new token.';
      loginOverlay.hidden = false;
      tokenInput.focus();
      return;
    }
    wasConnected = true;
    wsConnected = false;
    updateSettings();
    // Show reconnecting hint
    if (composerInput) composerInput.placeholder = 'Reconnecting…';
    // Cancel any pending reconnect
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Reconnect with exponential backoff
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (token) connect(token);
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
    // Reset send state
    pendingSend = false;
    composerInput.disabled = false;
  };

  ws.onerror = () => {
    console.error('ws error');
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    // Socket not open — show offline hint
    if (composerInput) composerInput.placeholder = 'Disconnected';
    if (msg.type === 'ui.send' || msg.type === 'ui.abort') {
      if (currentSession && currentSession.isLive) {
        const devId = currentSession.sessionKey.split('~')[0];
        const dev = devices.get(devId);
        if (!dev || !dev.connected) {
          showError('Device offline — send dropped');
          return;
        }
      }
      showError('Not connected — send dropped');
    }
  }
}

// ── Message handler ───────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type || msg) {
    case 'ui.init':
      if (msg.ok) {
        loginOverlay.hidden = true;
        appEl.hidden = false;
        // Hide mobile header by default
        mobileHeader.hidden = true;
        mobileChatHeader.hidden = true;
      } else {
        loginError.textContent = msg.error || 'Connection failed';
      }
      break;

    case 'ui.error': {
      // Read code first, fall back to error message
      const code = msg.code || '';
      const errorMsg = msg.error || (code ? `Error: ${code}` : 'Connection error');
      // Auth-type codes: show login overlay, cancel reconnects
      const authCodes = ['bad_token', 'unauthorized', 'token_required', 'invalid_token'];
      if (authCodes.includes(code)) {
        clearCachedToken();
        loginOverlay.hidden = false;
        loginError.textContent = errorMsg;
        token = '';  // Cancel reconnects
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        reconnectDelay = 2000;  // Reset backoff
      } else {
        // Non-auth errors: just show the error text, keep reconnecting
        loginError.textContent = errorMsg;
        reconnectDelay = 2000;  // Reset backoff for transient errors
      }
      break;
    }

    case 'ui.sessions':
      // Full refresh of devices, live, history
      if (msg.devices) {
        msg.devices.forEach(d => devices.set(d.id, d));
      }
      if (msg.live) {
        liveSessions = new Map();
        msg.live.forEach(s => {
          const dev = resolveDevice(s.device, s.deviceId);
          liveSessions.set(s.sessionKey, { ...s, device: dev, deviceId: s.deviceId });
        });
      }
      if (msg.history) {
        historySessions = msg.history.map(s => {
          const dev = resolveDevice(s.device, s.deviceId);
          return { ...s, device: dev, deviceId: s.deviceId };
        });
      }
      // Only re-render home if we're on the home view
      if (!currentSession) {
        renderHome();
      } else {
        // In chat view: just update device status (shows offline banner)
        updateDeviceStatus(currentSession.sessionKey);
      }
      break;

    case 'ui.session.recent':
      // Replay of recent items on subscribe
      renderRecent(msg.sessionKey, msg.items);
      backfill = buildBackfillWindow(msg.items || []);
      break;

    case 'ui.event':
      // Single live event for current session
      if (currentSession && msg.sessionKey === currentSession.sessionKey) {
        renderEvent(msg.item);
      }
      break;

    case 'ui.transcript':
      // Transcript backfill (live-session history or historical session file)
      if (currentSession && msg.sessionKey === currentSession.sessionKey) {
        // Empty transcript = file not available (fresh session not flushed yet);
        // keep whatever the ring buffer rendered instead of wiping it.
        if (!msg.items || msg.items.length === 0) break;
        // Arm the backfill dedupe window from the received items so the
        // server's post-transcript flush of buffered live events is suppressed.
        backfill = buildBackfillWindow(msg.items);
        // The transcript items themselves are authoritative and must render —
        // renderTranscript bypasses the window for its own items.
        renderTranscript(msg.items);
      }
      break;

    case 'ui.send.ack':
      // Gate on current session before resetting send state
      if (msg.sessionKey === currentSession?.sessionKey) {
        pendingSend = false;
        if (!msg.ok) {
          showError(msg.error || 'Send failed');
        }
        composerInput.disabled = false;
      }
      break;

    case 'ping':
      // Keepalive — reply pong so the server's pong-timeout doesn't drop us
      send({ type: 'pong', t: msg.t });
      break;
  }
}

// ── Rendering: Home ───────────────────────────────────────────────────
function renderHome() {
  // Hide chat, show home
  chatPane.hidden = true;
  chatContent.hidden = true;
  chatEmpty.hidden = false;
  settingsPane.hidden = true;
  settingsSheet.hidden = true;
  mobileHeader.hidden = false;
  mobileChatHeader.hidden = true;
  rail.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
  btnHome.classList.add('active');
  appEl.dataset.view = 'home';

  // Render devices
  let deviceHTML = '';
  const connectedDevices = [];
  const disconnectedDevices = [];
  devices.forEach(d => {
    if (d.connected) connectedDevices.push(d);
    else disconnectedDevices.push(d);
  });

  if (connectedDevices.length > 0) {
    deviceHTML += '<div class="section-label">Connected</div>';
    connectedDevices.forEach(d => {
      deviceHTML += `<div class="device-item">
        <span class="device-dot connected"></span>
        <span>${escapeHtml(d.name || d.id)}</span>
      </div>`;
    });
  }

  if (disconnectedDevices.length > 0) {
    deviceHTML += '<div class="section-label">Disconnected</div>';
    disconnectedDevices.forEach(d => {
      deviceHTML += `<div class="device-item">
        <span class="device-dot disconnected"></span>
        <span>${escapeHtml(d.name || d.id)}</span>
      </div>`;
    });
  }
  deviceListEl.innerHTML = deviceHTML;

  // Render live sessions — running pinned to the top, then by start time desc
  let liveHTML = '';
  const liveArr = [...liveSessions.values()].sort((a, b) => {
    const aRun = a.state === 'running' ? 1 : 0;
    const bRun = b.state === 'running' ? 1 : 0;
    if (aRun !== bRun) return bRun - aRun;
    return (b.startedAt || 0) - (a.startedAt || 0);
  });
  if (liveArr.length > 0) {
    liveHTML += '<div class="section-label">Live</div>';
    liveArr.forEach(s => {
      liveHTML += renderSessionCard(s, true);
    });
  }

  // Render history
  let historyHTML = '';
  if (historySessions.length > 0) {
    const groups = groupHistory(historySessions);
    groups.forEach(g => {
      historyHTML += `<div class="history-group">
        <div class="history-group-label">${g.label}</div>
        ${g.sessions.map(s => renderHistoryCard(s)).join('')}
      </div>`;
    });
  }

  historyListEl.innerHTML = liveHTML + historyHTML;
}

function renderSessionCard(s, isLive) {
  const dev = s.device || {};
  const devName = dev.name || dev.id || '';
  const sessionKey = s.sessionKey;
  const isActive = currentSession && currentSession.sessionKey === sessionKey;

  // Title: first user message text, or label, or sessionId
  let title = s.label || '';
  if (!title && s.items) {
    // items from ui.sessions might not have items
  }
  if (!title) title = s.sessionId ? s.sessionId.substring(0, 20) : 'Session';

  let stateHTML = '';
  if (isLive) {
    if (s.state === 'running') {
      stateHTML = '<span class="session-card-state">● running</span>';
    }
  }

  let previewHTML = '';
  if (s.cwd) {
    previewHTML = `<div class="session-card-cwd">${escapeHtml(s.cwd)}</div>`;
  }

  return `<div class="session-card ${isActive ? 'active' : ''}" data-key="${escapeHtml(sessionKey)}" data-live="true" tabindex="0" role="button">
    <div class="session-card-icon">⌨</div>
    <div class="session-card-body">
      <div class="session-card-title">${escapeHtml(title)}</div>
      ${devName ? `<div class="session-card-subtitle">${escapeHtml(devName)}</div>` : ''}
      ${stateHTML}
      ${previewHTML}
    </div>
    <div class="session-card-time">${timeAgo(s.startedAt)}</div>
  </div>`;
}

function renderHistoryCard(s) {
  const dev = s.device || {};
  const devName = dev.name || dev.id || '';
  const sessionKey = s.sessionKey;
  const isActive = currentSession && currentSession.sessionKey === sessionKey;

  let title = s.lastUserText || 'Session';
  if (title.length > 50) title = title.substring(0, 50) + '…';

  let previewHTML = '';
  if (s.lastUserText) {
    previewHTML = `<div class="session-card-preview">${escapeHtml(s.lastUserText)}</div>`;
  }

  return `<div class="session-card ${isActive ? 'active' : ''}" data-key="${escapeHtml(sessionKey)}" data-live="false" tabindex="0" role="button">
    <div class="session-card-icon">📄</div>
    <div class="session-card-body">
      <div class="session-card-title">${escapeHtml(title)}</div>
      ${devName ? `<div class="session-card-meta"><span>${escapeHtml(devName)}</span></div>` : ''}
      ${previewHTML}
      <div class="session-card-cwd">${timeAgo(s.updatedAt)}</div>
    </div>
  </div>`;
}

// ── Rendering: Chat ───────────────────────────────────────────────────
function openSession(sessionKey, isLive) {
  // Unsubscribe from previous live session if switching
  if (currentSession && currentSession.isLive && currentSession.sessionKey !== sessionKey) {
    send({ type: 'ui.unsubscribe', sessionKey: currentSession.sessionKey });
  }
  currentSession = { sessionKey, isLive };
  isHistorical = !isLive;
  isDeviceOffline = false;
  isRunning = false;
  lastDeltaAt = 0;
  deltaAccum.clear();
  assistantEls.clear();
  backfill = null;
  lastSent = null;
  messages = [];
  chatMessages.innerHTML = '';

  // Subscribe
  if (isLive) {
    send({ type: 'ui.subscribe', sessionKey });
    // Also request full transcript from device (backfill)
    send({ type: 'ui.transcript.request', sessionKey });
  } else {
    send({ type: 'ui.transcript.request', sessionKey });
  }

  // Show chat view
  chatPane.hidden = false;
  chatEmpty.hidden = true;
  chatContent.hidden = false;
  settingsPane.hidden = true;
  settingsSheet.hidden = true;
  mobileHeader.hidden = true;
  mobileChatHeader.hidden = false;
  appEl.dataset.view = 'chat';

  // Show mobile header in mobile view
  if (window.innerWidth < 820) {
    mobileHeader.hidden = true;
  }

  // Set title
  const session = liveSessions.get(sessionKey);
  let title = '';
  if (session) {
    title = session.label || session.sessionId?.substring(0, 30) || sessionKey;
  } else {
    // Historical — try to find in historySessions
    const hist = historySessions.find(s => s.sessionKey === sessionKey);
    if (hist) {
      title = hist.lastUserText?.substring(0, 40) || hist.file?.split('/').pop() || sessionKey;
    } else {
      title = sessionKey;
    }
  }
  chatTitleText.textContent = title;
  mobileChatTitleText.textContent = title;

  // Show/hide UI elements based on mode
  readonlyHint.hidden = !isHistorical;
  composer.hidden = isHistorical;

  // Check if device is online
  updateDeviceStatus(sessionKey);
}

function closeSession() {
  if (currentSession && currentSession.isLive) {
    send({ type: 'ui.unsubscribe', sessionKey: currentSession.sessionKey });
  }
  currentSession = null;
  isHistorical = false;
  isDeviceOffline = false;
  isRunning = false;
  lastDeltaAt = 0;
  deltaAccum.clear();
  messages = [];
  chatMessages.innerHTML = '';
  chatContent.hidden = true;
  chatEmpty.hidden = false;
  settingsSheet.hidden = true;
  closeSessionMenu();
  composerInput.value = '';
  composerInput.disabled = false;
  btnStop.hidden = true;
  offlineBanner.hidden = true;
  readonlyHint.hidden = true;
  appEl.dataset.view = 'home';
  mobileHeader.hidden = false;
  mobileChatHeader.hidden = true;
}

function updateDeviceStatus(sessionKey) {
  // Check if device for this session is connected
  const parts = sessionKey.split('~');
  const deviceId = parts[0];
  const dev = devices.get(deviceId);
  isDeviceOffline = !dev || !dev.connected;
  offlineBanner.hidden = !isDeviceOffline;
  // Disable composer for offline live sessions
  if (composerInput && currentSession && currentSession.isLive) {
    composerInput.disabled = isDeviceOffline;
  }
  updateGenStatus();
}

// Build the backfill dedupe window from transcript/backfill items. Scoped to a
// short window (see renderEvent) so later live deltas of the same messageId and
// legitimately repeated user/tool text are NOT suppressed.
function buildBackfillWindow(items) {
  return {
    at: Date.now(),
    messageIds: new Set(items.filter(i => i.messageId).map(i => i.messageId)),
    texts: new Set(items.filter(i => i.type === 'user' || i.type === 'tool').map(i => i.text)),
  };
}

function renderRecent(sessionKey, items) {
  if (sessionKey !== currentSession?.sessionKey) return;
  deltaAccum.clear();
  messages = [];
  chatMessages.innerHTML = '';

  for (const item of items) {
    renderEvent(item);
  }
  scrollToBottom();
}

function renderEvent(item) {
  // DOM growth cap: remove oldest elements when exceeding limit
  if (messages.length >= 500) {
    for (let i = 0; i < 200; i++) {
      const oldEl = messages.shift();
      if (oldEl && oldEl.parentNode) oldEl.parentNode.removeChild(oldEl);
    }
  }
  // Backfill-window dedupe: only suppress items that the just-received transcript
  // already contained (they may also arrive via the server's post-transcript flush).
  // Window is short so later live deltas of the SAME messageId stream normally.
  if (backfill && Date.now() - backfill.at < 10000) {
    if (item.messageId && backfill.messageIds.has(item.messageId)) return;
    if ((item.type === 'user' || item.type === 'tool') && backfill.texts.has(item.text)) return;
  }

  switch (item.type) {
    case 'user': {
      // Skip the device echo of a message we already rendered optimistically
      if (lastSent && item.text === lastSent.text && Date.now() - lastSent.at < 30000) break;
      const el = document.createElement('div');
      el.className = 'msg-user';
      el.textContent = item.text;
      chatMessages.appendChild(el);
      messages.push(el);
      scrollToBottom();
      break;
    }
    case 'assistant_delta': {
      // Accumulate raw text, store DOM element separately
      lastDeltaAt = Date.now();
      updateGenStatus();
      const raw = (deltaAccum.get(item.messageId) || '') + item.text;
      deltaAccum.set(item.messageId, raw);
      let el = assistantEls.get(item.messageId);
      if (!el) {
        el = document.createElement('div');
        el.className = 'msg-assistant';
        chatMessages.appendChild(el);
        assistantEls.set(item.messageId, el);
        messages.push(el);
      }
      el.innerHTML = renderMessage(raw);
      scrollToBottom();
      break;
    }
    case 'assistant_end': {
      const accumulated = deltaAccum.get(item.messageId);
      let el = assistantEls.get(item.messageId);
      const finalText = item.text || accumulated || '';
      if (finalText) {
        if (el) {
          el.innerHTML = renderMessage(finalText);
        } else {
          el = document.createElement('div');
          el.className = 'msg-assistant';
          el.innerHTML = renderMessage(finalText);
          chatMessages.appendChild(el);
          messages.push(el);
        }
      }
      // Always clean up, even without final text (prevent id-reuse merging)
      deltaAccum.delete(item.messageId);
      assistantEls.delete(item.messageId);
      scrollToBottom();
      break;
    }
    case 'tool': {
      const el = document.createElement('div');
      el.className = 'msg-tool';
      el.textContent = item.text;
      chatMessages.appendChild(el);
      messages.push(el);
      scrollToBottom();
      break;
    }
    case 'state': {
      isRunning = item.running;
      updateRunningState();
      updateGenStatus();
      break;
    }
  }
}

function renderTranscript(items) {
  deltaAccum.clear();
  messages = [];
  chatMessages.innerHTML = '';

  // Transcript items are authoritative — render them without backfill dedupe;
  // the window only suppresses the server's post-transcript flush of duplicates.
  const savedBackfill = backfill;
  backfill = null;
  try {
    for (const item of items) {
      renderEvent(item);
    }
  } finally {
    backfill = savedBackfill;
  }
  scrollToBottom();
}

function updateRunningState() {
  btnStop.hidden = !isRunning || isHistorical;
}

// "thinking… / typing…" indicator above the chat box.
// thinking: turn in progress, no recent text streaming
// typing:   assistant text actively streaming (delta within 3s)
function updateGenStatus() {
  if (!genStatus) return;
  if (!isRunning || isHistorical || isDeviceOffline) {
    genStatus.hidden = true;
    return;
  }
  genStatus.hidden = false;
  const mode = Date.now() - lastDeltaAt < 3000 ? 'typing' : 'thinking';
  if (genStatus.dataset.mode !== mode) {
    genStatus.dataset.mode = mode;
    genStatus.innerHTML = `<span class="gen-dot"></span>${mode}…`;
  }
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
}

function showError(msg) {
  // Show inline error in composer area
  const el = document.createElement('div');
  el.className = 'error-text';
  el.textContent = msg;
  composer.parentNode.insertBefore(el, composer);
  setTimeout(() => el.remove(), 4000);
}

// ── Send / Abort ──────────────────────────────────────────────────────
// The server sends `device` as the raw device-id string; resolve it to the
// full device object so card rendering can use dev.name / dev.host.
function resolveDevice(dev, deviceId) {
  if (dev && typeof dev === 'object') return dev;
  const id = (typeof dev === 'string' && dev) || deviceId;
  return id ? devices.get(id) || { id } : {};
}

function sendMessage() {
  const text = composerInput.value.trim();
  if (!text || pendingSend) return;
  // Check device online for live sessions
  if (currentSession && currentSession.isLive) {
    const devId = currentSession.sessionKey.split('~')[0];
    const dev = devices.get(devId);
    if (!dev || !dev.connected) {
      showError('Device offline — send dropped');
      return;
    }
  }
  pendingSend = true;
  composerInput.disabled = true;
  send({ type: 'ui.send', sessionKey: currentSession.sessionKey, text });
  composerInput.value = '';
  // Optimistic render: show the user's own bubble immediately; the device's
  // echoed `user` event (which arrives when the session processes it) is
  // deduped via lastSent so it doesn't render a second bubble. Record
  // lastSent AFTER rendering so this call isn't deduped by itself.
  renderEvent({ type: 'user', text });
  lastSent = { text, at: Date.now() };
}

function sendAbort() {
  if (!currentSession) return;
  send({ type: 'ui.abort', sessionKey: currentSession.sessionKey });
  isRunning = false;
  updateRunningState();
}

// ── Settings ──────────────────────────────────────────────────────────
function updateSettings() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ui`;
  const status = wsConnected ? 'Connected' : 'Disconnected';
  const connected = wsConnected ? '● Online' : '● Offline';
  settingUrl.textContent = url;
  settingStatus.textContent = status;
  settingConnected.textContent = connected;
  settingConnected.className = wsConnected ? 'conn-status' : '';
  settingUrlM.textContent = url;
  settingStatusM.textContent = status;
  settingConnectedM.textContent = connected;
  settingConnectedM.className = wsConnected ? 'conn-status' : '';
}

// ── Event listeners ───────────────────────────────────────────────────
// Login
tokenSubmit.addEventListener('click', handleLogin);
tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLogin();
});

function handleLogin() {
  const t = tokenInput.value.trim();
  if (!t) {
    loginError.textContent = 'Token required';
    return;
  }
  loginError.textContent = '';
  connect(t);
}

// Try URL token first, then the cached token, then the login screen
const urlToken = getTokenFromUrl();
if (urlToken) {
  connect(urlToken);
} else {
  const storedToken = readCachedToken();
  if (storedToken) {
    connect(storedToken);
  } else {
    // Show login overlay
    loginOverlay.hidden = false;
    tokenInput.focus();
  }
}

// Home button
btnHome.addEventListener('click', () => {
  closeSession();
  settingsPane.hidden = true;
  rail.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
  btnHome.classList.add('active');
});

// Settings button (desktop rail)
btnSettings.addEventListener('click', () => {
  settingsPane.hidden = !settingsPane.hidden;
  btnSettings.classList.toggle('active', !settingsPane.hidden);
  btnHome.classList.toggle('active', settingsPane.hidden);
  if (!settingsPane.hidden) {
    updateSettings();
  }
});

// Settings button (mobile header) — the desktop settings pane is
// display:none on mobile, so the mobile gear opens the settings sheet.
btnSettingsMobile.addEventListener('click', () => {
  settingsSheet.hidden = !settingsSheet.hidden;
  rail.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
  if (settingsSheet.hidden) {
    btnHome.classList.add('active');
  } else {
    updateSettings();
  }
});
settingsSheetClose.addEventListener('click', () => {
  settingsSheet.hidden = true;
  btnHome.classList.add('active');
});

// Back button (desktop)
btnBack.addEventListener('click', () => {
  closeSession();
});

// Back button (mobile)
btnBackMobile.addEventListener('click', () => {
  closeSession();
});

// More buttons (session menu)
function closeSessionMenu() {
  const m = document.querySelector('.session-menu');
  if (m) m.remove();
}
function showSessionMenu(anchor) {
  closeSessionMenu();
  if (!currentSession) return;
  const menu = document.createElement('div');
  menu.className = 'session-menu';
  const items = [];
  if (isRunning) {
    items.push({ label: 'Stop generating', danger: true, fn: () => sendAbort() });
  }
  items.push({
    label: 'Copy session ID',
    fn: () => { navigator.clipboard?.writeText(currentSession.sessionId); },
  });
  items.push({ label: 'Back to sessions', fn: () => closeSession() });
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'session-menu-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', () => { closeSessionMenu(); it.fn(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = r.right - mw;
  let top = r.bottom + 6;
  if (left < 8) left = 8;
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}
btnMore.addEventListener('click', (e) => { e.stopPropagation(); showSessionMenu(btnMore); });
btnMoreMobile.addEventListener('click', (e) => { e.stopPropagation(); showSessionMenu(btnMoreMobile); });
document.addEventListener('click', (e) => {
  if (!e.target.closest('.session-menu') && !e.target.closest('.btn-more') && !e.target.closest('.btn-more-mobile')) closeSessionMenu();
});
window.addEventListener('resize', closeSessionMenu);

// Composer
btnSend.addEventListener('click', sendMessage);
btnStop.addEventListener('click', sendAbort);
composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Session list click delegation
sessionList.addEventListener('click', (e) => {
  const card = e.target.closest('.session-card');
  if (!card) return;
  const sessionKey = card.dataset.key;
  const isLive = card.dataset.live === 'true';
  if (sessionKey && currentSession?.sessionKey !== sessionKey) {
    openSession(sessionKey, isLive);
  }
});

// Session list keyboard activation (Enter/Space)
sessionList.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const card = e.target.closest('.session-card');
    if (!card) return;
    const sessionKey = card.dataset.key;
    const isLive = card.dataset.live === 'true';
    if (sessionKey && currentSession?.sessionKey !== sessionKey) {
      openSession(sessionKey, isLive);
    }
  }
});

// Resize handler for mobile/desktop layout
function handleResize() {
  // On desktop, hide mobile elements
  if (window.innerWidth >= 820) {
    mobileHeader.hidden = true;
    mobileChatHeader.hidden = true;
  }
}
window.addEventListener('resize', handleResize);
handleResize();
