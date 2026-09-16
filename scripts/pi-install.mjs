#!/usr/bin/env node
/**
 * pi-install.mjs — post-clone bootstrap for the public pi agent home (pi-home).
 *
 * Runs inside the checkout it lives in (~/.pi/agent after install.sh clones).
 * Idempotent: safe to re-run as a repair/refresh. Every step prints
 * [ok]/[skip]/[warn]/[dry]/[fail] lines; exit 0 unless a step failed.
 *
 * Usage:
 *   node scripts/pi-install.mjs                 # from inside ~/.pi/agent
 *   node scripts/pi-install.mjs --dry-run       # print the plan, change nothing
 *   node scripts/pi-install.mjs --non-interactive  # never prompt (keep placeholders)
 *   node scripts/pi-install.mjs --skip-verify   # skip the headless pi smoke test
 *   node scripts/pi-install.mjs --skip-npm      # skip `npm install` (offline scratch tests)
 *
 * Steps:
 *   preflight  node >= 22, npm, git
 *   deps       npm install + node_modules/.pi-lock-hash marker (sha256 of
 *              package-lock.json — same contract as scripts/pi-self-update.mjs)
 *   npmrc      npm/.npmrc -> allow-remote=all (npm 12+ needs it for pi update --extensions)
 *   configs    settings.json.dist -> settings.json, mcp.json.dist -> mcp.json (never overwrite)
 *   prompts    TTY-only (or piped stdin): fill <MODEL_HOST>, <SEARXNG_HOST>,
 *              CHANGE_ME (mcp.json), remoteControl block (settings.json).
 *              Empty answer = keep placeholder. remoteControl block is deleted
 *              when fully skipped/non-interactive.
 *   verify     pi -p "Reply with exactly: PI-OK" --no-session from $HOME, 180s
 *              — report-only (warn, never fail: model server may be off-LAN)
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, fstatSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT = resolve(SCRIPT_DIR, ".."); // the checkout this script lives in

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (!["--dry-run", "--non-interactive", "--skip-verify", "--skip-npm"].includes(args[i])) {
    console.error(`pi-install: unknown flag: ${args[i]}`);
    process.exit(1);
  }
}
const DRY = args.includes("--dry-run");
const NON_INTERACTIVE = args.includes("--non-interactive");
const SKIP_VERIFY = args.includes("--skip-verify");
const SKIP_NPM = args.includes("--skip-npm");

const results = [];
function log(step, status, msg) {
  results.push({ step, status });
  console.log(`[${status}] ${step}: ${msg}`);
}
function run(cmd, cmdArgs = [], { cwd = AGENT, timeout = 600_000 } = {}) {
  return new Promise((res) => {
    const child = spawn(cmd, cmdArgs, { cwd });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code) => { clearTimeout(t); res({ code: code ?? -1, out: out.trim() }); });
    child.on("error", (err) => { clearTimeout(t); res({ code: -1, out: err.message }); });
  });
}
const has = (cmd) => run(cmd, ["--version"], { cwd: homedir(), timeout: 30_000 });

// ---- prompting ------------------------------------------------------------

function stdinKind() {
  if (process.stdin.isTTY) return "tty";
  try {
    const st = fstatSync(0);
    if (st.isFIFO()) return "pipe";       // printf 'a\nb\n' | node pi-install.mjs
    if (st.isFile()) return "file";       // node pi-install.mjs < answers.txt
    if (st.isCharacterDevice()) return "none"; // /dev/null etc. — nothing to read
    return "none";
  } catch {
    return "none";
  }
}
const STDIN = stdinKind();
const CAN_PROMPT = !DRY && !NON_INTERACTIVE && STDIN !== "none";

// Line-queue stdin reader: works on a TTY (cooked mode echoes input) and on
// piped/redirected stdin (all buffered lines are delivered, EOF -> "").
// node:readline's question() loses lines after the first when input arrives in
// one chunk, so we do not use it.
class LineReader {
  constructor() { this.partial = ""; this.queue = []; this.waiters = []; this.started = false; this.ended = false; }
  start() {
    if (this.started) return;
    this.started = true;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      this.partial += d;
      let i;
      while ((i = this.partial.indexOf("\n")) >= 0) {
        const line = this.partial.slice(0, i);
        this.partial = this.partial.slice(i + 1);
        this.deliver(line);
      }
    });
    const end = () => { const rest = this.partial; this.partial = ""; this.ended = true; this.deliver(rest); };
    process.stdin.on("end", end);
    process.stdin.on("close", end);
    process.stdin.on("error", () => { this.ended = true; for (const w of this.waiters.splice(0)) w(""); });
  }
  deliver(line) {
    const w = this.waiters.shift();
    if (w) w(line);
    else this.queue.push(line);
  }
  async read() {
    this.start();
    if (this.queue.length) return this.queue.shift();
    if (this.ended) return "";
    return new Promise((res) => this.waiters.push(res));
  }
}
const lines = new LineReader();
async function ask(question) {
  if (!CAN_PROMPT) return "";
  try {
    process.stdout.write(question);
    const a = await lines.read();
    return (a || "").trim();
  } catch {
    return ""; // stdin error — treat as "keep placeholder"
  }
}

/** Replace every occurrence of `token` in a file. Returns 'missing' | 'clean' | count. */
function replaceInFile(file, token, value) {
  if (!existsSync(file)) return "missing";
  const text = readFileSync(file, "utf8");
  if (!text.includes(token)) return "clean";
  const count = text.split(token).length - 1;
  if (!DRY) writeFileSync(file, text.split(token).join(value));
  return count;
}

/**
 * Fill a placeholder token across candidate files, prompting once if needed.
 * mode: 'prompt' (ask when placeholders found) | 'skip' (never ask; report only)
 *       | 'dry' (print plan)
 */
async function fillToken(step, token, files, question, mode) {
  const present = [];
  for (const f of files) {
    if (existsSync(f) && readFileSync(f, "utf8").includes(token)) present.push(f);
  }
  if (!present.length) return log(step, "skip", `no ${token} placeholders in ${files.map(short).join(", ")}`);
  if (mode === "dry") {
    return log(step, "dry", `would prompt for ${token} (${present.map(short).join(", ")})`);
  }
  const answer = mode === "prompt" ? await ask(question) : "";
  if (!answer) {
    return log(step, "warn", `${token} left as placeholder in ${present.map(short).join(", ")} — edit by hand later`);
  }
  let n = 0;
  for (const f of present) {
    const r = replaceInFile(f, token, answer);
    if (typeof r === "number") n += r;
  }
  log(step, "ok", `replaced ${token} -> ${answer} in ${present.map(short).join(", ")} (${n} occurrence(s))`);
}
const short = (p) => p.startsWith(AGENT + "/") ? p.slice(AGENT.length + 1) : p;

// ---- steps ----------------------------------------------------------------

async function preflight() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) log("preflight", "ok", `node ${process.version}`);
  else log("preflight", "fail", `node ${process.version} — need >= 22 (use nvm: nvm install 22 && nvm use 22)`);
  const npm = await has("npm");
  npm.code === 0 ? log("preflight", "ok", `npm ${npm.out.split("\n")[0]}`) : log("preflight", "fail", "npm not found");
  const git = await has("git");
  git.code === 0 ? log("preflight", "ok", "git present") : log("preflight", "fail", "git not found");
}

async function deps() {
  const lock = join(AGENT, "package-lock.json");
  if (!existsSync(lock)) return log("deps", "fail", "no package-lock.json — is this the repo checkout?");
  const h = createHash("sha256").update(readFileSync(lock, "utf8")).digest("hex");
  const marker = join(AGENT, "node_modules", ".pi-lock-hash");
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === h) {
    return log("deps", "skip", "node_modules in sync with package-lock.json");
  }
  if (SKIP_NPM) return log("deps", "skip", "--skip-npm (node_modules not installed)");
  if (DRY) return log("deps", "dry", "would run npm install + write node_modules/.pi-lock-hash marker");
  const r = await run("npm", ["install"], { cwd: AGENT });
  if (r.code !== 0) return log("deps", "fail", `npm install failed: ${r.out.split("\n").slice(-3).join(" | ")}`);
  // npm may normalize package-lock.json during install — hash the CURRENT file
  // so the marker matches what remote-sync.ts / pi-self-update compare against.
  const hAfter = createHash("sha256").update(readFileSync(lock, "utf8")).digest("hex");
  mkdirSync(join(AGENT, "node_modules"), { recursive: true });
  writeFileSync(marker, hAfter + "\n");
  log("deps", "ok", "npm install done, marker written (effect/ws for subagent + background-terminals extensions)");
}

async function npmrc() {
  const f = join(AGENT, "npm", ".npmrc");
  if (existsSync(f) && readFileSync(f, "utf8").includes("allow-remote")) {
    return log("npmrc", "skip", "npm/.npmrc already has allow-remote");
  }
  if (DRY) return log("npmrc", "dry", `would write ${short(f)} (allow-remote=all)`);
  mkdirSync(join(AGENT, "npm"), { recursive: true });
  writeFileSync(f, "allow-remote=all\n");
  log("npmrc", "ok", "wrote npm/.npmrc (allow-remote=all; needed by pi update --extensions on npm 12+)");
}

async function configs() {
  for (const [dist, live] of [["settings.json.dist", "settings.json"], ["mcp.json.dist", "mcp.json"]]) {
    const src = join(AGENT, dist), dst = join(AGENT, live);
    if (existsSync(dst)) {
      log("configs", "skip", `${live} exists (untouched)`);
    } else if (!existsSync(src)) {
      log("configs", "warn", `${dist} not found — cannot create ${live}`);
    } else if (DRY) {
      log("configs", "dry", `would create ${live} from ${dist}`);
    } else {
      writeFileSync(dst, readFileSync(src, "utf8"));
      log("configs", "ok", `${live} created from ${dist}`);
    }
  }
}

async function prompts() {
  const F = {
    models: join(AGENT, "models.json"),
    settings: join(AGENT, "settings.json"),
    websearch: join(AGENT, "web-search.json"),
    agents: join(AGENT, "AGENTS.md"),
    mcp: join(AGENT, "mcp.json"),
  };
  const mode = DRY ? "dry" : CAN_PROMPT ? "prompt" : "skip";
  if (mode === "prompt" && STDIN !== "tty") log("prompts", "warn", `reading answers from piped ${STDIN} stdin (EOF/missing line = keep placeholder)`);

  // 1. MODEL_HOST — llama-server / OpenAI-compatible host
  await fillToken(
    "model-host", "<MODEL_HOST>", [F.models, F.settings],
    "MODEL_HOST — host of your model server, e.g. <LAN_HOST> or mybox.local (Enter = keep placeholder): ",
    mode,
  );

  // 2. SEARXNG_HOST — self-hosted SearXNG instance
  await fillToken(
    "searxng", "<SEARXNG_HOST>", [F.websearch, F.agents],
    "SEARXNG_HOST — host of your self-hosted SearXNG, e.g. <LAN_HOST> (Enter = keep placeholder): ",
    mode,
  );

  // 3. MCP bearer token (optional)
  await fillToken(
    "mcp-token", "CHANGE_ME", [F.mcp],
    "Optional: bearer token for the n8n MCP server in mcp.json (Enter = keep CHANGE_ME): ",
    mode,
  );

  // 4. remoteControl block in settings.json (optional)
  await remoteControl(F.settings, mode);
}

function rcHasPlaceholder(rc) {
  return rc && typeof rc === "object" && JSON.stringify(rc).includes("<");
}

async function remoteControl(settingsFile, mode) {
  if (!existsSync(settingsFile)) return log("remote-control", "skip", "settings.json not present");
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(settingsFile, "utf8"));
  } catch (e) {
    return log("remote-control", "warn", `settings.json is not valid JSON (${e.message}) — left untouched`);
  }
  if (!("remoteControl" in cfg)) return log("remote-control", "skip", "no remoteControl block");
  if (!rcHasPlaceholder(cfg.remoteControl)) return log("remote-control", "skip", "already configured (untouched)");

  if (mode === "dry") {
    return log("remote-control", "dry", "would prompt for remoteControl server host + token; if skipped, the placeholder block is deleted");
  }

  let host = "", token = "";
  if (mode === "prompt") {
    host = await ask("remoteControl server host for phone-home, e.g. <LAN_HOST> (Enter = skip): ");
    token = await ask("remoteControl token (from `pi remote status` on the server; Enter = skip): ");
  }
  const rc = cfg.remoteControl;
  if (host) rc.url = /^wss?:\/\//.test(host) ? host : rc.url.replace("<server-host>", host);
  if (token) rc.token = token;
  if ((host || token) && typeof rc.name === "string" && rc.name.includes("<")) rc.name = hostname();

  if (!host && !token) {
    if (DRY) return log("remote-control", "dry", "would delete the placeholder remoteControl block");
    delete cfg.remoteControl;
    writeFileSync(settingsFile, JSON.stringify(cfg, null, 2) + "\n");
    return log("remote-control", "ok", "placeholder remoteControl block removed (add it back later to phone home; see README)");
  }
  if (DRY) return log("remote-control", "dry", "would fill the remoteControl block in settings.json");
  writeFileSync(settingsFile, JSON.stringify(cfg, null, 2) + "\n");
  const leftover = rcHasPlaceholder(cfg.remoteControl);
  log("remote-control", leftover ? "warn" : "ok",
    leftover ? "remoteControl partially filled — placeholders remain, pi remote-control will not connect until completed"
             : "remoteControl block configured");
}

async function verify() {
  if (SKIP_VERIFY) return log("verify", "skip", "--skip-verify");
  if (DRY) return log("verify", "dry", 'would run: pi -p "Reply with exactly: PI-OK" --no-session (report-only, 180s)');
  const p = await has("pi");
  if (p.code !== 0) return log("verify", "warn", "pi not on PATH — smoke test skipped (install: npm install -g @earendil-works/pi-coding-agent)");
  const r = await run("pi", ["-p", "Reply with exactly: PI-OK", "--no-session"], {
    cwd: homedir(), timeout: 180_000,
  });
  if (r.code === 0 && r.out.includes("PI-OK")) log("verify", "ok", "headless smoke test passed");
  else log("verify", "warn", `smoke test did not pass (code ${r.code}): ${r.out.split("\n").slice(-2).join(" | ") || "(no output)"} — expected if the model host is unreachable or not logged in yet`);
}

function manualSteps() {
  const left = [];
  const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  if (read(join(AGENT, "models.json")).includes("<MODEL_HOST>") || read(join(AGENT, "settings.json")).includes("<MODEL_HOST>"))
    left.push("models.json/settings.json still contain <MODEL_HOST> — set your model server host");
  if (read(join(AGENT, "web-search.json")).includes("<SEARXNG_HOST>"))
    left.push("web-search.json still contains <SEARXNG_HOST> — set your SearXNG host (or delete the file to disable web search)");
  if (read(join(AGENT, "mcp.json")).includes("CHANGE_ME"))
    left.push("mcp.json still contains CHANGE_ME — fill credentials or remove those servers");
  if (read(join(AGENT, "mcp.json")).includes("<N8N_HOST>"))
    left.push("mcp.json still contains <N8N_HOST> — set your n8n host or remove the n8n server entry");
  console.log("\nRemaining manual steps:");
  console.log("  - run `pi` and use /login to authenticate any cloud provider you enabled");
  console.log("  - trust.json / auth.json are created automatically on first launch");
  if (left.length) left.forEach((s, i) => console.log(`  - ${s}`));
  else console.log("  - none detected — placeholders all resolved");
}

// ---- main -----------------------------------------------------------------

console.log(`pi-install${DRY ? " (dry run)" : ""} — agent home: ${AGENT}`);
if (!DRY && !NON_INTERACTIVE && STDIN === "none") log("prompts", "skip", "no interactive stdin — placeholders kept (use --non-interactive to silence)");

await preflight();
if (results.some((r) => r.step === "preflight" && r.status === "fail")) {
  console.log("\npreflight failed — fix prerequisites and re-run.");
  process.exit(1);
}
await deps();
await npmrc();
await configs();
await prompts();
await verify();

const fails = results.filter((r) => r.status === "fail");
const warns = results.filter((r) => r.status === "warn");
if (!DRY) manualSteps();
console.log(`\n${fails.length ? `${fails.length} failed` : "done"}${warns.length ? `, ${warns.length} warning(s)` : ""}.`);
process.exit(fails.length ? 1 : 0);
