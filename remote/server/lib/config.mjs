/**
 * Configuration: port, state dir, token resolution.
 * Token lives at <stateDir>/token, auto-generated on first run.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const DEFAULT_PORT = 4820;
const DEFAULT_STATE_DIR = join(process.env.HOME || process.env.HOMEPATH || '/tmp', '.pi', 'agent', 'remote', 'state');

/**
 * Parse --port and --state flags from process.argv.
 * Supports both --port 4899 and --port=4899 formats.
 * Returns { port, stateDir }.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  let port = DEFAULT_PORT;
  let stateDir = DEFAULT_STATE_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1] !== undefined) {
      port = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i].startsWith('--port=')) {
      port = parseInt(argv[i].split('=')[1], 10);
    } else if (argv[i] === '--state' && argv[i + 1] !== undefined) {
      stateDir = argv[i + 1];
      i++;
    } else if (argv[i].startsWith('--state=')) {
      stateDir = argv[i].split('=')[1];
    }
  }
  return { port, stateDir };
}

/**
 * Ensure state dir exists, read or generate token.
 * Token is stored at <stateDir>/token (single line, no trailing newline).
 */
export function getToken(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const tokenPath = join(stateDir, 'token');
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, 'utf-8').trim();
  }
  const token = randomBytes(24).toString('hex');
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

/**
 * Write a file in the state dir.
 */
export function writeStateFile(stateDir, name, content) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, name), content, 'utf-8');
}

/**
 * Read a file from the state dir, returns null if not found.
 */
export function readStateFile(stateDir, name) {
  const p = join(stateDir, name);
  if (existsSync(p)) {
    return readFileSync(p, 'utf-8').trim();
  }
  return null;
}

/**
 * Get the pid file path.
 */
export function pidPath(stateDir) {
  return join(stateDir, 'server.pid');
}

/**
 * Get the meta file path (stores port info).
 */
export function metaPath(stateDir) {
  return join(stateDir, 'server.meta');
}