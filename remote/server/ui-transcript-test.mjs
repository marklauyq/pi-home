// One-shot test: connect as a browser UI socket and request a transcript for
// the mock live session. Logs everything received (tokens never printed).
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const stateDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'state');
const token = readFileSync(join(stateDir, 'token'), 'utf-8').trim();
const ws = new WebSocket(`ws://127.0.0.1:4820/ui?token=${encodeURIComponent(token)}`);
const KEY = process.argv[2];

ws.on('open', () => {
  console.log('[ui-test] connected; requesting transcript for', KEY);
  ws.send(JSON.stringify({ type: 'ui.subscribe', sessionKey: KEY }));
  ws.send(JSON.stringify({ type: 'ui.transcript.request', sessionKey: KEY }));
});
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'ui.transcript') {
    console.log('[ui-test] ui.transcript received, items:', m.items?.length);
    console.log(m.items?.map((i) => `${i.type}:${(i.text || '').slice(0, 50)}`).join('\n'));
  } else if (m.type === 'ui.send.ack') {
    console.log('[ui-test] ack:', JSON.stringify(m));
  } else if (m.type === 'ui.event') {
    console.log('[ui-test] event:', m.item?.type, JSON.stringify(m.item?.text || '').slice(0, 60));
  } else {
    console.log('[ui-test]', m.type, JSON.stringify(m).slice(0, 120));
  }
});
setTimeout(() => { console.log('[ui-test] window over'); ws.close(); process.exit(0); }, 8000);
