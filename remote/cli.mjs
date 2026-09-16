/**
 * Pi Remote Control CLI — start|status|stop [--port N] [--state <dir>]
 *
 * Usage:
 *   node remote/cli.mjs start [--port 4820] [--state <dir>]
 *   node remote/cli.mjs status [--state <dir>]
 *   node remote/cli.mjs stop [--state <dir>]
 *
 * State dir: ~/.pi/agent/remote/state/ (default, overridable via --state)
 */

import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, createWriteStream, mkdirSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ── Resolve paths ──────────────────────────────────────────────────

// cli.mjs is at remote/cli.mjs
// repo root = parent of remote/ = dirname(dirname(import.meta.url))
const cliDir = dirname(process.argv[1] || '.');
const repoRoot = join(cliDir, '..');
const serverScript = join(repoRoot, 'remote', 'server', 'server.mjs');
const composeFile = join(repoRoot, 'remote', 'docker', 'docker-compose.yml');
const DOCKER_CONTAINER = 'pi-remote-relay';
const defaultStateDir = join(process.env.HOME || '/tmp', '.pi', 'agent', 'remote', 'state');

// ── Parse args ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { subcommand: null, port: 4820, stateDir: defaultStateDir, noDocker: false };
  for (let i = 0; i < argv.length; i++) {
    if (['start', 'status', 'stop'].includes(argv[i])) {
      args.subcommand = argv[i];
    } else if (argv[i] === '--port' && argv[i + 1] !== undefined) {
      args.port = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === '--state' && argv[i + 1] !== undefined) {
      args.stateDir = argv[i + 1];
      i++;
    } else if (argv[i] === '--no-docker') {
      args.noDocker = true;
    }
  }
  // Issue 10: validate port is integer 1-65535
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    console.error(`Error: port must be an integer 1-65535, got "${args.port}"`);
    process.exit(1);
  }
  return args;
}

// ── Helpers ────────────────────────────────────────────────────────

function readPidFile(stateDir) {
  const p = join(stateDir, 'server.pid');
  if (existsSync(p)) {
    return readFileSync(p, 'utf-8').trim();
  }
  return null;
}

function readMeta(stateDir) {
  const p = join(stateDir, 'server.meta');
  if (existsSync(p)) {
    return JSON.parse(readFileSync(p, 'utf-8'));
  }
  return null;
}

function readToken(stateDir) {
  const p = join(stateDir, 'token');
  if (existsSync(p)) {
    return readFileSync(p, 'utf-8').trim();
  }
  return null;
}

function healthCheck(port, timeout = 2000) {
  return fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(timeout),
  })
    .then((res) => res.json())
    .catch(() => null);
}

// ── Docker helpers (container name: pi-remote-relay) ──────────────────────────

function dockerAvailable() {
  try {
    execSync('docker version --format "{{.Server.Version}}"', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 'running' | 'stopped' | null (no container with that name). */
function dockerContainerState() {
  try {
    const out = execSync(`docker inspect -f '{{.State.Status}}' ${DOCKER_CONTAINER}`, {
      stdio: 'pipe',
      timeout: 5000,
    }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

function dockerCompose(port, ...cmd) {
  const env = { ...process.env, PI_REMOTE_PORT: String(port) };
  return execSync(`docker compose -f ${composeFile} ${cmd.join(' ')}`, {
    stdio: 'pipe',
    timeout: 300000,
    env,
  }).toString();
}

// ── Subcommands ────────────────────────────────────────────────────

async function cmdStart(args) {
  const { port, stateDir } = args;

  // Ensure state dir exists
  mkdirSync(stateDir, { recursive: true });

  // Docker container already running?
  const containerState = dockerContainerState();
  if (containerState === 'running') {
    console.error(`Error: server already running (docker container ${DOCKER_CONTAINER})`);
    process.exit(1);
  }

  // Check if already running
  const existingPid = readPidFile(stateDir);
  if (existingPid) {
    // Probe to see if it's alive
    const health = await healthCheck(port);
    if (health) {
      console.error(`Error: server already running (pid ${existingPid})`);
      process.exit(1);
    }
    // Stale pid file — remove it
    try { unlinkSync(join(stateDir, 'server.pid')); } catch {}
  }

  // Preferred: run in a docker container (state dir mounted → same token).
  if (!args.noDocker && dockerAvailable() && existsSync(composeFile)) {
    try {
      dockerCompose(port, 'up', '-d', '--build');
      let health = null;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        health = await healthCheck(port);
        if (health?.ok) break;
      }
      if (health?.ok) {
        const token = readToken(stateDir);
        console.log(`Pi Remote Control server started (docker: ${DOCKER_CONTAINER}).`);
        console.log(`URL:     ws://localhost:${port}`);
        console.log(`Token:   ${token}`);
        console.log(`State:   ${stateDir} (mounted volume)`);
        console.log(`Log:     docker logs ${DOCKER_CONTAINER}`);
        return;
      }
      console.error(`Error: docker container started but healthz failed. Check: docker logs ${DOCKER_CONTAINER}`);
      process.exit(1);
    } catch (err) {
      console.error(`Error: docker compose failed: ${String(err.message).split('\n')[0]}`);
      console.error('Falling back to bare-metal node process (--no-docker to skip docker entirely).');
    }
  }

  // Spawn detached server
  const logPath = join(stateDir, 'server.log');
  const logFd = openSync(logPath, 'a');
  const logStream = createWriteStream(null, { fd: logFd });

  const child = spawn('node', [serverScript, `--port=${port}`, `--state=${stateDir}`], {
    stdio: ['ignore', logStream, logStream],
    detached: true,
    env: { ...process.env },
  });

  // Unref so the parent can exit without keeping the child alive
  child.unref();

  // Close the log stream after a brief delay so the server can write to it
  setTimeout(() => logStream.end(), 100);

  // Write pid file
  writeFileSync(join(stateDir, 'server.pid'), String(child.pid));
  writeFileSync(join(stateDir, 'server.meta'), JSON.stringify({ port, startedAt: Date.now() }));

  // Wait a moment for the server to start
  await new Promise((r) => setTimeout(r, 500));

  // Verify the daemon process itself is alive. Without this, a pre-existing
  // server on the port lets the health check pass while our child has already
  // died with EADDRINUSE — reporting a phantom "started".
  let childAlive = true;
  try { process.kill(child.pid, 0); } catch { childAlive = false; }
  if (!childAlive) {
    try { unlinkSync(join(stateDir, "server.pid")); } catch {}
    try { unlinkSync(join(stateDir, "server.meta")); } catch {}
    console.error(`Error: server process exited immediately. Port ${port} may already be in use — check ${logPath}`);
    process.exit(1);
  }

  // Verify it's running
  const health = await healthCheck(port);
  if (health && health.ok) {
    const token = readToken(stateDir);
    console.log(`Pi Remote Control server started.`);
    console.log(`URL:     ws://localhost:${port}`);
    console.log(`Token:   ${token}`);
    console.log(`State:   ${stateDir}`);
    console.log(`Log:     ${logPath}`);
  } else {
    // Issue 10: on health check failure, delete pid/meta before exiting
    try { unlinkSync(join(stateDir, 'server.pid')); } catch {}
    try { unlinkSync(join(stateDir, 'server.meta')); } catch {}
    console.error(`Error: server may have failed to start. Check ${logPath}`);
    process.exit(1);
  }
}

async function cmdStatus(args) {
  const { stateDir } = args;

  // Ensure state dir exists (for reading)
  mkdirSync(stateDir, { recursive: true });

  const pid = readPidFile(stateDir);
  const token = readToken(stateDir);
  const meta = readMeta(stateDir);

  const containerState = dockerContainerState();
  let runtime = null;
  if (containerState === 'running') runtime = `docker container ${DOCKER_CONTAINER}`;
  else if (containerState) runtime = `docker container ${DOCKER_CONTAINER} (${containerState})`;

  if (containerState === null && !pid) {
    console.log('Server is not running (no pid file, no docker container).');
    return;
  }

  if (runtime) {
    console.log(`Runtime: ${runtime}`);
  } else if (pid) {
    console.log(`PID: ${pid}`);
  }

  // Issue 9: use stored meta port for display AND healthz probe
  const effectivePort = meta?.port ?? args.port;
  console.log(`Port: ${effectivePort}`);

  const health = await healthCheck(effectivePort);
  if (health) {
    console.log(`Status:   running`);
    console.log(`Uptime: ${health.uptime}s`);
    console.log(`Devices:  ${health.devices} connected`);
  } else {
    console.log(`Status: not responding` + (pid ? ` (pid ${pid} may be stale)` : ''));
  }

  if (token) {
    console.log(`Token:  ${token}`);
  }
}

async function cmdStop(args) {
  const { stateDir } = args;

  // Ensure state dir exists
  mkdirSync(stateDir, { recursive: true });

  // Docker container present (running or stopped)? compose down cleans it up.
  const containerState = dockerContainerState();
  if (containerState !== null) {
    try {
      dockerCompose(args.port, 'down');
    } catch (err) {
      console.error(`docker compose down failed: ${String(err.message).split('\n')[0]}`);
      console.error(`Falling back to: docker rm -f ${DOCKER_CONTAINER}`);
      try { execSync(`docker rm -f ${DOCKER_CONTAINER}`, { stdio: 'pipe', timeout: 30000 }); } catch {}
    }
    try { unlinkSync(join(stateDir, 'server.pid')); } catch {}
    console.log('Server stopped (docker container removed).');
    return;
  }

  const pid = readPidFile(stateDir);
  if (!pid) {
    console.log('Server is not running.');
    return;
  }

  // Issue 11: non-numeric/corrupt pidfile → treat as stale
  const pidNum = parseInt(pid, 10);
  if (!Number.isInteger(pidNum) || pidNum <= 0) {
    console.log(`Removing stale pid file (non-numeric: "${pid}").`);
    try { unlinkSync(join(stateDir, 'server.pid')); } catch {}
    return;
  }

  // Try SIGTERM
  try {
    process.kill(pidNum, 'SIGTERM');
    console.log(`Sent SIGTERM to pid ${pid}.`);
  } catch (e) {
    // Process already gone — treat as stale
    console.log(`PID ${pid} not found, removing stale pid file.`);
    try { unlinkSync(join(stateDir, 'server.pid')); } catch {}
    return;
  }

  // Wait for exit
  let waiterTimer = null;
  let healthTimer = null;
  let exited = false;
  let healthExited = false;
  const waiter = new Promise((resolve) => {
    waiterTimer = setInterval(() => {
      try {
        process.kill(pidNum, 0);
      } catch {
        exited = true;
        clearInterval(waiterTimer);
        waiterTimer = null;
        resolve();
      }
    }, 100);
  });

  // Also wait for health check to fail
  const healthWaiter = new Promise((resolve) => {
    healthTimer = setInterval(() => {
      healthCheck(args.port).then((h) => {
        if (!h) {
          healthExited = true;
          clearInterval(healthTimer);
          healthTimer = null;
          resolve();
        }
      });
    }, 100);
  });

  // Wait up to 5 seconds
  const timeout = new Promise((r) => setTimeout(r, 5000));

  try {
    await Promise.race([waiter, healthWaiter, timeout]);
  } finally {
    // Issue 11: clear both wait intervals in finally
    if (waiterTimer) { clearInterval(waiterTimer); waiterTimer = null; }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  }

  // Clean up pid file
  try { unlinkSync(join(stateDir, 'server.pid')); } catch {}

  console.log('Server stopped.');
}

// ── Main ───────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

if (!args.subcommand) {
  console.error('Usage: node remote/cli.mjs <start|status|stop> [--port N] [--state <dir>] [--no-docker]');
  console.error('start/stop prefer the docker container (remote/docker/) when docker is available.');
  process.exit(1);
}

switch (args.subcommand) {
  case 'start':
    await cmdStart(args);
    break;
  case 'status':
    await cmdStatus(args);
    break;
  case 'stop':
    await cmdStop(args);
    break;
}