/**
 * Pi Remote Control Server — entry point.
 *
 * Usage: node remote/server/server.mjs [--port 4820] [--state <dir>]
 *
 * Runs in the foreground. Serves:
 *   HTTP:  static files from remote/web/, /healthz
 *   WS:    /ws (device clients), /ui (browser clients)
 *
 * All connections require token auth (timing-safe compare).
 * Wrong token → close 4001.
 */

import { createServer } from 'node:http';
import { unlinkSync, existsSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { Registry } from './lib/registry.mjs';
import { parseArgs, getToken, writeStateFile, pidPath } from './lib/config.mjs';
import { createHttpServer } from './lib/http.mjs';
import {
  handleDeviceConnection,
  handleBrowserConnection,
  registerDeviceSocket,
  send,
  safeCompare,
  parseQuery,
  broadcastToAllBrowsers,
  getDeviceSocket,
  removeDeviceSocket,
  hasDeviceSockets,
} from './lib/relay.mjs';

// ── Parse args ─────────────────────────────────────────────────────

const { port, stateDir } = parseArgs();

// ── State ──────────────────────────────────────────────────────────

const token = getToken(stateDir);

// Write pid file (only when running as a normal host process — as a
// container entrypoint (PID 1) the pid is meaningless to the host and a
// stale pid file could make `remote stop` signal the wrong process).
if (process.pid !== 1) {
  writeStateFile(stateDir, 'server.pid', String(process.pid));
  writeStateFile(stateDir, 'server.meta', JSON.stringify({ port, startedAt: Date.now() }));
}

// ── Registry ───────────────────────────────────────────────────────

const registry = new Registry();

// ── HTTP Server ────────────────────────────────────────────────────

const httpServer = createHttpServer(port, registry, stateDir);

// ── WebSocket Server ───────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

// Upgrade handler
httpServer.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  if (url.startsWith('/ws') || url.startsWith('/ui')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Connection handler
wss.on('connection', (ws, req) => {
  const url = req.url || '';
  const query = parseQuery(url);
  const providedToken = query.token || '';

  // Check token (timing-safe)
  if (!safeCompare(providedToken, token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  const pathname = new URL(url, 'http://localhost').pathname;
  if (pathname === '/ws') {
    // Device client — wait for hello message first
    deviceConnect(ws, registry);
  } else if (pathname === '/ui') {
    // Browser client
    handleBrowserConnection(ws, registry);
  }
});

/**
 * Handle a new device connection — wait for hello message.
 * Issue 1: after hello succeeds, return early so handleDeviceConnection's
 *          message listener owns all subsequent frames (no double-processing).
 * Issue 2: helled flag prevents re-hello stacking.
 */
function deviceConnect(ws, registry) {
  let deviceInfo = null;
  let helled = false;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'hello') {
        if (helled) {
          // Issue 2: re-hello on same socket — just update device, don't stack
          deviceInfo = msg.device;
          registry.setDevice(deviceInfo);
          broadcastToAllBrowsers('ui.sessions', registry.buildSessionsPayload());
          return;
        }
        helled = true;
        deviceInfo = msg.device;
        registry.setDevice(deviceInfo);
        registerDeviceSocket(deviceInfo.id, ws);

        // Send hello.ok
        send(ws, { v: 1, type: 'hello.ok', server: { name: 'pi-remote', version: '0.1.0' } });

        // Now fully handle the device connection (ping/pong, message routing)
        handleDeviceConnection(ws, deviceInfo, registry);

        // Push sessions update to all browsers
        broadcastToAllBrowsers('ui.sessions', registry.buildSessionsPayload());
      }
      // Issue 1: after hello, don't route frames through this handler.
      // handleDeviceConnection's listener owns all subsequent frames.
    } catch (_e) {
      // Ignore malformed JSON
    }
  });

  ws.on('close', () => {
    // Refcounted: the device goes offline only when the LAST socket for its
    // id closes (a host runs many pi sessions under one shared device id).
    if (deviceInfo) {
      removeDeviceSocket(deviceInfo.id, ws);
      if (!hasDeviceSockets(deviceInfo.id)) deviceDisconnect(deviceInfo.id);
    }
  });
}

/**
 * Handle device disconnect — mark disconnected, keep sessions, push update.
 * Issue 6: does NOT delete liveSessions or historySessions (pruned on
 *          explicit unregister or server restart only).
 */
function deviceDisconnect(deviceId) {
  registry.unsetDevice(deviceId);
  // The device is fully offline: its live sessions cannot be running. Mark
  // them stopped so the UI doesn't show stale green "running" badges; the
  // extension re-registers with true state when the device reconnects.
  registry.markDeviceSessionsStopped(deviceId);
  // Keep liveSessions + historySessions + ring buffers; browsers see offline device
  // Push update to browsers
  broadcastToAllBrowsers('ui.sessions', registry.buildSessionsPayload());
  registry.persistDevices(stateDir);
}

// ── Start listening ────────────────────────────────────────────────

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Pi Remote Control server running on port ${port}`);
  // Mask the token in the log (644, accumulates across restarts). The CLI
  // prints the full token to the terminal on start/status; it lives in <stateDir>/token.
  console.log(`Token: ${token.slice(0, 4)}…${token.slice(-4)} (masked; see cli start/status output)`);
  console.log(`State dir: ${stateDir}`);
  console.log(`WebSocket endpoints: ws://0.0.0.0:${port}/ws, ws://0.0.0.0:${port}/ui`);
});

// ── Graceful shutdown ──────────────────────────────────────────────

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('Shutting down...');
  // Persist devices before exit
  registry.persistDevices(stateDir);
  // Close WebSocket connections
  for (const ws of wss.clients) {
    ws.close(1001, 'Server shutting down');
  }
  // Close HTTP server
  httpServer.close(() => {
    // Remove pid file
    try {
      const p = pidPath(stateDir);
      if (existsSync(p)) {
        unlinkSync(p);
      }
    } catch (_e) {}
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(0), 5000);
}