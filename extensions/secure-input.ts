/**
 * Secure Input — masked password/secret entry for the TUI.
 *
 * - `/secret <name>`   — prompt the user with a masked input (renders • per char,
 *                        the raw value is never drawn to the screen).
 * - `/secrets`         — list stored session secrets; `/secrets clear` wipes them.
 * - `secret` tool      — agent-initiated entry. Returns only a reference token
 *                        (SECRET:<name>) to the model; the value never enters the
 *                        LLM context or session log.
 * - `bash` override    — `{{secret:name}}` placeholders in bash commands are
 *                        substituted with the real value ONLY at execution time
 *                        (spawnHook). The TUI, model context, and session log
 *                        keep showing the placeholder.
 *
 * Secrets live in process memory only — cleared when pi exits.
 *
 * Known caveat: the substituted value exists briefly in the child shell's argv
 * (visible via `ps` while the command runs). Same class as `sudo -S` in CI.
 */

import { Type } from "typebox";
import {
	type ExtensionAPI,
	type ExtensionContext,
	createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const PLACEHOLDER_RE = /\{\{secret:([A-Za-z0-9._-]+)\}\}/g;

// In-memory session secret store (dies with the process)
const secrets = new Map<string, string>();

// Names referenced by the most recent bash spawn (for diagnostics)
let lastMissing: string[] = [];

function substituteSecrets(command: string): string {
	lastMissing = [];
	if (!command.includes("{{secret:")) return command;
	return command.replace(PLACEHOLDER_RE, (_m, name: string) => {
		const value = secrets.get(name);
		if (value === undefined) {
			lastMissing.push(name);
			return `SECRET_MISSING:${name}`;
		}
		return value;
	});
}

/**
 * Open a masked input overlay and resolve to the entered value (or null on
 * Esc / empty submit). The raw value is only ever kept in `value`; rendering
 * shows one • per character.
 */
function promptSecret(ctx: ExtensionContext, label: string): Promise<string | null> {
	return ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
		let value = "";
		let cached: string[] | undefined;

		function refresh() {
			cached = undefined;
			// re-render via the component's own render pass
		}

		function handleInput(data: string) {
			// Bracketed paste — accept as one chunk (newlines stripped)
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
			if (matchesKey(data, Key.enter)) {
				done(value ? value : null);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(null);
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				value = value.slice(0, -1);
				refresh();
				return;
			}
			// Kitty CSI-u printable (e.g. \x1b[97u → 'a')
			const kittyPrintable = decodeKittyPrintable(data);
			if (kittyPrintable !== undefined) {
				value += kittyPrintable;
				refresh();
				return;
			}
			// Regular printable input; reject control characters
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
			// Anything wider than the terminal crashes the TUI (see pi-tui-crash.log:
			// a long `note` on the secret tool blew past 202 cols and killed pi).
			// wrapTextWithAnsi does NOT break over-long tokens, so every row still
			// gets truncated as a safety net.
			const push = (s: string) => lines.push(truncateToWidth(s, w));
			push(theme.fg("accent", "─".repeat(w)));
			for (const row of wrapTextWithAnsi(" 🔒 " + label, Math.max(10, w - 2))) {
				push(theme.fg("text", theme.bold(row)));
			}
			push(theme.fg("muted", "Input is masked — what you type is never displayed."));
			lines.push("");
			// A pasted 300-char token would overflow the same way - cap the echo.
			const budget = Math.max(1, w - 6);
			const shown = Math.min(value.length, budget);
			const overflow = value.length - shown;
			const dots = value.length > 0
				? theme.fg("accent", "•".repeat(shown) + (overflow > 0 ? ` +${overflow}` : ""))
				: theme.fg("dim", "(empty)");
			push(theme.fg("text", " > ") + dots);
			lines.push("");
			push(theme.fg("dim", "Type or paste • Enter to store • Esc to cancel"));
			push(theme.fg("accent", "─".repeat(w)));
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
}

export default function secureInput(pi: ExtensionAPI) {
	// --- /secret <name> -----------------------------------------------------
	pi.registerCommand("secret", {
		description: "Enter a secret with masked input: /secret [name] (defaults to 'default')",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("secret: interactive TUI required", "error");
				return;
			}
			const name = args.trim().split(/\s+/)[0] || "default";
			if (!NAME_RE.test(name)) {
				ctx.ui.notify("Usage: /secret <name>   (name: letters, digits, . _ -)", "error");
				return;
			}
			const value = await promptSecret(ctx, `Enter secret "${name}"`);
			if (!value) {
				ctx.ui.notify(`Cancelled — "${name}" was not stored.`, "info");
				return;
			}
			secrets.set(name, value);
			ctx.ui.notify(`✓ Stored "${name}" (${value.length} chars, in-memory). Use {{secret:${name}}} in bash commands.`, "info");
		},
	});

	// --- /secrets [clear] ---------------------------------------------------
	pi.registerCommand("secrets", {
		description: "List session secrets, or wipe them: /secrets, /secrets clear",
		handler: async (args, ctx) => {
			if (args.trim() === "clear") {
				secrets.clear();
				ctx.ui.notify("All session secrets cleared.", "info");
				return;
			}
			if (secrets.size === 0) {
				ctx.ui.notify("No secrets stored this session. Use /secret <name> to add one.", "info");
				return;
			}
			const list = [...secrets.keys()]
				.map((n) => `${n} (${secrets.get(n)!.length} chars)`)
				.join(", ");
			ctx.ui.notify(`Session secrets: ${list}.  /secrets clear to wipe.`, "info");
		},
	});

	// --- secret tool (agent-initiated entry) --------------------------------
	pi.registerTool({
		name: "secret",
		label: "Secret",
		description:
			"Prompt the user to enter a password or API token via a MASKED TUI input (characters render as •). " +
			"The value is stored in session memory and NEVER returned to the model — the tool only confirms a reference token. " +
			"Use the reference in bash commands as a {{secret:<name>}} placeholder; it is substituted with the real value only at execution time. " +
			"When a command needs sudo, use: echo \"{{secret:<name>}}\" | sudo -S -p '' <command>. " +
			"Names use letters/digits/._- . If you omit the name, it is stored under 'default'. " +
			"To see what is already stored, call with action:'list' (names only, never values); " +
			"action:'clear' wipes the session store. Users can also use /secret <name> and /secrets.",
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union([Type.Literal("store"), Type.Literal("list"), Type.Literal("clear")], {
					description: "Default 'store' (prompt for a value). 'list' returns stored names (never values). 'clear' wipes the store.",
				})
			),
			name: Type.Optional(Type.String({ description: "Identifier for the secret, e.g. 'deploy-bot' or 'admin-sudo'. Letters, digits, . _ - . Defaults to 'default' when omitted." })),
			note: Type.Optional(Type.String({ description: "Why the secret is needed; shown to the user in the prompt." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action ?? "store";
			if (action === "list") {
				const names = [...secrets.keys()];
				return {
					content: [
						{
							type: "text",
							text: names.length
								? `Stored secrets (names only): ${names.join(", ")}. Reference as {{secret:<name>}}.`
								: "No secrets stored this session. Use action 'store' (default) to prompt the user.",
						},
					],
					details: { listed: names },
				};
			}
			if (action === "clear") {
				secrets.clear();
				return {
					content: [{ type: "text", text: "All session secrets cleared." }],
					details: { cleared: true },
				};
			}
		if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Error: interactive TUI required for secret entry (not available in this mode)." }],
					details: { stored: false },
				};
			}
			const name = params.name ?? "default";
			if (!NAME_RE.test(name)) {
				return {
					content: [{ type: "text", text: `Error: invalid secret name "${name}". Use letters, digits, . _ - only.` }],
					details: { name, stored: false },
				};
			}
			const label = `Enter secret "${name}"${params.note ? ` — ${params.note}` : ""}`;
			const value = await promptSecret(ctx, label);
			if (!value) {
				return {
					content: [{ type: "text", text: `User cancelled entry for "${name}". Nothing was stored.` }],
					details: { name, stored: false },
				};
			}
			secrets.set(name, value);
			return {
				content: [
					{
						type: "text",
						text: `Stored "${name}" (${value.length} chars). Reference it in bash commands as {{secret:${name}}} — the placeholder is substituted only at execution time and never appears in logs.`,
					},
				],
				details: { name, stored: true, chars: value.length },
			};
		},
		renderCall(args, theme, _context) {
			const a = args as { name?: string; note?: string };
			let text = theme.fg("toolTitle", theme.bold("secret ")) + theme.fg("accent", a.name ?? (a.action === "list" ? "(list)" : a.action === "clear" ? "(clear)" : "default"));
			if (a.note) text += `\n${theme.fg("muted", "  " + a.note)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme, _context) {
			const details = result.details as { name?: string; stored?: boolean } | undefined;
			if (details?.stored && details.name) {
				return new Text(theme.fg("success", "✓ ") + theme.fg("accent", `SECRET:${details.name}`), 0, 0);
			}
			const first = result.content[0];
			const msg = first && first.type === "text" ? first.text : "";
			return new Text(theme.fg(msg.startsWith("Error") ? "error" : "warning", msg), 0, 0);
		},
	});

	// --- bash override: {{secret:name}} substitution at exec time -----------
	// Reuses pi's built-in bash implementation (local shell ops, truncation,
	// PI_* env, live output rendering) and hooks the spawn context so the
	// real value enters only the executed command string. The rendered
	// command (from the original tool args) and the session log keep the
	// placeholder.
	//
	// The static definition below only supplies the tool's metadata and
	// built-in renderers; execute() builds a fresh base definition per call
	// with the LIVE session cwd (ctx.cwd), so in-process session switches
	// (e.g. /wt into a worktree) relocate bash correctly. (Baking in
	// process.cwd() at load time would pin it to the startup directory.)
	const bashOptions = {
		spawnHook: (context: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
			...context,
			command: substituteSecrets(context.command),
		}),
	};
	const staticBash = createBashToolDefinition(".", bashOptions);

	pi.registerTool({
		...staticBash,
		label: "bash (secrets)",
		description:
			staticBash.description +
			" Additionally: {{secret:<name>}} placeholders in the command are substituted with values entered via the `secret` tool or `/secret` command only at execution time — the displayed/logged command keeps the placeholder. For sudo: echo \"{{secret:<name>}}\" | sudo -S -p '' <command>.",
		promptSnippet: staticBash.promptSnippet,
		promptGuidelines: [
			...((staticBash as { promptGuidelines?: string[] }).promptGuidelines ?? []),
			"Secrets entered via the `secret` tool or `/secret` command are referenced in bash as {{secret:<name>}} and substituted only at execution time. For sudo, use: echo \"{{secret:<name>}}\" | sudo -S -p '' <command>.",
		],
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const def = createBashToolDefinition(ctx.cwd, bashOptions);
			return def.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}
