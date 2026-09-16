#!/usr/bin/env node
/**
 * pi-self-update.mjs — deterministic steps of the pi self-update pipeline.
 *
 * Runs the exact, non-optional rails of the pi-self-update skill so the agent
 * orchestrates judgment steps (what to commit, conflict resolution, reporting)
 * without re-typing (or skipping) the command sequences.
 *
 * Subcommands (all print one JSON object to stdout; exit 0 = ok, 1 = needs the agent):
 *   snapshot    git status summary (branch, ahead/behind, dirty files, head commit)
 *   sync-node   check node_modules/.pi-lock-hash vs package-lock.json; npm install if stale
 *   pull        git pull --rebase; on conflict exits 1 and lists conflicted files
 *   verify      JSON-validate configs + headless PI-OK + tmux TUI smoke test
 *   push        git push; on rejection: pull --rebase and retry once
 *   update-pi   pi update + pi update --extensions + pi --version (before/after)
 *
 * Deliberately absent (by design): commit, reset --hard, clean -fd,
 * checkout -- . — destructive and judgment-laden operations stay with the agent.
 *
 * Usage: node scripts/pi-self-update.mjs <subcommand>
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT = process.env.PI_AGENT_HOME || join(homedir(), ".pi", "agent");

/** Run a command, capturing combined output. Resolves {code, out} — never throws. */
function run(cmd, args = [], { timeout = 300_000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: AGENT, env: process.env });
    let out = "";
    const on = (s) => (data) => (out += data.toString());
    child.stdout.on("data", on("out"));
    child.stderr.on("data", on("err"));
    if (input != null) child.stdin.write(input);
    child.stdin.end();
    const t = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out: out.trim() });
    });
    child.on("error", (err) => {
      clearTimeout(t);
      resolve({ code: -1, out: `spawn failed: ${err.message}` });
    });
  });
}

function git(args, opts = {}) {
  return run("git", ["-C", AGENT, ...args], opts);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function lockHash() {
  const lock = join(AGENT, "package-lock.json");
  if (!existsSync(lock)) return null;
  return createHash("sha256").update(readFileSync(lock, "utf8")).digest("hex");
}

function markerHash() {
  const m = join(AGENT, "node_modules", ".pi-lock-hash");
  return existsSync(m) ? readFileSync(m, "utf8").trim() : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapshot() {
  const [diff, others, branch, head] = await Promise.all([
    git(["diff", "--name-only", "HEAD"]), // staged + unstaged, one path per line
    git(["ls-files", "--others", "--exclude-standard"]), // untracked, not gitignored
    git(["status", "-sb"]),
    git(["log", "--oneline", "-1"]),
  ]);
  // Note: run() trims combined stdout, so positional parsing of
  // `status --porcelain` lines (" M path") drops a char off the first path.
  // Plumbing commands emit bare paths — no slicing, no trimming trap.
  const modified = diff.out.split("\n").map((l) => l.trim()).filter(Boolean);
  const untracked = others.out.split("\n").map((l) => l.trim()).filter(Boolean);
  const headLine = branch.out.split("\n")[0] || ""; // ## branch...origin/branch [ahead N, behind M]
  emit({
    agentHome: AGENT,
    branch: headLine.replace(/^\s*##\s*/, "").split("...")[0],
    ahead: /ahead (\d+)/.exec(headLine)?.[1] ?? 0,
    behind: /behind (\d+)/.exec(headLine)?.[1] ?? 0,
    modified,
    untracked,
    head: head.out,
    dirty: modified.length > 0 || untracked.length > 0,
  });
}

function writeNpmMarker() {
  const h = lockHash();
  if (!h) return;
  try {
    mkdirSync(join(AGENT, "node_modules"), { recursive: true });
    writeFileSync(join(AGENT, "node_modules", ".pi-lock-hash"), h + "\n");
  } catch {
    /* best effort */
  }
}

async function syncNode() {
  const h = lockHash();
  if (h === null) return emit({ ok: false, error: "no package-lock.json found" });
  const marker = markerHash();
  if (marker === h) return emit({ ok: true, inSync: true, action: "none" });
  const npm = await run("npm", ["install"], { timeout: 600_000 });
  if (npm.code === 0) writeNpmMarker(); // keep node_modules marker in step (same contract as remote-sync)
  const nowSync = markerHash() === lockHash();
  emit({
    ok: nowSync,
    inSync: nowSync,
    action: "npm-install",
    npmExit: npm.code,
    npmOut: npm.out.slice(-1500),
  });
  process.exitCode = nowSync ? 0 : 1;
}

async function verify() {
  const result = { ok: true, json: {}, headless: {}, tmux: {}, crashLog: {} };

  // 1. JSON config validation
  for (const f of ["settings.json", "models.json", "trust.json"]) {
    const p = join(AGENT, f);
    if (!existsSync(p)) {
      result.json[f] = "absent";
      continue;
    }
    try {
      JSON.parse(readFileSync(p, "utf8"));
      result.json[f] = "ok";
    } catch (e) {
      result.json[f] = `BROKEN: ${e.message}`;
      result.ok = false;
    }
  }

  const crashBefore = existsSync(join(AGENT, "pi-crash.log"))
    ? statSync(join(AGENT, "pi-crash.log")).mtimeMs
    : null;

  // 2. Headless check (startup crashes + basic model round-trip)
  const headless = await run("pi", ["-p", "Reply with exactly: PI-OK", "--no-session"], {
    timeout: 180_000,
  });
  result.headless = {
    pass: headless.out.includes("PI-OK"),
    tail: headless.out.slice(-800),
  };
  if (!result.headless.pass) result.ok = false;

  // 3. TUI check via tmux
  const sess = "pi-test-selfupdate";
  await run("tmux", ["kill-session", "-t", sess]); // ignore failure
  await run("tmux", ["new-session", "-d", "-s", sess, "-x", "120", "-y", "40", "pi --no-session"]);
  await sleep(3000);
  let cap = await exec("tmux", ["capture-pane", "-pt", sess]);
  const errorMarkers = ["TypeError", "Cannot find module", "Unhandled promise rejection", "crash"];
  const errorHits = errorMarkers.filter((m) => cap.includes(m));
  await run("tmux", ["send-keys", "-t", sess, "Reply with exactly: PI-OK", "Enter"]);
  // Poll for the reply instead of one fixed sleep — local/slow models vary widely.
  // A reply is its own line; the prompt line contains "Reply with exactly: PI-OK".
  const hasReply = (s) => s.split("\n").some((l) => l.trim() === "PI-OK");
  cap = await exec("tmux", ["capture-pane", "-pt", sess]);
  for (let i = 0; i < 10 && !hasReply(cap); i++) {
    await sleep(3000);
    cap = await exec("tmux", ["capture-pane", "-pt", sess]);
  }
  const alive = (await run("tmux", ["list-sessions"])).out.includes(sess);
  await run("tmux", ["kill-session", "-t", sess]);
  result.tmux = {
    alive,
    errorHits,
    reply: hasReply(cap),
    screenTail: cap.slice(-1200),
  };
  if (!result.tmux.alive || result.tmux.errorHits.length > 0 || !result.tmux.reply) result.ok = false;

  // 4. Crash log freshness
  const crashAfter = existsSync(join(AGENT, "pi-crash.log"))
    ? statSync(join(AGENT, "pi-crash.log")).mtimeMs
    : null;
  result.crashLog = { changed: crashBefore !== null && crashAfter !== crashBefore };
  if (result.crashLog.changed) result.ok = false;

  emit(result);
  process.exitCode = result.ok ? 0 : 1;
}

/** Plain execFile (no -C flag; used for tmux). */
function exec(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, out) => resolve(out ?? ""));
  });
}

async function pull() {
  const p = await git(["pull", "--rebase"], { timeout: 120_000 });
  if (p.code === 0) return emit({ ok: true, out: p.out.slice(-800) });
  const conflicts = await git(["diff", "--name-only", "--diff-filter=U"]);
  const status = await git(["status", "--short"]);
  emit({
    ok: false,
    rebaseInProgress: (await git(["rev-parse", "--git-dir"])).out.includes("rebase"),
    conflicts: conflicts.out.split("\n").filter(Boolean),
    status: status.out,
    out: p.out.slice(-1500),
    hint: "Stop. Show the user the conflicted files and resolve with their help. Never force-pull.",
  });
  process.exitCode = 1;
}

async function push() {
  const p = await git(["push"], { timeout: 120_000 });
  if (p.code === 0) return emit({ ok: true, out: p.out.slice(-800) });
  // Rejection: rebase on remote and retry once. Never force-push.
  const pr = await git(["pull", "--rebase"], { timeout: 120_000 });
  if (pr.code !== 0) {
    const conflicts = await git(["diff", "--name-only", "--diff-filter=U"]);
    return emit({ ok: false, out: p.out.slice(-800), rebaseOut: pr.out.slice(-800), conflicts: conflicts.out.split("\n").filter(Boolean) });
  }
  const p2 = await git(["push"], { timeout: 120_000 });
  emit({ ok: p2.code === 0, retriedAfterRebase: true, out: p2.out.slice(-800) });
  if (p2.code !== 0) process.exitCode = 1;
}

async function updatePi() {
  const before = (await run("pi", ["--version"])).out;
  const u = await run("pi", ["update"], { timeout: 300_000 });
  const e = await run("pi", ["update", "--extensions"], { timeout: 600_000 });
  const after = (await run("pi", ["--version"])).out;
  emit({
    ok: u.code === 0 && e.code === 0,
    before,
    after,
    changed: before !== after,
    majorBump: /^(v)?\d+/.exec(before)?.[0]?.replace("v", "") !== /^(v)?\d+/.exec(after)?.[0]?.replace("v", ""),
    updateOut: u.out.slice(-1000),
    extensionsOut: e.out.slice(-1500),
    note: "Running sessions keep the old binary/packages until restart.",
  });
  if (u.code !== 0 || e.code !== 0) process.exitCode = 1;
}

const cmds = { snapshot, "sync-node": syncNode, verify, pull, push, "update-pi": updatePi };
const cmd = process.argv[2];
if (!cmd || !cmds[cmd]) {
  console.error(`usage: node scripts/pi-self-update.mjs <${Object.keys(cmds).join("|")}>`);
  process.exit(2);
}
await cmds[cmd]();
