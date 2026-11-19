/**
 * Session Scrubber — agent-judged, on-demand redaction of session transcripts.
 *
 * Design: the agent (or the user) decides what is sensitive; this extension is
 * only the janitor. NO hooks, NO per-event work, NO rule engine running live.
 *
 * - `scrub_sessions` tool — the agent passes literal secrets and/or regexes;
 *   every *.jsonl under the target (default: the whole sessions tree) is
 *   rewritten in place. The pass also erases THIS tool call's own arguments
 *   from the transcript (they contain the secrets), so the file ends clean.
 *   The live model context still holds the values until /new — the tool says so.
 * - `/scrub [path]`       — user-driven: masked TUI prompt for the secret
 *   (never rendered, never enters any transcript), dry-run count, confirm, apply.
 *
 * In-place rewrite preserves the file inode (open r+b + truncate), so the
 * CURRENT live session keeps appending correctly while being scrubbed.
 *
 * Secrets are never echoed in tool results, TUI rendering, or notifications.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Core scrub engine (shared by tool + command)
// ---------------------------------------------------------------------------

type Rule = { kind: "literal"; value: string } | { kind: "regex"; source: string };

interface ScrubResult {
	file: string;
	counts: number[]; // per rule, occurrences replaced
	total: number;
	error?: string;
}

function jsonEscapedVariant(s: string): string | null {
	// Secrets inside JSONL string values may appear in escaped form
	// (\" \\ \uXXXX). Match both raw and escaped spellings.
	const esc = JSON.stringify(s).slice(1, -1);
	return esc === s ? null : esc;
}

function scrubText(text: string, rules: Rule[], replacement: string): { text: string; counts: number[] } {
	const counts = rules.map(() => 0);
	let out = text;
	rules.forEach((rule, i) => {
		if (rule.kind === "literal") {
			const variants = [rule.value];
			const esc = jsonEscapedVariant(rule.value);
			if (esc) variants.push(esc);
			for (const v of variants) {
				const parts = out.split(v);
				counts[i] += parts.length - 1;
				out = parts.join(replacement);
			}
		} else {
			try {
				const re = new RegExp(rule.source, "g");
				out = out.replace(re, () => {
					counts[i] += 1;
					return replacement;
				});
			} catch {
				// invalid regex: leave text untouched, count stays 0; caller flags it
				counts[i] = -1;
			}
		}
	});
	return { text: out, counts };
}

/** In-place, inode-preserving rewrite so live sessions keep appending. */
function scrubFile(filePath: string, rules: Rule[], replacement: string, dryRun: boolean): ScrubResult {
	const res: ScrubResult = { file: filePath, counts: [], total: 0 };
	try {
		const original = fs.readFileSync(filePath, "utf8");
		const { text, counts } = scrubText(original, rules, replacement);
		res.counts = counts;
		res.total = counts.reduce((a, b) => a + Math.max(0, b), 0);
		if (res.total > 0 && !dryRun) {
			const fd = fs.openSync(filePath, "r+"); // inode-preserving; 'r+b' is NOT a Node flag
			try {
				fs.writeFileSync(fd, text, "utf8");
				fs.ftruncateSync(fd, Buffer.byteLength(text));
			} finally {
				fs.closeSync(fd);
			}
		}
	} catch (err: any) {
		res.error = err?.message ?? String(err);
	}
	return res;
}

function collectJsonl(target: string): string[] {
	const out: string[] = [];
	const stack = [target];
	while (stack.length) {
		const cur = stack.pop()!;
		let st: fs.Stats;
		try {
			st = fs.statSync(cur);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
				const p = path.join(cur, e.name);
				if (e.isDirectory()) stack.push(p);
				else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
			}
		} else if (st.isFile()) {
			out.push(cur); // explicit single file: any extension
		}
	}
	return out.sort();
}

function defaultSessionsRoot(ctx: ExtensionContext): string {
	try {
		const f = ctx.sessionManager.getSessionFile();
		if (f) return path.dirname(path.dirname(f)); // <sessions>/<project>/<file>.jsonl
	} catch {
		/* fall through */
	}
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "sessions");
}

// ---------------------------------------------------------------------------
// /scrub — masked prompt (same technique as secure-input.ts)
// ---------------------------------------------------------------------------

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function promptSecret(ctx: ExtensionContext, label: string): Promise<string | null> {
	return ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
		let value = "";
		let cached: string[] | undefined;
		const refresh = () => {
			cached = undefined;
		};

		function handleInput(data: string) {
			if (data.includes(PASTE_START)) {
				const after = data.slice(data.indexOf(PASTE_START) + PASTE_START.length);
				const end = after.indexOf(PASTE_END);
				const pasted = (end >= 0 ? after.slice(0, end) : after).replace(/\r/g, "").trim();
				if (pasted) {
					value += pasted;
					refresh();
				}
				return;
			}
			if (matchesEnter(data)) return done(value ? value : null);
			if (matchesEscape(data)) return done(null);
			if (matchesBackspace(data)) {
				value = value.slice(0, -1);
				refresh();
				return;
			}
			const hasControlChars = [...data].some((ch) => {
				const code = ch.charCodeAt(0);
				return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
			});
			if (!hasControlChars && data) {
				value += data;
				refresh();
			}
		}

		function render(width: number): string[] {
			if (cached) return cached;
			const w = Math.max(1, width);
			const lines: string[] = [];
			const push = (s: string) => lines.push(truncateToWidth(s, w));
			push(theme.fg("accent", "─".repeat(w)));
			for (const row of wrapTextWithAnsi(" 🧹 " + label, Math.max(10, w - 2))) {
				push(theme.fg("text", theme.bold(row)));
			}
			push(theme.fg("muted", "Input is masked — what you type is never displayed or logged."));
			lines.push("");
			const budget = Math.max(1, w - 6);
			const shown = Math.min(value.length, budget);
			const overflow = value.length - shown;
			const dots =
				value.length > 0
					? theme.fg("accent", "•".repeat(shown) + (overflow > 0 ? ` +${overflow}` : ""))
					: theme.fg("dim", "(empty)");
			push(theme.fg("text", " > ") + dots);
			lines.push("");
			push(theme.fg("dim", "Type or paste the secret • Enter to scrub • Esc to cancel"));
			push(theme.fg("accent", "─".repeat(w)));
			cached = lines;
			return lines;
		}

		return { render, handleInput, invalidate: () => (cached = undefined) };
	});
}

// Key matching without importing Key/matchesKey ambiguity issues: reuse pi-tui.
import { Key, matchesKey } from "@earendil-works/pi-tui";
const matchesEnter = (d: string) => matchesKey(d, Key.enter);
const matchesEscape = (d: string) => matchesKey(d, Key.escape);
const matchesBackspace = (d: string) => matchesKey(d, Key.backspace);

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const scrubSchema = Type.Object({
	secrets: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Exact secret strings to erase (e.g. a password or token you just saw leak). Matched raw AND JSON-escaped. They are erased from the transcript INCLUDING this tool call's own arguments — but they remain in your live context until /new; say so in your summary.",
		})
	),
	patterns: Type.Optional(
		Type.Array(Type.String(), {
			description: "Regexes (JS syntax, applied globally) to erase, e.g. bearer tokens. Invalid regexes are reported by index and skipped.",
		})
	),
	path: Type.Optional(
		Type.String({
			description: "File or directory to scrub. Default: the ENTIRE sessions tree (all projects, all sessions, incl. subagents).",
		})
	),
	replacement: Type.Optional(Type.String({ description: "Replacement text. Default '<REDACTED>'." })),
	dryRun: Type.Optional(Type.Boolean({ description: "Count matches only; change nothing." })),
});

export default function sessionScrubber(pi: ExtensionAPI) {
	pi.registerTool({
		name: "scrub_sessions",
		label: "Scrub sessions",
		description:
			"Erase sensitive strings/regexes from session transcripts (*.jsonl) IN PLACE, inode-preserving so the live session keeps working. " +
			"Use when YOU judge that credentials/tokens/secrets have been printed into context (tool output, your own replies). You decide what is sensitive; this only rewrites files. " +
			"Pass exact strings in `secrets` (they never appear in results/rendering, and this call's own args get erased by the same pass). " +
			"Default scope: the whole sessions tree. Always run dryRun:true first, then apply. Remind the user the live model context still holds the values until /new.",
		parameters: scrubSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const secrets = params.secrets ?? [];
			const patterns = params.patterns ?? [];
			if (!secrets.length && !patterns.length) {
				return { content: [{ type: "text", text: "Error: provide at least one entry in `secrets` or `patterns`." }], details: {} };
			}
			const rules: Rule[] = [
				...secrets.map((s) => ({ kind: "literal" as const, value: s })),
				...patterns.map((s) => ({ kind: "regex" as const, source: s })),
			];
			const badRegex = rules.findIndex((r) => r.kind === "regex" && (() => { try { new RegExp(r.source); return false; } catch { return true; } })());
			if (badRegex >= 0) {
				return { content: [{ type: "text", text: `Error: invalid regex at patterns[${badRegex - secrets.length}] (not shown for safety).` }], details: {} };
			}
			const replacement = params.replacement ?? "<REDACTED>";
			const target = params.path ? path.resolve(ctx.cwd, params.path) : defaultSessionsRoot(ctx);
			if (!fs.existsSync(target)) {
				return { content: [{ type: "text", text: `Error: target not found: ${target}` }], details: {} };
			}
			const files = collectJsonl(target);
			const results = files.map((f) => scrubFile(f, rules, replacement, !!params.dryRun));
			const touched = results.filter((r) => r.total > 0);
			const errors = results.filter((r) => r.error);
			const totalMatches = touched.reduce((a, r) => a + r.total, 0);

			const lines: string[] = [];
			lines.push(
				params.dryRun
					? `DRY RUN — ${totalMatches} match(es) in ${touched.length}/${files.length} file(s). Nothing changed.`
					: `Scrubbed ${totalMatches} match(es) across ${touched.length}/${files.length} file(s).`
			);
			for (const r of touched) {
				lines.push(`  ${r.file}: ${r.total} (${r.counts.map((c) => Math.max(0, c)).join("+")})`);
			}
			for (const r of errors) lines.push(`  ERROR ${r.file}: ${r.error}`);
			if (!params.dryRun && totalMatches > 0 && files.includes(ctx.sessionManager.getSessionFile() ?? "")) {
				lines.push("Note: this live session's transcript was scrubbed; the model context still contains the values until /new.");
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { dryRun: !!params.dryRun, files: touched.length, matches: totalMatches },
			};
		},
		// Never render the secret args in the TUI.
		renderCall(args, theme) {
			const a = args as { secrets?: string[]; patterns?: string[]; path?: string; dryRun?: boolean };
			const bits = [
				a.secrets?.length ? `${a.secrets.length} secret(s)` : "",
				a.patterns?.length ? `${a.patterns.length} pattern(s)` : "",
			].filter(Boolean).join(", ");
			let text = theme.fg("toolTitle", theme.bold("scrub_sessions ")) + theme.fg("accent", bits || "(none shown)");
			if (a.path) text += theme.fg("muted", `  ${a.path}`);
			if (a.dryRun) text += theme.fg("warning", " [dry-run]");
			text += "\n" + theme.fg("muted", "  values hidden");
			return new Text(text, 0, 0);
		},
		renderResult(result, _opts, theme) {
			const first = result.content[0];
			const msg = first && first.type === "text" ? first.text : "";
			return new Text(theme.fg(msg.startsWith("Error") ? "error" : "success", msg), 0, 0);
		},
	});

	pi.registerCommand("scrub", {
		description: "Erase a secret from session transcripts with masked entry: /scrub [file|dir] (default: all sessions)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("scrub: interactive TUI required", "error");
				return;
			}
			const target = args.trim() ? path.resolve(ctx.cwd, args.trim()) : defaultSessionsRoot(ctx);
			if (!fs.existsSync(target)) {
				ctx.ui.notify(`scrub: path not found: ${target}`, "error");
				return;
			}
			const secret = await promptSecret(ctx, `Secret to erase from transcripts${args.trim() ? ` (${args.trim()})` : " (all sessions)"}`);
			if (!secret) {
				ctx.ui.notify("Cancelled — nothing scrubbed.", "info");
				return;
			}
			const rules: Rule[] = [{ kind: "literal", value: secret }];
			const files = collectJsonl(target);
			const preview = files.map((f) => scrubFile(f, rules, "<REDACTED>", true));
			const total = preview.reduce((a, r) => a + r.total, 0);
			if (total === 0) {
				ctx.ui.notify("No matches — transcripts are clean of that string.", "info");
				return;
			}
			const ok = await ctx.ui.confirm(
				"Scrub transcripts?",
				`Found ${total} match(es) in ${preview.filter((r) => r.total > 0).length}/${files.length} file(s). Erase in place?`
			);
			if (!ok) {
				ctx.ui.notify("Cancelled — nothing scrubbed.", "info");
				return;
			}
			const done = files.map((f) => scrubFile(f, rules, "<REDACTED>", false)).filter((r) => r.total > 0);
			ctx.ui.notify(
				`✓ Scrubbed ${done.reduce((a, r) => a + r.total, 0)} match(es) in ${done.length} file(s). Live context still holds the value until /new.`,
				"info"
			);
		},
	});
}
