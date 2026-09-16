/**
 * Git Branch Extension - shows the current git branch name and machine name in the footer status bar.
 *
 * On session_start, it reads the current branch from `git rev-parse --abbrev-ref HEAD`
 * and displays it alongside the hostname. It also updates on agent_start to catch
 * directory switches during a session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import os from "os";

function getBranch(cwd: string): string | null {
  try {
    const { execSync } = require("child_process") as typeof import("child_process");
    const output = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    return output;
  } catch {
    return null;
  }
}

function renderBranch(cwd: string): string {
  const branch = getBranch(cwd);
  const host = os.hostname().replace(/\.local$/i, "");
  if (!branch || branch === "HEAD") return host ? `@ ${host}` : ""; // detached HEAD
  return `git: ${branch} @ ${host}`;
}

export default function (pi: ExtensionAPI) {
  // Set the branch on session start
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("git-branch", renderBranch(ctx.cwd));
  });

  // Update when agent starts (in case cwd changed)
  pi.on("agent_start", (_event, ctx) => {
    ctx.ui.setStatus("git-branch", renderBranch(ctx.cwd));
  });
} // git-branch extension
