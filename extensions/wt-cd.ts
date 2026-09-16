/**
 * wt-cd — move this session into a git worktree of the current repo.
 *
 * `/wt` opens a picker listing ALL worktrees of the git repo that contains
 * the session's current working directory (main checkout included, so you
 * can switch back). Selecting an entry:
 *   1. forks the current session file into a NEW session file whose cwd is
 *      the selected worktree (SessionManager.forkFrom),
 *   2. switches the live TUI to it (ctx.switchSession).
 *
 * The original session file is untouched and stays resumable — each cwd's
 * conversation history lives with that cwd, forking at the switch point.
 * Stale (prunable) worktrees are shown greyed out and cannot be selected.
 *
 * User-triggered only: the agent cannot relocate the session itself.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);

interface WorktreeEntry {
	path: string;
	branch: string | "detached";
	prunable: boolean;
}

async function listWorktrees(cwd: string): Promise<WorktreeEntry[] | null> {
	let out: string;
	try {
		({ stdout: out } = await execFileAsync("git", ["-C", cwd, "worktree", "list", "--porcelain"]));
	} catch {
		return null; // not a git repo (or git missing)
	}
	const entries: WorktreeEntry[] = [];
	for (const block of out.split(/\n\n+/)) {
		const lines = block.split("\n").filter(Boolean);
		let path: string | undefined;
		let branch: string | "detached" = "detached";
		let prunable = false;
		for (const line of lines) {
			if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
			else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
			else if (line.startsWith("prunable")) prunable = true;
		}
		if (path) entries.push({ path, branch, prunable });
	}
	return entries.length > 0 ? entries : null;
}

function shorten(p: string, home: string): string {
	return home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

export default function wtCd(pi: ExtensionAPI) {
	pi.registerCommand("wt", {
		description: "Switch this session into a git worktree of the current repo: /wt",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("wt: interactive TUI required", "error");
				return;
			}
			const cwd = resolve(ctx.cwd);
			const entries = await listWorktrees(cwd);
			if (!entries) {
				ctx.ui.notify("wt: current directory is not in a git repo with worktrees.", "error");
				return;
			}
			if (entries.length === 1) {
				ctx.ui.notify("wt: only the main checkout exists. Ask the agent to create a worktree first.", "info");
				return;
			}

			// Entry containing the current session cwd is "here" (may be a subdir).
			// Worktrees can be nested inside other worktrees' dirs (e.g. .worktrees/),
			// so pick the MOST SPECIFIC (longest path) match, not the first.
			const currentPath = entries
				.filter((e) => cwd === e.path || cwd.startsWith(e.path + "/"))
				.sort((a, b) => b.path.length - a.path.length)[0]?.path;

			const result = await ctx.ui.custom<{ index: number } | null>((_tui, theme, _kb, done) => {
				const home = process.env.HOME ?? "";
				let selected = 0;
				let cached: string[] | undefined;

				function selectableIndexes(): number[] {
					return entries.map((e, i) => (e.prunable ? -1 : i)).filter((i) => i >= 0);
				}

				function handleInput(data: string) {
					const sel = selectableIndexes();
					if (sel.length === 0) return;
					if (matchesKey(data, Key.up)) {
						const cur = sel.indexOf(selected);
						selected = sel[(cur - 1 + sel.length) % sel.length];
						cached = undefined;
						return;
					}
					if (matchesKey(data, Key.down)) {
						const cur = sel.indexOf(selected);
						selected = sel[(cur + 1) % sel.length];
						cached = undefined;
						return;
					}
					if (matchesKey(data, Key.enter)) {
						done(entries[selected].prunable ? null : { index: selected });
						return;
					}
					if (matchesKey(data, Key.escape)) done(null);
				}

				function render(width: number): string[] {
					if (cached) return cached;
					const w = Math.max(1, width);
					const lines: string[] = [];
					lines.push(theme.fg("accent", "─".repeat(w)));
					lines.push(theme.fg("text", theme.bold(" Worktrees — current repo")));
					lines.push("");
					entries.forEach((e, i) => {
						const isHere = e.path === currentPath;
						const isSelected = i === selected;
						const prefix = isSelected && !e.prunable ? theme.fg("accent", "> ") : "  ";
						const label = shorten(e.path, home);
						const meta: string[] = [];
						if (e.branch !== "detached") meta.push(theme.fg("muted", `[${e.branch}]`));
						if (isHere) meta.push(theme.fg("accent", "← here"));
						if (e.prunable) meta.push(theme.fg("dim", "(stale — git worktree prune)"));
						const metaStr = meta.length ? "  " + meta.join("  ") : "";
						const color = e.prunable ? "dim" : isSelected ? "accent" : "text";
						const avail = Math.max(10, w - visibleWidth(prefix) - visibleWidth(metaStr) - 1);
						const shown = visibleWidth(label) > avail ? "…" + label.slice(-(avail - 1)) : label;
						lines.push(prefix + theme.fg(color, shown) + metaStr);
					});
					lines.push("");
					lines.push(theme.fg("dim", "↑↓ select • Enter switch session into worktree • Esc cancel"));
					lines.push(theme.fg("accent", "─".repeat(w)));
					cached = lines;
					return lines;
				}

				return {
					render,
					handleInput,
					invalidate: () => {
						cached = undefined;
					},
				};
			});

			if (!result) return; // Esc, or Enter on a stale entry
			const target = entries[result.index];
			if (target.path === currentPath) {
				ctx.ui.notify("Already in that worktree.", "info");
				return;
			}

			// Fork this session's file into a new session file whose cwd is the
			// worktree, then switch the live session to it. The original
			// session file is untouched and stays resumable.
			const sourceFile = ctx.sessionManager.getSessionFile();
			if (!sourceFile) {
				ctx.ui.notify("wt: current session has no session file (ephemeral session?).", "error");
				return;
			}
			let forked: SessionManager;
			try {
				forked = SessionManager.forkFrom(sourceFile, resolve(target.path));
			} catch (err: any) {
				ctx.ui.notify(`wt: fork failed: ${err?.message ?? err}`, "error");
				return;
			}
			const forkedPath = forked.getSessionFile();
			if (!forkedPath) {
				ctx.ui.notify("wt: forked session has no file path.", "error");
				return;
			}
			const { cancelled } = await ctx.switchSession(forkedPath, {
				withSession: (nctx) => {
					nctx.sendMessage(
						{
							customType: "wt-cd",
							display: true,
							content: `Moved into worktree: ${target.path}${target.branch !== "detached" ? ` (branch ${target.branch})` : ""}. Session forked — original preserved.`,
						},
						{ triggerTurn: false },
					);
				},
			});
			if (cancelled) {
				ctx.ui.notify("wt: switch cancelled.", "info");
			}
		},
	});
}
