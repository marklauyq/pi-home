/**
 * Remote Control — Server Manager.
 *
 * Registers /remote-server: start|status|stop the LAN server via
 * remote/cli.mjs, plus add <url> [token] and an interactive menu when no
 * remoteControl.url is configured. This extension does NOT connect to any
 * server — the phone-home client lives in extensions/remote-control.ts.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname as osHostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Console output from an extension lands in pi's TUI footer/status area, where
// it crowds the chat box. Keep all client-side logging silent unless explicitly
// debugging with PI_REMOTE_DEBUG=1 (server-side logs live in remote/state/server.log).
const CONSOLE_DEBUG = process.env["PI_REMOTE_DEBUG"] === "1";
const dbg = (...args: unknown[]): void => {
	if (CONSOLE_DEBUG) console.log(...args);
};
const dbgErr = (...args: unknown[]): void => {
	if (CONSOLE_DEBUG) console.error(...args);
};

// ─── Settings ────────────────────────────────────────────────────────────────

interface RemoteControlSettings {
	url: string;
	token?: string;
	name?: string;
}

function readJsonFile(path: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...a };
	for (const [k, v] of Object.entries(b)) {
		if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && !Array.isArray(out[k])) {
			out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
		} else {
			out[k] = v;
		}
	}
	return out;
}

function readSettings(): Record<string, unknown> {
	const agentDir = join(homedir(), ".pi", "agent");
	const globalSettings = readJsonFile(join(agentDir, "settings.json"));
	// Project settings from cwd — read from the cwd where pi is running
	const cwd = process.cwd();
	const projectSettings = readJsonFile(join(cwd, ".pi", "settings.json"));
	// Project wins over global
	return deepMerge(globalSettings, projectSettings);
}

function getRemoteControlSettings(settings: Record<string, unknown>): RemoteControlSettings | null {
	const rc = settings["remoteControl"] as Record<string, unknown> | undefined;
	if (!rc || typeof rc !== "object" || !rc["url"]) return null;
	return {
		url: String(rc["url"]),
		token: rc["token"] ? String(rc["token"]) : undefined,
		name: rc["name"] ? String(rc["name"]) : undefined,
	};
}

/**
 * Read-modify-write ONLY the global ~/.pi/agent/settings.json (no project
 * merge). Sets settings.remoteControl = { url, token?, name? } (undefined
 * keys omitted), preserves every other key.
 */
function writeRemoteControlSettings(rc: RemoteControlSettings): void {
	const path = join(getAgentDir(), "settings.json");
	const settings = readJsonFile(path);
	const obj: Record<string, unknown> = { url: rc.url };
	if (rc.token !== undefined) obj["token"] = rc.token;
	if (rc.name !== undefined) obj["name"] = rc.name;
	settings["remoteControl"] = obj;
	writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

function getRepoRoot(): string {
	// Extension lives at extensions/remote-server.ts
	// The repo root is one level up from this file's directory
	return dirname(__dirname);
}

// Read the locally-started server's port (server.meta) and token from the
// CLI state dir. Missing files → defaults (port 4820, no token).
function readLocalServerMeta(): { port: number; token?: string } {
	const stateDir = join(getAgentDir(), "remote", "state");
	let port = 4820;
	try {
		const meta = JSON.parse(readFileSync(join(stateDir, "server.meta"), "utf-8")) as { port?: unknown };
		if (typeof meta.port === "number") port = meta.port;
	} catch { /* default port */ }
	let token: string | undefined;
	try {
		const t = readFileSync(join(stateDir, "token"), "utf-8").trim();
		if (t) token = t;
	} catch { /* no token file yet */ }
	return { port, token };
}

/**
 * Non-internal IPv4 addresses: `primary` = physical LAN interfaces
 * (en0/en1, eth0/eth1, wlan0/wlan1), `other` = everything else
 * (VPN/bridge/VM interfaces — noise for copy-paste). Used to build
 * copy-pasteable `/remote-server add` lines for other devices.
 */
function getLanIps(): { primary: string[]; other: string[] } {
	const ifaces = networkInterfaces();
	const preferred = ["en0", "en1", "eth0", "eth1", "wlan0", "wlan1"];
	const primary: string[] = [];
	const other: string[] = [];
	const push = (bucket: string[], ip: string): void => {
		if (!bucket.includes(ip) && !primary.includes(ip)) bucket.push(ip);
	};
	for (const name of preferred) {
		for (const a of ifaces[name] ?? []) if (a.family === "IPv4" && !a.internal) push(primary, a.address);
	}
	for (const [name, addrs] of Object.entries(ifaces)) {
		if (preferred.includes(name)) continue;
		for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) push(other, a.address);
	}
	return { primary, other };
}

/**
 * Append a copy-pasteable `/remote-server add <url> <token>` line for the
 * primary LAN address(es), parsed from the CLI status output (Port:/Token:
 * lines). Virtual/VPN addresses are listed without the token to keep the
 * copy-paste lines clean. Returns null when the server isn't reporting a
 * token (not running) or no LAN address was found.
 */
function buildAddCommandHint(cliOutput: string): string | null {
	const lines = cliOutput.split("\n");
	const portLine = lines.find((l) => l.startsWith("Port:"));
	const tokenLine = lines.find((l) => l.startsWith("Token:"));
	if (!tokenLine) return null;
	const token = tokenLine.slice("Token:".length).trim();
	if (!token) return null;
	const port = portLine ? portLine.slice("Port:".length).trim() : String(readLocalServerMeta().port);
	const { primary, other } = getLanIps();
	// Fall back to all addresses if the physical interfaces have none (VMs etc.).
	const targets = primary.length > 0 ? primary : other;
	if (targets.length === 0) return null;
	const addLines = targets.map((ip) => `/remote-server add ws://${ip}:${port} ${token}`);
	const rest = primary.length > 0 ? other : [];
	const parts = ["", "Add this server on another pi instance (copy & run):", ...addLines];
	if (rest.length > 0) parts.push(`(other addresses, same token: ${rest.join(", ")})`);
	return parts.join("\n");
}

// ─── /remote-server command ───────────────────────────────────────────────────

// Simple text-input component: type + Enter submits, Esc cancels (null).
function promptForText(ctx: ExtensionCommandContext, title: string, hint: string): Promise<string | null> {
	return ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
		let text = "";
		let cached: string[] | undefined;

		function handleInput(data: string) {
			if (matchesKey(data, Key.escape)) {
				done(null);
			} else if (matchesKey(data, Key.enter)) {
				done(text);
			} else if (matchesKey(data, Key.backspace)) {
				text = text.slice(0, -1);
				cached = undefined;
			} else {
				text += data;
				cached = undefined;
			}
		}

		function render(width: number): string[] {
			if (cached) return cached;
			const w = Math.max(1, width);
			const lines: string[] = [];
			lines.push(theme.fg("accent", "─".repeat(w)));
			lines.push(theme.fg("text", theme.bold(title)));
			lines.push(theme.fg("text", "> " + text) + theme.fg("muted", "▌"));
			lines.push(theme.fg("dim", hint));
			lines.push(theme.fg("accent", "─".repeat(w)));
			cached = lines;
			return lines;
		}

		return { render, handleInput, invalidate: () => { cached = undefined; } };
	});
}

function registerRemoteServerCommand(pi: ExtensionAPI): void {
	const repoRoot = getRepoRoot();
	const cliPath = join(repoRoot, "remote", "cli.mjs");

	const runCli = (cliArgs: string[]) =>
		execFileAsync("node", [cliPath, ...cliArgs], { timeout: 10_000, cwd: repoRoot });

	// Configure the local server as remoteControl: read token/meta → write
	// global settings → notify. No connection logic in this extension —
	// the phone-home client in remote-control.ts picks the settings up.
	// Never echoes the token value.
	const configureLocalServer = async (ctx: ExtensionCommandContext, startedFresh: boolean): Promise<void> => {
		const { port, token } = readLocalServerMeta();
		const rc: RemoteControlSettings = { url: `ws://localhost:${port}`, token, name: osHostname() };
		let wrote = true;
		try {
			writeRemoteControlSettings(rc);
		} catch (err: unknown) {
			wrote = false;
			try {
				ctx.ui.notify(`Local server ${startedFresh ? "started" : "already running"}, but writing settings failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			} catch { /* best effort */ }
		}
		if (wrote) {
			try {
				ctx.ui.notify(`Local server ${startedFresh ? "started" : "already running"} & configured as remoteControl (${rc.url}) — token stored in settings.json. Use /remote on to connect this session.`, "info");
			} catch { /* best effort */ }
		}
	};

	// `start` — plain CLI passthrough when a url is already configured;
	// auto-configure (write settings) when none is. No WS connection ever.
	const startLocal = async (ctx: ExtensionCommandContext, port?: string): Promise<void> => {
		const cliArgs = ["start"];
		if (port) cliArgs.push("--port", port);
		try {
			const result = await runCli(cliArgs);
			const output = (result.stdout || "").trim() || (result.stderr || "").trim();
			if (getRemoteControlSettings(readSettings())) {
				// Existing configured url — plain passthrough, no settings writes.
				try {
					if (output) ctx.ui.notify(output, "info");
					else ctx.ui.notify("/remote-server start completed.", "info");
				} catch { /* best effort */ }
				return;
			}
			// Unconfigured: exit 0 means a fresh start — auto-configure.
			await configureLocalServer(ctx, true);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (getRemoteControlSettings(readSettings())) {
				try { ctx.ui.notify(`/remote-server start failed: ${msg}`, "error"); } catch { /* best effort */ }
				return;
			}
			// Server may already be running — try the configure-only path
			// instead of erroring out.
			if (/already running|exited immediately/i.test(msg)) {
				await configureLocalServer(ctx, false);
				return;
			}
			try { ctx.ui.notify(`/remote-server start failed: ${msg}`, "error"); } catch { /* best effort */ }
		}
	};

	// Bare /remote-server (or unknown subcmd): report state, or offer
	// start-local / add-remote when unconfigured.
	const bareInvoke = async (ctx: ExtensionCommandContext): Promise<void> => {
		const rc = getRemoteControlSettings(readSettings());
		if (rc) {
			try {
				ctx.ui.notify(
					`remoteControl: ${rc.url}. Available: start|status|stop|add <url> [token]`,
					"info",
				);
			} catch { /* best effort */ }
			return;
		}
		if (ctx.mode !== "tui") {
			try {
				ctx.ui.notify(
					"No remoteControl.url configured. Use: /remote-server start (local server + auto-configure), or /remote-server add <url> [token]. Or set remoteControl in ~/.pi/agent/settings.json.",
					"info",
				);
			} catch { /* best effort */ }
			return;
		}

		const options = [
			{ id: "start-local", label: "Start local server (ws://localhost:4820)" },
			{ id: "add-remote", label: "Add remote server URL…" },
		];
		const result = await ctx.ui.custom<{ choice: string } | null>((_tui, theme, _kb, done) => {
			let selected = 0;
			let cached: string[] | undefined;

			function handleInput(data: string) {
				if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
					selected = (selected + 1) % options.length;
					cached = undefined;
				} else if (matchesKey(data, Key.enter)) {
					done({ choice: options[selected].id });
				} else if (matchesKey(data, Key.escape)) {
					done(null);
				}
			}

			function render(width: number): string[] {
				if (cached) return cached;
				const w = Math.max(1, width);
				const lines: string[] = [];
				lines.push(theme.fg("accent", "─".repeat(w)));
				lines.push(theme.fg("text", theme.bold(" No remoteControl.url configured")));
				lines.push("");
				options.forEach((o, i) => {
					const prefix = i === selected ? theme.fg("accent", "> ") : "  ";
					const color = i === selected ? "accent" : "text";
					lines.push(prefix + theme.fg(color, o.label));
				});
				lines.push("");
				lines.push(theme.fg("dim", "↑↓ select • Enter choose • Esc cancel"));
				lines.push(theme.fg("accent", "─".repeat(w)));
				cached = lines;
				return lines;
			}

			return { render, handleInput, invalidate: () => { cached = undefined; } };
		});

		if (!result) return; // Esc

		if (result.choice === "start-local") {
			await startLocal(ctx, undefined);
			return;
		}

		// "Add remote server URL…"
		const url = (await promptForText(ctx, " Remote server URL", "ws:// or wss:// URL — Enter submit • Esc cancel"))?.trim();
		if (!url) return;
		const tokenRaw = await promptForText(ctx, " Token (optional)", "Enter to skip • Esc to cancel");
		if (tokenRaw === null) return;
		const token = tokenRaw.trim();
		writeRemoteControlSettings({ url, token: token || undefined, name: osHostname() });
		try {
			ctx.ui.notify(
				`remoteControl added: ${url}${token ? " (token stored in settings.json)" : ""}. /remote on (or /reload) to connect.`,
				"info",
			);
		} catch { /* best effort */ }
	};

	pi.registerCommand("remote-server", {
		description: "Remote control server management (start|status|stop|add <url> [token])",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const args = _args.trim().split(/\s+/);
			const subcmd = args[0]?.toLowerCase();
			const portArg = args.find(a => a.startsWith("--port=")) || args.find(a => a === "--port");
			const port = portArg ? (portArg === "--port" ? args[args.indexOf(portArg) + 1] : portArg.slice(7)) : undefined;

			if (subcmd === "add") {
				const url = args[1]?.trim();
				const token = args[2]?.trim();
				if (!url) {
					try { ctx.ui.notify("Usage: /remote-server add <url> [token]", "warning"); } catch { /* best effort */ }
					return;
				}
				writeRemoteControlSettings({ url, token: token || undefined, name: osHostname() });
				try {
					ctx.ui.notify(
						`remoteControl added: ${url}${token ? " (token stored in settings.json)" : ""}. /remote on (or /reload) to connect.`,
						"info",
					);
				} catch { /* best effort */ }
				return;
			}

			if (subcmd === "start") {
				await startLocal(ctx, port);
				return;
			}

			if (subcmd === "status" || subcmd === "stop") {
				const cliArgs = [subcmd];
				if (port) cliArgs.push("--port", port);
				try {
					const result = await runCli(cliArgs);
					const output = (result.stdout || "").trim() || (result.stderr || "").trim();
					if (output) {
						// For status, append a copy-pasteable /remote-server add line
					// so the user can wire up another machine from the toast alone.
					let text = output;
					if (subcmd === "status") {
						const hint = buildAddCommandHint(output);
						if (hint) text += hint;
					}
						ctx.ui.notify(text, "info");
					} else {
						ctx.ui.notify(`/remote-server ${subcmd} completed.`, "info");
					}
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`/remote-server ${subcmd} failed: ${msg}`, "error");
				}
				return;
			}

			// Bare invocation (no subcmd) or unknown subcmd.
			await bareInvoke(ctx);
		},
	});
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	registerRemoteServerCommand(pi);
}
