/**
 * HTTP server: static file serving, /healthz endpoint.
 * Serves files from remote/web/ resolved relative to this module's location,
 * otherwise 404 for unknown paths.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', '..', 'web');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Serve a static file from the web directory.
 * Returns { status, headers, body } or null if not found.
 */
function serveStatic(webDir, pathname) {
  if (!existsSync(webDir)) return null;

  // Prevent directory traversal — watertight confinement
  const resolved = join(webDir, pathname === '/' ? 'index.html' : pathname);
  if (resolved !== webDir && !resolved.startsWith(webDir + sep)) return null;
  // Block path segments starting with '.' (hidden files / ..)
  if (pathname.split('/').some(seg => seg.startsWith('.'))) return null;

  if (!existsSync(resolved)) return null;

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    // Try index.html in directory
    const indexPath = join(resolved, 'index.html');
    if (existsSync(indexPath)) {
      return { status: 200, headers: { 'Content-Type': MIME_TYPES['.html'] || 'text/html', 'Cache-Control': 'no-store' }, body: readFileSync(indexPath) };
    }
    return null;
  }

  const ext = extname(resolved);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  return {
    status: 200,
    headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' },
    body: readFileSync(resolved),
  };
}

/**
 * Create an HTTP server that serves static files and /healthz.
 * Returns the server instance.
 */
export function createHttpServer(port, registry, stateDir) {
  const server = createServer((req, res) => {
    // /healthz endpoint
    if (req.url === '/healthz' && req.method === 'GET') {
      const uptime = Math.floor((Date.now() - server.startTime) / 1000);
      const body = JSON.stringify({
        ok: true,
        port,
        devices: registry.getConnectedDevices().length,
        uptime,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // Static file serving
    const pathname = req.url.split('?')[0]; // strip query string
    const result = serveStatic(WEB_DIR, pathname);

    if (result) {
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.startTime = Date.now();
  return server;
}