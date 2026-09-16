/**
 * Remote Control — Client. Phones home to a remote server over an outbound
 * WebSocket, relays live session events, accepts remote messages/abort, and
 * reports session history/transcripts. Gated on remoteControl.url in merged
 * settings (~/.pi/agent/settings.json + <cwd>/.pi/settings.json).
 * /remote on|off switches remote control for this whole machine (persisted
 * box-wide via remote/state/client.off, not just this session).
 * Server management (start/stop/config) lives in extensions/remote-server.ts
 * (/remote-server).
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
// Node 22+ has WebSocket as a global; no external imports needed.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Console output from an extension lands in pi's TUI footer/status area, where
// it crowds the chat box. Keep all client-side logging silent unless explicitly
// debugging with PI_REMOTE_DEBUG=1 (server-side logs live in remote/state/server.log).
const CONSOLE_DEBUG = process.env["PI_REMOTE_DEBUG"] === "1";
const dbg = (...args: unknown[]): void => {
  if (CONSOLE_DEBUG) console.log(...args);
};
const dbgErr = (...args: unknown[]): void => {
  if (CONSOLE_DEBUG) console.error(...args);
};

// ─── Settings ────────────────────────────────────────────────────────────────

interface RemoteControlSettings {
  url: string;
  token?: string;
  name?: string;
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function readSettings(): Record<string, unknown> {
  const agentDir = join(homedir(), ".pi", "agent");
  const globalSettings = readJsonFile(join(agentDir, "settings.json"));
  // Project settings from cwd — read from the cwd where pi is running
  const cwd = process.cwd();
  const projectSettings = readJsonFile(join(cwd, ".pi", "settings.json"));
  // Project wins over global
  return deepMerge(globalSettings, projectSettings);
}

function getRemoteControlSettings(settings: Record<string, unknown>): RemoteControlSettings | null {
  const rc = settings["remoteControl"] as Record<string, unknown> | undefined;
  if (!rc || typeof rc !== "object" || !rc["url"]) return null;
  return {
    url: String(rc["url"]),
    token: rc["token"] ? String(rc["token"]) : undefined,
    name: rc["name"] ? String(rc["name"]) : undefined,
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BACKOFF_MAX_MS = 30_000;
const RECONNECT_INITIAL_MS = 2_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface TranscriptItem {
  type: "user" | "assistant_delta" | "assistant_end" | "tool" | "state";
  text?: string;
  messageId?: string;
  running?: boolean;
}

interface SessionHistoryEntry {
  file: string;
  updatedAt: number;
  lastUserText?: string;
  model?: string;
  cwd?: string;
  messageCount?: number;
}

// ─── Module State ─────────────────────────────────────────────────────────────

// FIX #1: Capture pi at factory time so handleRemoteMessage can use it.
let api: ExtensionAPI | null = null;

let ws: WebSocket | null = null;
let lastCtx: ExtensionContext | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setTimeout> | null = null;
let lastAssistantText: Map<string, string> = new Map();
// FIX #10: Replace text-set matching with a positional flag.
let nextUserMessageIsRemote = false;
// FIX #9: Delta keying per TURN, not by message.id.
let currentAssistantKey = 0;
let currentSessionId: string | null = null;
let currentCwd: string | "";
let currentModel: { provider: string; id: string } | null = null;
let isConnected = false;
let deviceRegistered = false;
// FIX #11: Track fatal auth so we don't reconnect on bad token.
let fatalAuth = false;
// FIX #12: Backoff attempt counter.
let reconnectAttempts = 0;
// /remote off is a BOX-WIDE, persisted switch. Source of truth = the
// remote/state/client.off marker on this machine, checked dynamically via
// remoteIsOff() so a session turning off stops every session here immediately.
// Track whether the current socket ever opened: a failed connect (server down)
// must not fire a misleading "disconnected" warning.
let everConnected = false;

// ─── Persistent /remote off marker ───────────────────────────────────────────

function offMarkerPath(): string {
  return join(homedir(), ".pi", "agent", "remote", "state", "client.off");
}

// Box-wide source of truth: read the marker file on every call so a session
// that toggles /remote off applies to every other session on this box at its
// next connect/reconnect — not just this session.
function remoteIsOff(): boolean {
  try {
    return existsSync(offMarkerPath());
  } catch {
    return false;
  }
}

function persistRemoteOff(): void {
  try {
    mkdirSync(dirname(offMarkerPath()), { recursive: true });
    writeFileSync(offMarkerPath(), String(Date.now()), "utf-8");
  } catch { /* best effort */ }
}

function clearRemoteOffMarker(): void {
  try {
    if (existsSync(offMarkerPath())) unlinkSync(offMarkerPath());
  } catch { /* best effort */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDeviceId(settings: RemoteControlSettings): string {
  return settings.name || osHostname() || "unknown";
}

function getPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

function truncateTo60(s: string): string {
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
}

function toolSummary(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": {
      const cmd = (args.command as string) ?? "";
      return `Ran ${truncateTo60(cmd)}`;
    }
    case "read": {
      const path = (args.path as string) ?? "";
      return `Read ${truncateTo60(path)}`;
    }
    case "write": {
      const path = (args.path as string) ?? "";
      return `Created ${truncateTo60(path)}`;
    }
    case "edit": {
      const path = (args.path as string) ?? "";
      return `Edited ${truncateTo60(path)}`;
    }
    default: {
      const firstArg = Object.values(args)[0];
      const argStr = typeof firstArg === "string" ? truncateTo60(firstArg) : "";
      return argStr ? `${toolName} ${argStr}` : `${toolName} …`;
    }
  }
}

// FIX #8: Use ctx.sessionManager.getSessionDir() only (no env-var pre-check).
function getSessionsDir(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionDir();
}

// FIX #14: One read + one split per file.
function listSessionsTop50(sessionsDir: string): SessionHistoryEntry[] {
  // Collect all .jsonl files recursively (sessions are in cwd-named subdirs).
  const jsonlFiles: string[] = [];
  function scan(dir: string): void {
    try {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        const st = statSync(p);
        if (st.isDirectory()) scan(p);
        else if (f.endsWith(".jsonl")) jsonlFiles.push(p);
      }
    } catch { /* skip unreadable dirs */ }
  }
  try { scan(sessionsDir); } catch { /* skip */ }

  try {
    const stats = jsonlFiles.map(f => {
      try { return { file: f, mtime: statSync(f).mtimeMs }; } catch { return { file: f, mtime: 0 }; }
    });
    stats.sort((a, b) => b.mtime - a.mtime);
    const top = stats.slice(0, 50);

    return top.map(({ file, mtime }) => {
      let lastUserText: string | undefined;
      let model: string | undefined;
      let cwd: string | undefined;
      let messageCount = 0;

      try {
        // FIX #14: One read + one split per file.
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");
        messageCount = lines.filter(l => l.trim()).length;

        // Scan from end for last user message text.
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]?.trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            // FIX #4: Real shape is {"type":"message",...,"message":{"role":"user",...}}
            if (parsed.type === "message" && parsed.message?.role === "user" && parsed.message.content) {
              const content = parsed.message.content;
              const text = typeof content === "string"
                ? content
                : Array.isArray(content)
                    ? content
                        .filter((c: { type: string }) => c.type === "text")
                        .map((c: { text: string }) => c.text)
                        .join("")
                    : "";
              if (text) { lastUserText = text; break; }
            }
          } catch { /* skip bad lines */ }
        }

        // Scan from beginning for model (last model_change wins).
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]?.trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "session") {
              cwd = (parsed as { cwd?: string }).cwd;
            } else if (parsed.type === "model_change") {
              const mc = parsed as { provider?: string; modelId?: string };
              if (mc.provider && mc.modelId) {
                model = `${mc.provider}/${mc.modelId}`;
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip unreadable files */ }

      return {
        file: basename(file),
        updatedAt: mtime,
        lastUserText,
        model,
        cwd,
        messageCount,
      } satisfies SessionHistoryEntry;
    });
  } catch {
    return [];
  }
}

// FIX #4: Real JSONL shape — entries are {"type":"message",...,"message":{"role":"...",...}}
// Model comes from "model_change" entries ({provider, modelId}), not from the header.
// FIX #1: Two-pass — first collect toolCall blocks from assistant messages, then
//         use the map to supply real args to toolSummary() for toolResult entries.
function parseTranscript(sessionFile: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  try {
    const content = readFileSync(sessionFile, "utf-8");
    const lines = content.split("\n");
    let currentMessageId: string | null = null;
    let currentText = "";
    let lastModel: string | undefined;

    // Pass 1: Build toolCallId → {toolName, args} map from assistant entries.
    const toolCallMap = new Map<string, { toolName: string; args: Record<string, unknown> }>();
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed.type !== "message" || !parsed.message) continue;
      const msg = parsed.message as { role?: string; content?: unknown };
      if (msg.role !== "assistant") continue;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object" && (block as { type: string }).type === "toolCall") {
            const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
            if (tc.id) {
              toolCallMap.set(tc.id, { toolName: tc.name, args: tc.arguments || {} });
            }
          }
        }
      }
    }

    // Pass 2: Process entries.
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line); } catch { continue; }

      if (parsed.type === "session") continue; // header

      // FIX #4: Track model from model_change entries.
      if (parsed.type === "model_change") {
        const mc = parsed as { provider?: string; modelId?: string };
        if (mc.provider && mc.modelId) {
          lastModel = `${mc.provider}/${mc.modelId}`;
        }
        continue;
      }

      // FIX #4: Real shape — entry.message, not top-level role.
      if (parsed.type !== "message" || !parsed.message) continue;
      const msg = parsed.message as { role?: string; content?: unknown; id?: string };
      const role = msg.role;
      const msgId = (parsed.id as string) ?? (msg.id as string) ?? "";

      if (role === "user") {
        const content = msg.content;
        const text = typeof content === "string"
          ? content
          : Array.isArray(content)
              ? content
                  .filter((c: { type: string }) => c.type === "text")
                  .map((c: { text: string }) => c.text)
                  .join("")
              : "";
        if (text) {
          items.push({ type: "user", text });
        }
      } else if (role === "assistant") {
        // Extract text from assistant message content.
        let assistantText = "";
        if (Array.isArray(msg.content)) {
          assistantText = msg.content
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { text: string }) => c.text)
            .join("");
        }
        if (assistantText) {
          currentMessageId = msgId || `msg-${items.length}`;
          items.push({ type: "assistant_delta", messageId: currentMessageId, text: "" });
          items.push({ type: "assistant_end", messageId: currentMessageId, text: assistantText });
        }
      } else if (role === "toolResult") {
        // FIX #4: Tool results are in message entries with role "toolResult".
        const toolCallId = (msg as { toolCallId?: string }).toolCallId ?? "";
        const toolInfo = toolCallMap.get(toolCallId);
        const toolName = toolInfo?.toolName ?? (msg as { toolName?: string }).toolName ?? "";
        const args = toolInfo?.args ?? {};
        const content = msg.content;
        const text = Array.isArray(content)
          ? content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("")
          : "";
        if (toolName && text) {
          // Derive one-line summary: bash→command, read/edit/write→path.
          const summary = toolSummary(toolName, args);
          items.push({ type: "tool", text: `${summary}` });
        }
      }
    }
  } catch { /* best effort */ }
  return items;
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function sendToServer(msg: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendHello(settings: RemoteControlSettings): void {
  sendToServer({
    v: 1,
    type: "hello",
    token: settings.token,
    device: {
      id: getDeviceId(settings),
      name: settings.name,
      host: osHostname() || "unknown",
      platform: getPlatform(),
      cwd: process.cwd(),
      agent: "pi",
    },
  });
}

function sendSessionRegister(): void {
  if (!currentSessionId) return;
  sendToServer({
    type: "session.register",
    sessionId: currentSessionId,
    cwd: currentCwd,
    model: currentModel,
    startedAt: Date.now(),
  });
}

function sendSessionUnregister(): void {
  if (currentSessionId) {
    sendToServer({ type: "session.unregister", sessionId: currentSessionId, reason: "disconnect" });
  }
}

function sendSessionsHistory(): void {
  const ctx = lastCtx;
  if (!ctx) return;
  const sessionsDir = getSessionsDir(ctx);
  const sessions = listSessionsTop50(sessionsDir);
  // DESIGN.md: sessions.history has no sessionId field — server knows the device
  sendToServer({ type: "sessions.history", sessions });
}

function sendAssistantDelta(text: string): void {
  if (!currentSessionId || !isConnected) return;
  sendToServer({
    type: "stream.assistant_delta",
    sessionId: currentSessionId,
    messageId: currentAssistantKey,
    text,
  });
}

function sendAssistantEnd(fullText: string): void {
  if (!currentSessionId || !isConnected) return;
  sendToServer({
    type: "stream.assistant_end",
    sessionId: currentSessionId,
    messageId: currentAssistantKey,
    text: fullText,
  });
}

function sendUserMessage(text: string, source: "local" | "remote"): void {
  if (!currentSessionId || !isConnected) return;
  sendToServer({
    type: "message.user",
    sessionId: currentSessionId,
    text,
    source,
  });
}

function sendToolLine(text: string): void {
  if (!currentSessionId || !isConnected) return;
  sendToServer({
    type: "tool.line",
    sessionId: currentSessionId,
    text,
  });
}

function sendState(running: boolean): void {
  if (!currentSessionId || !isConnected) return;
  sendToServer({
    type: "state",
    sessionId: currentSessionId,
    running,
  });
}

function sendTranscript(sessionKey: string, items: TranscriptItem[]): void {
  if (!isConnected) return;
  sendToServer({
    type: "transcript",
    sessionKey,
    items,
  });
}

function sendPong(t: number): void {
  sendToServer({ type: "pong", t });
}

// ─── Reconnection ─────────────────────────────────────────────────────────────

// FIX #12: Exponential backoff with jitter.
function scheduleReconnect(settings: RemoteControlSettings): void {
  if (reconnectTimer) return;
  if (fatalAuth) return; // FIX #11: Don't reconnect on auth failure.
  if (remoteIsOff()) return; // /remote off (box-wide): no reconnect.
  // FIX #12: Exponential backoff: min(2000 * 2^attempts, 30000) ± 25% jitter.
  const baseDelay = Math.min(RECONNECT_INITIAL_MS * Math.pow(2, reconnectAttempts), BACKOFF_MAX_MS);
  const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1); // ±25%
  const delay = Math.max(0, baseDelay + jitter);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempts++;
    connect(settings);
  }, delay);
  // Make it non-blocking so process exit isn't delayed
  if (reconnectTimer.unref) reconnectTimer.unref();
}

function resetReconnectAttempts(): void {
  reconnectAttempts = 0;
}

function connect(settings: RemoteControlSettings): void {
  // HARD STOP: when /remote off, never open a socket, from any caller. This is
  // the single choke point — scheduleReconnect, onSessionStart, and /remote on
  // all route here, so gating it here guarantees off == no connection attempt.
  if (remoteIsOff()) {
    dbg("[remote-control] connect skipped: /remote off");
    return;
  }
  // Re-read settings from disk on every connect: the token may have been
  // rotated (remote-server token rotate) since this session started. An
  // in-memory copy goes stale → 4001 → fatalAuth would permanently kill the
  // client for the rest of the session.
  try {
    const fresh = getRemoteControlSettings(readSettings());
    if (fresh) settings = fresh;
  } catch { /* keep the passed-in settings */ }

  // Clear any pending reconnect timer so a manual connect (e.g. /new while
  // the server was down) can't be raced by the timer into a close/reopen churn loop.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }

  everConnected = false;
  const url = settings.url;
  const token = settings.token;
  // Device socket lives at /ws — settings.url is usually just the host root.
  let base = url.replace(/\/+$/, "");
  if (!/\/(ws|ui)$/.test(base)) base += "/ws";
  const wsUrl = token ? `${base}?token=${encodeURIComponent(token)}` : base;

  let socket: WebSocket;
  try {
    socket = new WebSocket(wsUrl);
  } catch (err) {
    dbgErr("[remote-control] WebSocket connect failed:", err);
    scheduleReconnect(settings);
    return;
  }
  ws = socket;

  // Guard: once connect() replaces this socket, its events are stale —
  // they must not toast or schedule reconnects, or every intentional
  // close/reconnect becomes a perpetual disconnected/connected flap loop.
  const live = (): boolean => ws === socket;

  socket.addEventListener("open", () => {
    if (!live()) return;
    everConnected = true;
    try {
      isConnected = true;
      deviceRegistered = false;
      dbg("[remote-control] Connected to server");
      // Best-effort TUI feedback
      try {
        lastCtx?.ui.notify("Remote control: connected", "info");
      } catch { /* best effort */ }
      // FIX #3: On every open → send hello.
      sendHello(settings);
    } catch (err) {
      dbgErr("[remote-control] open handler error:", err);
    }
  });

  // FIX #6: Wrap the whole WS message dispatch in try/catch.
  socket.addEventListener("message", (ev: MessageEvent) => {
    if (!live()) return;
    try {
      const raw = (ev as { data?: unknown }).data ?? ev;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      const type = msg.type as string;

      if (type === "hello.ok") {
        dbg("[remote-control] Server hello OK");
        // FIX #2: Set deviceRegistered = true.
        deviceRegistered = true;
        // FIX #12: Reset backoff on success.
        resetReconnectAttempts();
        // FIX #3: Re-register current session + re-send sessions.history.
        if (lastCtx && currentSessionId) {
          sendSessionRegister();
          sendSessionsHistory();
        }
      } else if (type === "hello.error") {
        // FIX #11: Set fatalAuth flag; do NOT schedule reconnect; notify user.
        fatalAuth = true;
        dbgErr("[remote-control] Server hello error:", msg);
        ws?.close();
        try {
          lastCtx?.ui.notify(`Remote control: auth failed — ${msg.code ?? "bad_token"}`, "error");
        } catch { /* best effort */ }
      } else if (type === "cmd.message") {
        const sessionId = msg.sessionId as string;
        const text = msg.text as string;
        if (sessionId && text && lastCtx) {
          // Only process if sessionId matches current (we only control this session)
          if (sessionId === currentSessionId || !currentSessionId) {
            handleRemoteMessage(text, lastCtx);
          }
        }
      } else if (type === "cmd.abort") {
        const sessionId = msg.sessionId as string;
        if (sessionId && lastCtx) {
          if (sessionId === currentSessionId || !currentSessionId) {
            handleRemoteAbort(lastCtx);
          }
        }
      } else if (type === "req.history") {
        sendSessionsHistory();
      } else if (type === "req.transcript") {
        const sessionKey = msg.sessionKey as string;
        const file = msg.file as string;
        if (sessionKey && file && lastCtx) {
          // file is basename; find full path recursively under sessions dir (depth ≤ 2)
          const sessionsDir = getSessionsDir(lastCtx);
          // Path traversal guard.
          if (file === "/" || basename(file) !== file) {
            dbgErr("[remote-control] req.transcript: rejected path traversal attempt", file);
            return;
          }
          // Sessions live in cwd-named subdirectories; recurse to find basename.
          // pi names files `<timestamp>_<sessionId>.jsonl`, so match either the
          // exact name or the timestamp-prefixed form.
          let fullPath: string | null = null;
          function findFile(dir: string, depth: number): void {
            if (depth > 2 || fullPath) return;
            try {
              for (const f of readdirSync(dir)) {
                const p = join(dir, f);
                const st = statSync(p);
                if (st.isDirectory()) {
                  findFile(p, depth + 1);
                } else if (f === file || f.endsWith("_" + file)) {
                  const resolved = resolve(p);
                  if (resolved.startsWith(resolve(sessionsDir))) {
                    fullPath = resolved;
                    return;
                  }
                }
              }
            } catch { /* skip */ }
          }
          try { findFile(sessionsDir, 0); } catch { /* skip */ }
          if (fullPath) {
            const items = parseTranscript(fullPath);
            sendTranscript(sessionKey, items);
          }
        }
      } else if (type === "ping") {
        const t = msg.t as number;
        if (t != null) sendPong(t);
      }
    } catch (err) {
      // FIX #6: Never crash pi from a WS message error.
      dbgErr("[remote-control] WS message handler error:", err);
    }
  });

  socket.addEventListener("close", (ev) => {
    if (!live()) return; // replaced by a newer connect() — intentional close
    isConnected = false;
    deviceRegistered = false;
    dbg("[remote-control] Disconnected from server", `code=${ev.code}`, ev.reason);
    // Toast only for a real drop (the socket had opened) and never while
    // /remote off — a server that's simply down never opens, so it must not
    // spam "disconnected".
    if (everConnected && !remoteIsOff() && lastCtx) {
      try { lastCtx.ui.notify("Remote control: disconnected", "warning"); } catch { /* best effort */ }
    }
    scheduleReconnect(settings);
  });

  socket.addEventListener("error", (ev) => {
    if (!live()) return;
    dbgErr("[remote-control] WebSocket error:", (ev as { message?: string }).message ?? ev);
  });
}

function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pingTimer) {
    clearTimeout(pingTimer);
    pingTimer = null;
  }
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  isConnected = false;
  deviceRegistered = false;
}

// ─── Remote Command Handlers ──────────────────────────────────────────────────

function handleRemoteMessage(text: string, ctx: ExtensionContext): void {
  // FIX #10: Set positional flag right after calling sendUserMessage.
  nextUserMessageIsRemote = true;

  const expandTemplates = text.startsWith("/");
  try {
    if (ctx.isIdle()) {
      api?.sendUserMessage(text, { expandPromptTemplates: expandTemplates });
    } else {
      api?.sendUserMessage(text, { deliverAs: "steer", expandPromptTemplates: expandTemplates });
    }
  } catch (err) {
    // FIX #6: Wrap sendUserMessage in try/catch so a throw can't kill the process.
    // FIX #4: Reset flag even on failure so local messages aren't mislabeled.
    nextUserMessageIsRemote = false;
    dbgErr("[remote-control] sendUserMessage error:", err);
  }
}

function handleRemoteAbort(ctx: ExtensionContext): void {
  if (!ctx.isIdle()) {
    try { ctx.abort(); } catch { /* best effort */ }
  }
}

// ─── pi Event Handlers ────────────────────────────────────────────────────────

// In-process child sessions (subagents/btw) and the main session all fire
// events through this module (shared ESM instance). Only act on events
// belonging to the session this module instance tracks (currentSessionId).
// Unknown session ids (defensive: minimal ctx) are allowed through.
function eventSessionId(ctx: ExtensionContext | undefined): string | null {
  try {
    return ctx?.sessionManager?.getSessionId?.() ?? null;
  } catch {
    return null;
  }
}

function isTrackedEvent(ctx: ExtensionContext | undefined): boolean {
  const sid = eventSessionId(ctx);
  return sid === null || sid === currentSessionId;
}

function onMessageStart(event: { message: { role: string; content: unknown } }, ctx: ExtensionContext): void {
  if (!isTrackedEvent(ctx)) return; // in-process child session (subagent/btw) — not the remote-controlled session
  if (event.message.role === "user") {
    // Determine source: local vs remote
    const content = event.message.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("");
    }

    // FIX #10: Consume the positional flag instead of text-set matching.
    let source: "local" | "remote" = "local";
    if (nextUserMessageIsRemote) {
      source = "remote";
      nextUserMessageIsRemote = false;
    }

    sendUserMessage(text, source);
  }
}

function onMessageUpdate(event: { message: { role: string; content: unknown } }, ctx: ExtensionContext): void {
  if (!isTrackedEvent(ctx)) return; // in-process child session (subagent/btw)
  if (event.message.role !== "assistant") return;

  // FIX #9: Key assistant text snapshots per TURN, not by event.message.id.
  // Extract incremental text from the message content
  let fullText = "";
  if (Array.isArray(event.message.content)) {
    fullText = event.message.content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("");
  }

  // Compute delta vs last snapshot (per-turn key).
  const lastText = lastAssistantText.get(currentAssistantKey) ?? "";
  const delta = fullText.slice(lastText.length);
  if (delta) {
    lastAssistantText.set(currentAssistantKey, fullText);
    sendAssistantDelta(delta);
  }
}

function onMessageEnd(event: { message: { role: string; content: unknown; id?: string } }, ctx: ExtensionContext): void {
  if (!isTrackedEvent(ctx)) return; // in-process child session (subagent/btw)
  if (event.message.role !== "assistant") return;

  // FIX #13: Skip assistant_end when the accumulated full text is empty.
  let fullText = "";
  if (Array.isArray(event.message.content)) {
    fullText = event.message.content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("");
  }

  if (!fullText) {
    // Empty assistant text — skip sending assistant_end.
    currentAssistantKey++;
    return;
  }

  const msgId = event.message.id ?? "";
  lastAssistantText.set(currentAssistantKey, fullText);
  sendAssistantEnd(fullText);

  // Increment turn key for next assistant message.
  currentAssistantKey++;
}

function onToolExecutionStart(event: { toolCallId: string; toolName: string; args: Record<string, unknown> }, ctx: ExtensionContext): void {
  if (!isTrackedEvent(ctx)) return; // in-process child session (subagent/btw)
  const summary = toolSummary(event.toolName, event.args);
  sendToolLine(summary);
}

function onToolExecutionEnd(_event: { toolCallId: string; toolName: string }, _ctx: ExtensionContext): void {
  // tool.line already sent at start; no extra needed per DESIGN.md
}

function onTurnStart(_event: { turnIndex: number; timestamp: number }, ctx: ExtensionContext): void {
  if (!isTrackedEvent(ctx)) return; // in-process child session (subagent/btw)
  sendState(true);
}

function onTurnEnd(_event: { turnIndex: number; message?: unknown; toolResults?: unknown }, ctx: ExtensionContext): void {
  if (!isTrackedEvent(ctx)) return; // in-process child session (subagent/btw)
  sendState(false);
}

function onSessionStart(event: { reason: string; previousSessionFile?: string }, ctx: ExtensionContext): void {
  // Defensive: some harnesses fire this with a minimal ctx that lacks
  // sessionManager. In real pi it is always present.
  if (!ctx.sessionManager) return;
  // Which sessions does this module instance track?
  // - "reload": pi re-emits session_start for the tracked session BEFORE the
  //   UI context is re-attached (agent-session.js reload(): the emit happens
  //   while the runner's uiContext is still the no-op one), so hasUI is false
  //   even though this IS the interactive session. Reason "reload" is always
  //   trusted.
  // - everything else: only interactive sessions (ctx.hasUI === true). In-
  //   process subagent/btw children start with reason "startup" and
  //   hasUI === false (mode "print") — skipping them keeps their ghost
  //   sessions off the remote dashboard and their events out of the feed.
  const isTracked = event.reason === "reload" || ctx.hasUI === true;
  if (!isTracked) return;
  // FIX #5: Connect WS on session_start (not from factory).
  if (!ws && !remoteIsOff()) {
    const rc = getRemoteControlSettings(readSettings());
    if (rc) connect(rc);
  }

  currentSessionId = ctx.sessionManager.getSessionId();
  lastCtx = ctx; // the tracked session owns the delivery ctx
  currentCwd = ctx.sessionManager.getCwd() || "";
  currentModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;

  // Re-register session with server
  if (isConnected && deviceRegistered) {
    sendSessionRegister();
  }

  // Send state: idle (not running yet)
  sendState(false);
}

function onSessionShutdown(event: { reason: string; targetSessionFile?: string }, ctx: ExtensionContext): void {
  // Only the tracked session may tear down the connection — a child
  // (subagent/btw) session's shutdown must not unregister the main session
  // or close its shared socket.
  if (!isTrackedEvent(ctx)) return;
  // Unregister BEFORE disconnecting — disconnect() nulls ws and the
  // unregister frame would be dropped (server would keep a stale live session).
  sendSessionUnregister();
  // FIX #5: Disconnect WS on session_shutdown.
  disconnect();
  currentSessionId = null;
  lastAssistantText.clear();
  currentAssistantKey = 0;
}

// ─── /remote command ──────────────────────────────────────────────────────

function registerRemoteCommand(pi: ExtensionAPI): void {
  const status = (ctx: ExtensionCommandContext): void => {
    const rc = getRemoteControlSettings(readSettings());
    if (!rc) {
      ctx.ui.notify("Remote control: not configured — use /remote-server to start a local server or add a URL.", "info");
      return;
    }
    ctx.ui.notify(
      `Remote control: ${remoteIsOff() ? "OFF (disabled on this box)" : "ON"} — ${rc.url}, ${isConnected ? "connected" : "not connected"}, device=${getDeviceId(rc)}.` +
      "\n/remote on|off to connect/disconnect.",
      "info",
    );
  };

  pi.registerCommand("remote", {
    description: "Remote control client: status / on / off",
    handler: (_args: string, ctx: ExtensionCommandContext): void => {
      const subcmd = _args.trim().split(/\s+/)[0]?.toLowerCase();

      if (subcmd === "on") {
        clearRemoteOffMarker();
        const rc = getRemoteControlSettings(readSettings());
        if (!rc) {
          ctx.ui.notify("not configured — use /remote-server", "info");
          return;
        }
        if (ws && isConnected) {
          ctx.ui.notify("already connected", "info");
          return;
        }
        connect(rc);
        ctx.ui.notify(`connecting to ${rc.url}…`, "info");
        return;
      }

      if (subcmd === "off") {
        persistRemoteOff();
        disconnect();
        ctx.ui.notify("Remote control: off for this box — all sessions are stopped and it persists across restarts. /remote on to reconnect.", "info");
        return;
      }

      // Bare invocation (no subcmd) or unknown subcmd → status.
      status(ctx);
    },
  });
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // FIX #1: Capture pi at factory time.
  api = pi;

  // ALWAYS register the command and all event handlers — even when no
  // remoteControl.url is configured. The handlers are defensive: session_start
  // only connects the WS when merged settings have a remoteControl.url, and
  // all send*() helpers no-op when not connected.

  // Register the /remote command
  registerRemoteCommand(pi);

  // Store ctx from session_start for use in command handlers
  pi.on("session_start", (event, ctx) => {
    onSessionStart(event, ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    onSessionShutdown(event, ctx);
  });

  // Message events
  pi.on("message_start", (event, ctx) => {
    onMessageStart(event, ctx);
  });

  pi.on("message_update", (event, _ctx) => {
    onMessageUpdate(event, _ctx);
  });

  pi.on("message_end", (event, _ctx) => {
    onMessageEnd(event, _ctx);
  });

  // Tool execution events
  pi.on("tool_execution_start", (event, ctx) => {
    onToolExecutionStart(event, ctx);
  });

  pi.on("tool_execution_end", (event, _ctx) => {
    onToolExecutionEnd(event, _ctx);
  });

  // Turn events
  pi.on("turn_start", (event, _ctx) => {
    onTurnStart(event, _ctx);
  });

  pi.on("turn_end", (event, _ctx) => {
    onTurnEnd(event, _ctx);
  });

  // Abort: capture ctx from any turn event so we can abort
  pi.on("agent_start", (_event, ctx) => {
    if (isTrackedEvent(ctx)) lastCtx = ctx; // only the tracked session may own the delivery ctx
  });

  // FIX #5: Do NOT connect from factory. Connect on session_start instead.
}