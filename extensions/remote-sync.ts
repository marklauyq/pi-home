/**
 * Remote Sync Extension
 *
 * Checks whether the pi agent home repo (~/.pi/agent) has new commits on its
 * remote upstream branch and asks (via confirm dialog) whether to pull.
 * Always the agent home — never the current working directory.
 *
 * Triggers:
 * - session_start (reason "startup", when the agent home is a git repo with an upstream)
 * - /pull-check — manual check (always prompts, even if previously rejected)
 *
 * Safety:
 * - Uses non-blocking git (child_process promises) so the TUI never freezes.
 * - Pull is `--ff-only` when local has no ahead-commits; diverged repos are
 *   left for manual resolution with a warning.
 * - A rejected remote SHA is remembered (in ~/.pi/agent/.remote-pull-dismissed.json)
 *   so the same tip is not nagged again; a newer commit re-triggers the prompt.
 *
 * npm sync: keeps the machine-local node_modules in step with the committed
 * package-lock.json via a hash marker (node_modules/.pi-lock-hash). The pull
 * dialog notes when an `npm install` will follow, runs it after a successful
 * pull, and nags (startup + /pull-check) while the tree is stale.
 *
 * dist drift: committed `*.dist` templates are gitignored-live-file templates
 * (e.g. settings.json.dist → settings.json). On every check, the template is
 * deep-diffed against the machine-local live file and key-presence drift is
 * reported: keys in dist but missing locally, and local-only keys. Values are
 * never compared — only structure (auth-related keys are skipped entirely,
 * since they are machine-specific).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DISMISSED_FILE = join(homedir(), ".pi", "agent", ".remote-pull-dismissed.json");
const AGENT_HOME = join(homedir(), ".pi", "agent");
const GIT_TIMEOUT_MS = 20_000;
const NPM_TIMEOUT_MS = 300_000;

// --- npm freshness: node_modules must match the committed package-lock.json ---
// A machine-local marker (node_modules/.pi-lock-hash) holds the sha256 of the
// lockfile as last installed. Stale = marker missing or different, which is
// exactly the post-pull / fresh-clone state where `npm install` is required.

function lockHash(cwd: string): string | null {
  try {
    return createHash("sha256")
      .update(readFileSync(join(cwd, "package-lock.json"), "utf8"))
      .digest("hex");
  } catch {
    return null;
  }
}

function npmStale(cwd: string): boolean {
  if (!existsSync(join(cwd, "package.json"))) return false;
  const h = lockHash(cwd);
  if (h === null) return true; // manifest present but no lockfile yet
  try {
    return readFileSync(join(cwd, "node_modules", ".pi-lock-hash"), "utf8").trim() !== h;
  } catch {
    return true;
  }
}

function writeNpmMarker(cwd: string): void {
  const h = lockHash(cwd);
  if (!h) return;
  try {
    writeFileSync(join(cwd, "node_modules", ".pi-lock-hash"), h + "\n");
  } catch {
    /* best effort */
  }
}

async function npmInstall(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd,
      timeout: NPM_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
  return stdout.trim();
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

interface RemoteState {
  remote: string; // e.g. "origin"
  branch: string; // e.g. "main"
  upstream: string; // e.g. "origin/main"
  ahead: number; // local-only commits
  behind: number; // remote-only commits
  sha: string; // remote tip SHA (after fetch)
  dirty: boolean; // uncommitted changes
}

async function checkRemote(cwd: string): Promise<RemoteState | null> {
  if (!(await tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]))) return null;

  const branch = await tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") return null; // detached

  const upstream = await tryGit(cwd, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (!upstream) return null; // no upstream tracking branch

  const fetchOut = await tryGit(cwd, ["fetch", "--quiet", upstream.split("/").slice(0, -1)[0], upstream.split("/").slice(-1)[0]]);
  if (fetchOut === null && !await tryGit(cwd, ["fetch", "--quiet"])) return null;

  const [ahead, behind] = (
    (await git(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])) ?? "0\t0"
  )
    .split(/\s+/)
    .map(Number);
  const sha = await git(cwd, ["rev-parse", "@{u}"]);
  const status = await git(cwd, ["status", "--porcelain"]);

  return {
    remote: upstream.split("/")[0] ?? "origin",
    branch,
    upstream,
    ahead,
    behind,
    sha,
    dirty: status.length > 0,
  };
}

function loadDismissed(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(DISMISSED_FILE, "utf-8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function dismissSha(sha: string): void {
  const state = loadDismissed();
  state[sha] = Date.now();
  try {
    mkdirSync(dirname(DISMISSED_FILE), { recursive: true });
    writeFileSync(DISMISSED_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* best effort */
  }
}

// --- dist drift: committed *.dist templates vs their machine-local live files ---

function isAuthKey(k: string): boolean {
  return /auth/i.test(k);
}

function diffKeys(dist: Record<string, unknown>, live: Record<string, unknown>, prefix: string, out: string[]): void {
  const keys = [...new Set([...Object.keys(dist), ...Object.keys(live)])];
  for (const k of keys) {
    if (isAuthKey(k)) continue; // auth material is machine-specific, never drift
    const p = prefix ? `${prefix}.${k}` : k;
    if (!(k in live)) {
      out.push(`+ ${p} (in dist, missing locally)`);
    } else if (!(k in dist)) {
      out.push(`- ${p} (local only, not in dist)`);
    } else {
      const d = dist[k];
      const l = live[k];
      if (
        d !== null && l !== null &&
        typeof d === "object" && typeof l === "object" &&
        !Array.isArray(d) && !Array.isArray(l)
      ) {
        diffKeys(d as Record<string, unknown>, l as Record<string, unknown>, p, out);
      }
      // leaf values and arrays are never compared — key presence only
    }
  }
}

export async function distDrift(cwd: string): Promise<string[]> {
  const tracked = await tryGit(cwd, ["ls-files", "*.dist"]);
  if (tracked === null) return [];
  const msgs: string[] = [];
  for (const rel of tracked.split("\n")) {
    if (!rel || !rel.endsWith(".dist")) continue;
    const liveRel = rel.slice(0, -".dist".length);
    let distJson: Record<string, unknown>;
    let liveJson: Record<string, unknown>;
    try {
      distJson = JSON.parse(readFileSync(join(cwd, rel), "utf8"));
      liveJson = JSON.parse(readFileSync(join(cwd, liveRel), "utf8"));
    } catch {
      continue; // live file missing or not plain JSON — nothing to compare
    }
    if (typeof distJson !== "object" || distJson === null || typeof liveJson !== "object" || liveJson === null) continue;
    const diffs: string[] = [];
    diffKeys(distJson, liveJson, "", diffs);
    for (const d of diffs) msgs.push(`${liveRel}: ${d}`);
  }
  return msgs;
}

async function runCheck(ctx: ExtensionContext, manual: boolean): Promise<void> {
  if (!ctx.hasUI) return;

  ctx.ui.setStatus("remote-sync", "Checking remote…");
  const [st, drift] = await Promise.all([checkRemote(AGENT_HOME), distDrift(AGENT_HOME)]);
  ctx.ui.setStatus("remote-sync", undefined);
  if (drift.length > 0) {
    ctx.ui.notify(
      `dist drift in ${AGENT_HOME} (${drift.length}):\n` + drift.join("\n"),
      "warning",
    );
  }
  if (!st) return;

  if (st.behind === 0) {
    if (npmStale(AGENT_HOME)) {
      ctx.ui.notify(
        `npm dependencies are out of sync — run: cd ${AGENT_HOME} && npm install`,
        "info",
      );
    }
    if (manual) ctx.ui.notify(`${st.upstream} is up to date.`, "info");
    return;
  }

  if (!manual && loadDismissed()[st.sha]) {
    if (manual) ctx.ui.notify("Already dismissed.", "info");
    return; // previously rejected this exact remote tip
  }

  const details: string[] = [
    `${st.branch} is ${st.behind} commit${st.behind === 1 ? "" : "s"} behind ${st.upstream}`,
  ];
  if (st.ahead > 0) details.push(`Local is also ${st.ahead} commit${st.ahead === 1 ? "" : "s"} ahead (pull will need a merge).`);
  if (st.dirty) details.push("Working tree has uncommitted changes.");
  if (npmStale(AGENT_HOME)) details.push("npm dependencies are out of sync — npm install will run after the pull.");

  const ok = await ctx.ui.confirm(`Pull from ${st.remote}?`, details.join("\n"));
  if (!ok) {
    dismissSha(st.sha);
    ctx.ui.notify("Pull skipped.", "info");
    return;
  }

  const ff = st.ahead === 0;
  ctx.ui.setStatus("remote-sync", "Pulling…");
  const result = await tryGit(AGENT_HOME, ["pull", "--ff-only", st.remote, st.branch].filter((a) => a));
  const merged = result === null && ff ? await tryGit(AGENT_HOME, ["pull", st.remote, st.branch]) : null;
  const out = result ?? merged;
  ctx.ui.setStatus("remote-sync", undefined);

  if (out === null) {
    ctx.ui.notify(
      "Pull failed (likely diverged or dirty tree). Resolve manually: git pull",
      "error",
    );
    return;
  }
  ctx.ui.notify(`Pulled ${st.behind} commit${st.behind === 1 ? "" : "s"} from ${st.upstream}.`, "info");

  // Keep the local tree in sync with the pulled lockfile (new deps, version bumps).
  if (npmStale(AGENT_HOME)) {
    ctx.ui.setStatus("remote-sync", "npm install…");
    const ok = await npmInstall(AGENT_HOME);
    ctx.ui.setStatus("remote-sync", undefined);
    if (ok) {
      writeNpmMarker(AGENT_HOME);
      ctx.ui.notify("npm install completed.", "info");
    } else {
      ctx.ui.notify(
        "npm install failed — run manually: cd " + AGENT_HOME + " && npm install",
        "error",
      );
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") return;
    void runCheck(ctx, false);
  });

  pi.registerCommand("pull-check", {
    description: "Check the pi agent repo (~/.pi/agent) for new commits and offer to pull",
    handler: async (_args, ctx) => {
      await runCheck(ctx, true);
    },
  });
}
