/**
 * One-off test device: proves multiple stream.assistant_delta events that share
 * ONE messageId now all render (the old dedupe dropped every delta after the
 * first of a message, and also its assistant_end).
 *
 * Emits, on its own live session:
 *   t+12s  stream.assistant_delta { messageId: 'multi-1', text: 'Hello ' }
 *   t+13s  stream.assistant_delta { messageId: 'multi-1', text: 'world' }
 *   t+13.5s stream.assistant_end  { messageId: 'multi-1', text: 'Hello world (multi-delta)' }
 *
 * Responds to req.transcript with canned items that do NOT contain multi-1,
 * so the live triple is the only source of the message — the browser must
 * stream-accumulate it rather than suppress deltas 2/3.
 *
 * Usage: node multi-delta-test.mjs   (reads token from remote/state/token)
 */
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const stateDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'state');
const token = readFileSync(join(stateDir, 'token'), 'utf-8').trim();

const DEVICE_ID = 'multi-delta-test-device';
const SESSION_ID = 'multidelta-' + Date.now();
const t0 = Date.now();
let ws = null;

function log(...a) { console.log(`[multi +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a); }

function connect() {
  ws = new WebSocket(`ws://127.0.0.1:4820/ws?token=${encodeURIComponent(token)}`);

  ws.on('open', () => {
    log('connected to relay');
    ws.send(JSON.stringify({
      type: 'hello',
      token,
      device: { id: DEVICE_ID, name: 'Multi-Delta Test Device', host: 'localhost', platform: 'darwin-arm64', cwd: '/tmp', agent: 'pi' },
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: msg.t })); return; }
      if (msg.type === 'hello.ok') {
        log('hello.ok — registering session', SESSION_ID);
        ws.send(JSON.stringify({
          type: 'session.register',
          sessionId: SESSION_ID,
          cwd: '/tmp',
          model: { provider: 'test', id: 'mock-model' },
          startedAt: Date.now(),
        }));
        // Schedule the multi-delta triple well after the browser is likely in.
        setTimeout(() => {
          log('delta 1/3 messageId=multi-1 text="Hello "');
          ws.send(JSON.stringify({ type: 'stream.assistant_delta', sessionId: SESSION_ID, messageId: 'multi-1', text: 'Hello ' }));
          ws.send(JSON.stringify({ type: 'state', sessionId: SESSION_ID, running: true }));
        }, 12000);
        setTimeout(() => {
          log('delta 2/3 messageId=multi-1 text="world" (SAME messageId)');
          ws.send(JSON.stringify({ type: 'stream.assistant_delta', sessionId: SESSION_ID, messageId: 'multi-1', text: 'world' }));
        }, 13000);
        setTimeout(() => {
          log('end 3/3 messageId=multi-1 text="Hello world (multi-delta)"');
          ws.send(JSON.stringify({ type: 'stream.assistant_end', sessionId: SESSION_ID, messageId: 'multi-1', text: 'Hello world (multi-delta)' }));
          ws.send(JSON.stringify({ type: 'state', sessionId: SESSION_ID, running: false }));
        }, 13500);
      } else if (msg.type === 'req.transcript') {
        log('req.transcript — replying with canned items (no multi-1)');
        const items = [
          { type: 'user', text: 'Multi-delta test: initial question' },
          { type: 'assistant_delta', messageId: 'md-backfill', text: '' },
          { type: 'assistant_end', messageId: 'md-backfill', text: 'Backfill item for the multi-delta test.' },
        ];
        ws.send(JSON.stringify({ type: 'transcript', sessionKey: msg.sessionKey, items }));
      }
    } catch (e) {
      console.error('[multi] error:', e);
    }
  });

  ws.on('close', () => { log('closed'); process.exit(0); });
  ws.on('error', (err) => console.error('[multi] ws error:', err.message));
}

connect();
setTimeout(() => { log('window over — exiting'); process.exit(0); }, 30000);
