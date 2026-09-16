/**
 * Persistent mock device for E2E testing of the live-session transcript backfill feature.
 *
 * Connects to the relay server as a device, registers a session, and stays connected
 * (responds to pings, reconnects on close, re-registers the session after each
 * reconnect). Responds to req.transcript with canned items. Also sends periodic
 * live events every 3s.
 *
 * Usage: node mock-device.mjs   (reads token from remote/state/token automatically)
 */

import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Token lives at remote/state/token; this script is in remote/server/.
const stateDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'state');
const token = readFileSync(join(stateDir, 'token'), 'utf-8').trim();

const FAKE_DEVICE_ID = 'verify-mock-device';
const FAKE_SESSION_ID = 'mock-session-' + Date.now();
let step = 0;
let ws = null;
let stopped = false;

function connect() {
  ws = new WebSocket(`ws://127.0.0.1:4820/ws?token=${encodeURIComponent(token)}`);

  ws.on('open', () => {
    console.log('[mock] Connected to relay server');
    ws.send(JSON.stringify({
      type: 'hello',
      token,
      device: {
        id: FAKE_DEVICE_ID,
        name: 'Mock Device (E2E Test)',
        host: 'localhost',
        platform: 'darwin-arm64',
        cwd: '/tmp',
        agent: 'pi',
      },
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Keepalive: server pings every 15s and drops us after 45s without a pong.
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        return;
      }

      if (msg.type === 'hello.ok') {
        console.log('[mock] hello.ok received');
        // Register a live session
        ws.send(JSON.stringify({
          type: 'session.register',
          sessionId: FAKE_SESSION_ID,
          cwd: '/tmp',
          model: { provider: 'test', id: 'mock-model' },
          startedAt: Date.now(),
        }));
        console.log('[mock] Registered session:', FAKE_SESSION_ID);
        step = 1;
      } else if (msg.type === 'req.transcript') {
        console.log('[mock] Received req.transcript for sessionKey:', msg.sessionKey);
        // Respond with canned transcript items (simulating a parsed session file)
        const items = [
          { type: 'user', text: 'Hello, this is a test message 1' },
          { type: 'assistant_delta', messageId: 'mock-1', text: '' },
          { type: 'assistant_end', messageId: 'mock-1', text: 'Hello! This is a mock assistant response for testing the transcript backfill feature.' },
          { type: 'user', text: 'How does the backfill work?' },
          { type: 'assistant_delta', messageId: 'mock-2', text: '' },
          { type: 'assistant_end', messageId: 'mock-2', text: 'The backfill works by sending a transcript request to the device, which reads the session file and returns the full history. Live events are buffered until the transcript arrives.' },
          { type: 'tool', text: 'Read /tmp/test.txt' },
          { type: 'user', text: 'What does this look like in the UI?' },
          { type: 'assistant_delta', messageId: 'mock-3', text: '' },
          { type: 'assistant_end', messageId: 'mock-3', text: 'In the UI, you see the full history rendered first, then live events continue streaming without duplicates. The server buffers events while waiting for the transcript.' },
        ];
        ws.send(JSON.stringify({
          type: 'transcript',
          sessionKey: msg.sessionKey,
          items,
        }));
        console.log('[mock] Sent transcript with', items.length, 'items');
        step = 2;
      } else if (msg.type === 'cmd.message') {
        console.log('[mock] Received cmd.message:', msg.text);
      }
    } catch (e) {
      console.error('[mock] Error handling message:', e);
    }
  });

  ws.on('close', (ev) => {
    console.log(`[mock] Disconnected (code=${ev.code}).${stopped ? '' : ' Reconnecting in 2s…'}`);
    if (!stopped) setTimeout(connect, 2000);
  });

  ws.on('error', (err) => {
    console.error('[mock] Error:', err.message);
  });
}

// Send periodic live events to test that they arrive after backfill without duplicates
setInterval(() => {
  if (ws && ws.readyState === 1 && step >= 1) {
    const ts = new Date().toISOString().slice(11, 19);
    const n = step; // capture: setTimeout callbacks fire after step++ below
    console.log('[mock] Sending live event at', ts);

    // Send a user message
    ws.send(JSON.stringify({
      type: 'message.user',
      sessionId: FAKE_SESSION_ID,
      text: `Live event #${n} at ${ts}`,
    }));

    // Send assistant delta
    ws.send(JSON.stringify({
      type: 'stream.assistant_delta',
      sessionId: FAKE_SESSION_ID,
      messageId: 'mock-live-' + n,
      text: 'Live response ' + n,
    }));

    // Send state running
    ws.send(JSON.stringify({
      type: 'state',
      sessionId: FAKE_SESSION_ID,
      running: true,
    }));

    // Send assistant end after a short delay
    setTimeout(() => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'stream.assistant_end',
          sessionId: FAKE_SESSION_ID,
          messageId: 'mock-live-' + n,
          text: `Live response ${n} — this event was streamed after the backfill completed.`,
        }));
        console.log('[mock] Sent live assistant_end for turn', n);
      }
    }, 300);

    // Send state idle
    setTimeout(() => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'state',
          sessionId: FAKE_SESSION_ID,
          running: false,
        }));
      }
    }, 600);

    step++;
  }
}, 3000); // Every 3 seconds

// Graceful shutdown
process.on('SIGINT', () => {
  stopped = true;
  console.log('[mock] Shutting down...');
  if (ws) ws.close();
  process.exit(0);
});

console.log('[mock] Starting persistent mock device (deviceId:', FAKE_DEVICE_ID + ', sessionId:', FAKE_SESSION_ID + ')');
connect();
