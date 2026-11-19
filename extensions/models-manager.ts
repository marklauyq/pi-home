/**
 * models-manager — interactive editor for `~/.pi/agent/models.json`.
 *
 * `/models-manager` opens the same dialogs pi itself uses (`ctx.ui.select` /
 * `ctx.ui.confirm` / `ctx.ui.input` / `ctx.ui.editor` — the /model, /settings
 * pickers): list all models → pick one → edit common fields (id, name,
 * reasoning, contextWindow, maxTokens, input) or the nested JSON ones (compat,
 * thinkingLevelMap, cost) in a multi-line editor → edit the whole entry as raw
 * JSON → delete (with confirm). Also add a model to an existing provider, or
 * create a brand-new provider (baseUrl + api + apiKey).
 *
 * Every mutation is written to disk immediately (atomically via
 * withFileMutationQueue, indent and trailing-newline preserved). Per pi's
 * models.md, models.json is re-read each time /model is opened, so edits take
 * effect without a restart — no /reload needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface ModelsFile {
	providers?: Record<string, ProviderCfg>;
	[key: string]: unknown;
}

interface ProviderCfg {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models?: ModelEntry[];
	[key: string]: unknown;
}

interface ModelEntry {
	id: string;
	name?: string;
	[key: string]: unknown;
}

interface ModelRef {
	provider: string;
	entry: ModelEntry;
}

const JSON_FIELDS = ["compat", "thinkingLevelMap", "cost"] as const;
const NUM_FIELDS = ["contextWindow", "maxTokens"] as const;
const COMMON_APIS = [
	"openai-completions",
	"openai-chat",
	"anthropic-messages",
	"google-generative-ai",
	"leave unset",
] as const;

// ---------------------------------------------------------------------------
// file IO
// ---------------------------------------------------------------------------

function modelsPath(): string {
	return path.join(getAgentDir(), "models.json");
}

function readModelsFile(): ModelsFile {
	let raw: string;
	try {
		raw = fs.readFileSync(modelsPath(), "utf8");
	} catch {
		throw new Error(`Cannot read ${modelsPath()} — does it exist?`);
	}
	try {
		const parsed = JSON.parse(raw) as ModelsFile;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		parsed.providers ??= {};
		return parsed;
	} catch (e) {
		throw new Error(`models.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** JSON.stringify with 2-space indent, preserving whether the file had a trailing newline. */
function writeJsonPreserving(file: string, data: unknown): void {
	let hadNewline = true;
	try {
		hadNewline = fs.readFileSync(file, "utf8").endsWith("\n");
	} catch {
		/* file may not exist yet */
	}
	let text = JSON.stringify(data, null, 2);
	if (hadNewline) text += "\n";
	fs.writeFileSync(file, text, "utf8");
}

async function saveModelsFile(file: ModelsFile): Promise<void> {
	await withFileMutationQueue(modelsPath(), () => {
		writeJsonPreserving(modelsPath(), file);
		return true;
	});
}

// ---------------------------------------------------------------------------
// model helpers
// ---------------------------------------------------------------------------

function ensureProviders(file: ModelsFile): Record<string, ProviderCfg> {
	file.providers ??= {};
	return file.providers;
}

function providerNames(file: ModelsFile): string[] {
	return Object.keys(ensureProviders(file)).sort();
}

function allModels(file: ModelsFile): ModelRef[] {
	const out: ModelRef[] = [];
	for (const [provider, cfg] of Object.entries(ensureProviders(file))) {
		for (const entry of cfg?.models ?? []) {
			if (entry && typeof entry.id === "string") out.push({ provider, entry });
		}
	}
	return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.entry.id.localeCompare(b.entry.id));
}

function hasId(file: ModelsFile, provider: string, id: string): boolean {
	return (ensureProviders(file)[provider]?.models ?? []).some((m) => m.id === id);
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function fmtValue(v: unknown): string {
	if (v === undefined) return "—";
	if (typeof v === "string") return v || "—";
	if (typeof v === "object") return truncate(JSON.stringify(v), 50) || "—";
	return String(v);
}

function parseOptionalNumber(field: string, text: string): number | undefined {
	const t = text.trim();
	if (t === "") return undefined;
	const n = Number(t);
	if (!Number.isFinite(n) || n < 0) {
		throw new Error(`${field} must be a non-negative number (got "${t}")`);
	}
	return n;
}

/**
 * SAFETY GUARD: this extension mutates tracked config (`models.json`). Writes
 * must only happen when a real user is driving an interactive terminal. A
 * non-TTY context (inspection/smoke harnesses, headless JSON/RPC) has no real
 * user to confirm choices, so we refuse to write rather than silently change
 * the user's config.
 */
function requireInteractiveUser(ctx: ExtensionContext): void {
	const interactive = !!process.stdin.isTTY && ctx.hasUI;
	if (!interactive) {
		throw new Error(
			"models-manager refuses to write config outside an interactive terminal (inspection/headless). " +
				"Open pi interactively and run /models-manager.",
		);
	}
}

// ---------------------------------------------------------------------------
// edit one model
// ---------------------------------------------------------------------------

async function editModel(ctx: ExtensionContext, file: ModelsFile, provider: string, entry: ModelEntry): Promise<void> {
	for (;;) {
		const fieldMap = new Map<string, string>();
		const options: string[] = [];
		const addOption = (key: string, label: string) => {
			fieldMap.set(label, key);
			options.push(label);
		};

		addOption("id", `id ─ ${entry.id}`);
		addOption("name", `name ─ ${fmtValue(entry.name)}`);
		addOption("reasoning", `reasoning ─ ${entry.reasoning === undefined ? "not set" : String(entry.reasoning)}`);
		for (const f of NUM_FIELDS) addOption(f, `${f} ─ ${fmtValue(entry[f])}`);
		addOption("input", `input ─ ${fmtValue((entry.input ?? []).join(", "))}`);
		for (const f of JSON_FIELDS) addOption(f, `${f} ─ ${fmtValue(entry[f])}`);

		options.push("──────────────");
		options.push("✎ Edit raw JSON (entire entry)");
		options.push("🗑 Delete model");
		options.push("← Back to list");

		const choice = await ctx.ui.select(`Edit model — ${provider}/${entry.id}`, options);
		if (!choice || choice === "← Back to list" || choice === "──────────────") return;

		if (choice === "🗑 Delete model") {
			const ok = await ctx.ui.confirm("Delete model", `Really remove ${provider}/${entry.id} from models.json?`);
			if (!ok) continue;
			const models = ensureProviders(file)[provider]?.models;
			if (models) {
				const idx = models.indexOf(entry);
				if (idx >= 0) models.splice(idx, 1);
				await saveModelsFile(file);
			}
			ctx.ui.notify(`Deleted ${provider}/${entry.id}.`, "info");
			return;
		}

		if (choice === "✎ Edit raw JSON (entire entry)") {
			const text = await ctx.ui.editor(`Raw JSON — ${provider}/${entry.id}`, JSON.stringify(entry, null, 2));
			if (text === undefined) continue;
			try {
				const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					throw new Error("expected a JSON object");
				}
				if (typeof parsed.id !== "string" || !parsed.id.trim()) {
					throw new Error('"id" must be a non-empty string');
				}
				if (parsed.id !== entry.id && hasId(file, provider, parsed.id)) {
					throw new Error(`a model with id "${parsed.id}" already exists in ${provider}`);
				}
				for (const k of Object.keys(entry)) delete entry[k];
				Object.assign(entry, parsed);
				await saveModelsFile(file);
				ctx.ui.notify(`Updated ${provider}/${entry.id}.`, "info");
			} catch (e) {
				ctx.ui.notify(`Raw JSON rejected: ${e instanceof Error ? e.message : String(e)}`, "warning");
			}
			continue;
		}

		const key = fieldMap.get(choice);
		if (!key) continue;

		if (key === "id") {
			const v = (await ctx.ui.input("Model id", String(entry.id ?? "")))?.trim();
			if (v === undefined) continue;
			if (!v) {
				ctx.ui.notify("Model id cannot be empty.", "warning");
				continue;
			}
			if (v !== entry.id && hasId(file, provider, v)) {
				ctx.ui.notify(`A model with id "${v}" already exists in ${provider}.`, "warning");
				continue;
			}
			entry.id = v;
			await saveModelsFile(file);
			ctx.ui.notify("Model id updated.", "info");
			continue;
		}

		if (key === "name") {
			const v = (await ctx.ui.input("Display name", entry.name ?? ""))?.trim();
			if (v === undefined) continue;
			if (v) entry.name = v;
			else delete entry.name;
			await saveModelsFile(file);
			ctx.ui.notify("Display name updated.", "info");
			continue;
		}

		if (key === "reasoning") {
			const cur = entry.reasoning === undefined ? "" : String(entry.reasoning);
			const v = await ctx.ui.select(`reasoning (currently ${cur || "not set"})`, [
				"true",
				"false",
				"unset (remove field)",
			]);
			if (!v) continue;
			if (v === "unset (remove field)") delete entry.reasoning;
			else entry.reasoning = v === "true";
			await saveModelsFile(file);
			ctx.ui.notify(`reasoning → ${v}`, "info");
			continue;
		}

		if ((NUM_FIELDS as readonly string[]).includes(key)) {
			const v = (await ctx.ui.input(
				`${key} (non-negative number, empty to remove)`,
				entry[key] != null ? String(entry[key]) : "",
			))?.trim();
			if (v === undefined) continue;
			try {
				const n = parseOptionalNumber(key, v);
				if (n === undefined) delete entry[key];
				else entry[key] = n;
				await saveModelsFile(file);
				ctx.ui.notify(`${key} → ${n ?? "removed"}`, "info");
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "warning");
			}
			continue;
		}

		if (key === "input") {
			const v = (await ctx.ui.input(
				"Input formats (comma-separated, e.g. text, image)",
				(entry.input ?? []).join(", "),
			))?.trim();
			if (v === undefined) continue;
			const items = v.split(",").map((s) => s.trim()).filter(Boolean);
			if (items.length) entry.input = items;
			else delete entry.input;
			await saveModelsFile(file);
			ctx.ui.notify(`input → ${items.join(", ") || "removed"}`, "info");
			continue;
		}

		if ((JSON_FIELDS as readonly string[]).includes(key)) {
			const text = await ctx.ui.editor(
				`Edit ${key} (raw JSON) — ${provider}/${entry.id}`,
				JSON.stringify(entry[key] ?? {}, null, 2),
			);
			if (text === undefined) continue;
			try {
				const trimmed = text.trim();
				if (trimmed === "") {
					delete entry[key];
				} else {
					const parsed = JSON.parse(trimmed) as unknown;
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
						throw new Error("expected a JSON object");
					}
					entry[key] = parsed;
				}
				await saveModelsFile(file);
				ctx.ui.notify(`${key} updated.`, "info");
			} catch (e) {
				ctx.ui.notify(`${key} must be a valid JSON object: ${e instanceof Error ? e.message : String(e)}`, "warning");
			}
			continue;
		}
	}
}

// ---------------------------------------------------------------------------
// add a model / provider
// ---------------------------------------------------------------------------

async function addProvider(ctx: ExtensionContext, file: ModelsFile): Promise<string | null> {
	const name = (await ctx.ui.input("New provider name (required, e.g. my-proxy)", ""))?.trim();
	if (name === undefined) return null;
	if (!name) {
		ctx.ui.notify("Provider name cannot be empty.", "warning");
		return null;
	}
	if (name in ensureProviders(file)) {
		ctx.ui.notify(`Provider "${name}" already exists.`, "warning");
		return null;
	}

	const baseUrl = (await ctx.ui.input(
		`baseUrl for "${name}" (e.g. http://localhost:1234/v1)`,
		"http://localhost:11434/v1",
	))?.trim();

	const apiChoice = await ctx.ui.select(`API type for "${name}"`, [...COMMON_APIS] as unknown as string[]);
	const api = apiChoice && apiChoice !== "leave unset" ? apiChoice : undefined;

	const apiKey = (await ctx.ui.input(
		`apiKey for "${name}" (dummy is fine for keyless local servers; empty = leave unset, use /login)`,
		"",
	))?.trim();

	const cfg: ProviderCfg = {};
	if (baseUrl) cfg.baseUrl = baseUrl;
	if (api) cfg.api = api;
	if (apiKey) cfg.apiKey = apiKey;
	cfg.models = cfg.models ?? [];

	ensureProviders(file)[name] = cfg;
	await saveModelsFile(file);
	ctx.ui.notify(`Added provider "${name}".`, "info");
	return name;
}

async function addModel(ctx: ExtensionContext, file: ModelsFile): Promise<void> {
	const names = providerNames(file);
	const provider =
		names.length === 0
			? await addProvider(ctx, file)
			: await ctx.ui.select("Add model to provider", [...names, "＋ new provider…"]);
	if (!provider) return;
	if (provider === "＋ new provider…") {
		const created = await addProvider(ctx, file);
		if (!created) return;
		await addModel(ctx, file); // recurse once so the picker shows the new provider
		return;
	}

	const id = (await ctx.ui.input("New model id (required, e.g. qwen38-27b)", ""))?.trim();
	if (!id) return;
	if (hasId(file, provider, id)) {
		ctx.ui.notify(`A model with id "${id}" already exists in ${provider}.`, "warning");
		return;
	}

	const name = (await ctx.ui.input("Display name (optional)", ""))?.trim();
	const entry: ModelEntry = { id };
	if (name) entry.name = name;

	ensureProviders(file)[provider].models ??= [];
	ensureProviders(file)[provider].models!.push(entry);
	await saveModelsFile(file);
	ctx.ui.notify(`Added ${provider}/${id}.`, "info");

	await editModel(ctx, file, provider, entry); // right into the fields to fill the rest
}

// ---------------------------------------------------------------------------
// extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("models-manager", {
		description:
			"Browse, edit, add, and remove models in ~/.pi/agent/models.json (same picker dialogs as /model); changes apply immediately",
		handler: async (_args, ctx) => {
			if (ctx.mode === "tui") requireInteractiveUser(ctx);

			let file: ModelsFile;
			try {
				file = readModelsFile();
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
				return;
			}

			for (;;) {
				const refs = allModels(file);
				const optionMap = new Map<string, ModelRef>();
				const options: string[] = refs.map((r) => {
					const ctxBadge = r.entry.contextWindow != null ? ` [${r.entry.contextWindow} ctx]` : "";
					const label =
						`${r.provider} / ${r.entry.id}` +
						(r.entry.name ? ` — ${truncate(String(r.entry.name), 46)}` : "") +
						ctxBadge;
					optionMap.set(label, r);
					return label;
				});
				options.push("➕ Add model…", "＋ New provider…", "❌ Close");

				const choice = await ctx.ui.select(
					`Models manager — ${refs.length} model(s), ${providerNames(file).length} provider(s) in models.json`,
					options,
				);
				if (!choice || choice === "❌ Close") return;
				if (choice === "➕ Add model…") {
					await addModel(ctx, file);
					continue;
				}
				if (choice === "＋ New provider…") {
					await addProvider(ctx, file);
					continue;
				}
				const ref = optionMap.get(choice);
				if (!ref) continue;
				await editModel(ctx, file, ref.provider, ref.entry);
			}
		},
	});
}
