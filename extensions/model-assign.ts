/**
 * model-assign — pick the default model for each subagent profile and the compactor,
 * based on the models configured in `~/.pi/agent/models.json` and the models currently
 * loaded on the live llama server (`/v1/models`).
 *
 * The `/model-assign` command opens an interface: a list of "fields" (each subagent
 * profile, the compactor model/thinking, the spawn default, and "all profiles") showing
 * the current value. Selecting a field opens a list of models to assign. Changes apply
 * immediately and the field list comes back updated, so you can assign several in a row.
 *
 * What it writes (everything takes effect without /reload):
 *   - Per-profile:      the `model:` frontmatter line in `~/.pi/agent/agents/<name>.md`
 *   - Compactor:        `settings.json` → `myCompact.model` / `myCompact.thinkingLevel`
 *   - Spawn default:    `settings.json` → `subagents.defaultModel`
 *
 * Also exposes two LLM tools: `set_model_assignment`, `show_model_assignments`, plus a
 * small footer widget showing the current assignments and llama-server state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	DynamicBorder,
	getAgentDir,
	getSelectListTheme,
	parseFrontmatter,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	SelectList,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type SelectItem,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const INHERIT = "__inherit__";

interface Profile {
	name: string;
	description?: string;
	modelRef: string | null; // "provider/modelId" or null (inherit)
	filePath: string;
	source: "user" | "project";
}

interface Candidate {
	ref: string; // "provider/modelId" (modelId itself may contain "/")
	id: string;
	name: string;
	provider: string;
	reasoning?: boolean;
	contextWindow?: number;
	live: boolean; // currently loaded on the llama server
}

interface ServerInfo {
	reachable: boolean;
	baseUrl: string;
	ids: string[];
	error?: string;
}

interface Overview {
	agents: { name: string; source: string; model: string | null }[];
	subagentsDefault: string | null;
	compactor: { model: string | null; thinkingLevel: string | null };
}

type FieldKind = "profile" | "compactor-model" | "compactor-thinking" | "spawn-default" | "all-profiles";

interface FieldDef {
	id: string;
	label: string;
	group: string;
	kind: FieldKind;
	profile?: Profile; // set when kind === "profile"
	current: string | null;
	currentDisplay: string;
}

interface ModelAssignOptions {
	theme: any;
	candidates: Candidate[];
	getFields: () => FieldDef[];
	onApply: (field: FieldDef, value: string) => Promise<string>;
	onNotify: (message: string) => void;
	requestRender: () => void;
	done: () => void;
	rows: number;
	cols: number;
}

// ---------------------------------------------------------------------------
// small read/write helpers
// ---------------------------------------------------------------------------

function readJson<T = any>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function settingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
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

// ---------------------------------------------------------------------------
// agent profile discovery (global + nearest project, mirrors the subagent extension)
// ---------------------------------------------------------------------------

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	for (;;) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function loadProfilesFromDir(dir: string, source: "user" | "project"): Profile[] {
	const profiles: Profile[] = [];
	if (!isDirectory(dir)) return profiles;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const { frontmatter } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name) continue;
		profiles.push({
			name: frontmatter.name,
			description: frontmatter.description,
			modelRef: frontmatter.model?.trim() || null,
			filePath,
			source,
		});
	}
	return profiles;
}

function discoverProfiles(cwd: string): Profile[] {
	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = findNearestProjectAgentsDir(cwd);
	const map = new Map<string, Profile>();
	for (const p of loadProfilesFromDir(userDir, "user")) map.set(p.name, p);
	for (const p of loadProfilesFromDir(projectDir ?? "", "project")) {
		if (!map.has(p.name)) map.set(p.name, p);
	}
	return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// candidate models: models.json + live llama server
// ---------------------------------------------------------------------------

function loadCandidates(): Candidate[] {
	const mj = readJson<{ providers?: Record<string, any> }>(
		path.join(getAgentDir(), "models.json"),
		{},
	);
	const out: Candidate[] = [];
	for (const [provider, cfg] of Object.entries(mj.providers ?? {})) {
		const models = cfg?.models ?? [];
		for (const m of models) {
			if (!m?.id) continue;
			out.push({
				ref: `${provider}/${m.id}`,
				id: m.id,
				name: m.name ?? m.id,
				provider,
				reasoning: !!m.reasoning,
				contextWindow: m.contextWindow,
				live: false,
			});
		}
	}
	return out.sort((a, b) => Number(b.live) - Number(a.live) || a.ref.localeCompare(b.ref));
}

function getLlamaBaseUrl(): string {
	const s = readJson<{ llamaServerUrl?: string }>(settingsPath(), {});
	if (s.llamaServerUrl?.trim()) return s.llamaServerUrl.trim().replace(/\/+$/, "");
	const mj = readJson<{ providers?: Record<string, any> }>(
		path.join(getAgentDir(), "models.json"),
		{},
	);
	const base = mj.providers?.["llama-server"]?.baseUrl ?? "";
	return base.replace(/\/+$/, "");
}

async function fetchLiveModelIds(baseUrl: string): Promise<ServerInfo> {
	if (!baseUrl) return { reachable: false, baseUrl, ids: [], error: "no llama server URL" };
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2500);
	try {
		const url = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) return { reachable: false, baseUrl, ids: [], error: `HTTP ${res.status}` };
		const data = (await res.json()) as { data?: { id: string }[] };
		return { reachable: true, baseUrl, ids: (data.data ?? []).map((d) => d.id) };
	} catch (e) {
		return {
			reachable: false,
			baseUrl,
			ids: [],
			error: e instanceof Error ? e.message : String(e),
		};
	} finally {
		clearTimeout(timeout);
	}
}

async function evalModelContext(): Promise<{ candidates: Candidate[]; server: ServerInfo }> {
	const candidates = loadCandidates();
	const server = await fetchLiveModelIds(getLlamaBaseUrl());
	if (server.reachable) {
		const live = new Set(server.ids);
		for (const c of candidates) if (live.has(c.id)) c.live = true;
	}
	return { candidates, server };
}

// ---------------------------------------------------------------------------
// current assignments
// ---------------------------------------------------------------------------

function loadOverview(profiles: Profile[]): Overview {
	const s = readJson<any>(settingsPath(), {});
	return {
		agents: profiles.map((p) => ({ name: p.name, source: p.source, model: p.modelRef })),
		subagentsDefault: s.subagents?.defaultModel ?? null,
		compactor: {
			model: s.myCompact?.model ?? null,
			thinkingLevel: s.myCompact?.thinkingLevel ?? null,
		},
	};
}

// ---------------------------------------------------------------------------
// writers
// ---------------------------------------------------------------------------

/** Rewrite the `model:` frontmatter line, preserving the rest of the file byte-for-byte. */
function setFrontmatterModel(content: string, modelRef: string | null): string {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|\r?$)([\s\S]*)$/);
	if (!m) return content; // no frontmatter block → leave as-is (cannot set a model safely)
	const body = m[2];
	const lines = m[1].split("\n");
	const modelIdx = lines.findIndex((l) => /^model:/m.test(l));

	if (modelRef == null || modelRef === "") {
		if (modelIdx >= 0) lines.splice(modelIdx, 1);
	} else if (modelIdx >= 0) {
		lines[modelIdx] = `model: ${modelRef}`;
	} else {
		const descIdx = lines.findIndex((l) => /^description:/m.test(l));
		lines.splice(descIdx >= 0 ? descIdx + 1 : 1, 0, `model: ${modelRef}`);
	}

	// Trim blank lines that removal may have left at the edges of the frontmatter block.
	while (lines.length && lines[0].trim() === "") lines.shift();
	while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
	return `---\n${lines.join("\n")}\n---\n${body}`;
}

async function writeProfileModel(profile: Profile, modelRef: string | null): Promise<boolean> {
	return withFileMutationQueue(profile.filePath, () => {
		const original = fs.readFileSync(profile.filePath, "utf8");
		const next = setFrontmatterModel(original, modelRef);
		if (next === original) return false;
		fs.writeFileSync(profile.filePath, next, "utf8");
		return true;
	});
}

async function setCompactor(patch: { model?: string | null; thinkingLevel?: string | null }): Promise<void> {
	const file = settingsPath();
	await withFileMutationQueue(file, () => {
		const data = readJson<any>(file, {});
		let mc = data.myCompact ?? {};
		if ("model" in patch) {
			if (patch.model == null) delete mc.model;
			else mc.model = patch.model;
		}
		if ("thinkingLevel" in patch) {
			if (patch.thinkingLevel == null) delete mc.thinkingLevel;
			else mc.thinkingLevel = patch.thinkingLevel;
		}
		if (Object.keys(mc).length === 0) delete data.myCompact;
		else data.myCompact = mc;
		writeJsonPreserving(file, data);
	});
}

async function setSubagentsDefault(modelRef: string | null): Promise<void> {
	const file = settingsPath();
	await withFileMutationQueue(file, () => {
		const data = readJson<any>(file, {});
		if (modelRef == null) {
			if (data.subagents) delete data.subagents.defaultModel;
			if (data.subagents && Object.keys(data.subagents).length === 0) delete data.subagents;
		} else {
			data.subagents = data.subagents ?? {};
			data.subagents.defaultModel = modelRef;
		}
		writeJsonPreserving(file, data);
	});
}

// ---------------------------------------------------------------------------
// footer widget
// ---------------------------------------------------------------------------

function shortRef(ref: string): string {
	return ref.split("/").pop() ?? ref;
}

/**
 * SAFETY GUARD: this extension mutates tracked config (`agents/*.md`, `settings.json`).
 * Writes must only happen when a real user is driving an interactive terminal. A non-TTY
 * context (extension inspection/smoke harnesses, headless JSON/RPC) has no real user to
 * confirm choices, so we refuse to write rather than silently change the user's config.
 */
function requireInteractiveUser(ctx: ExtensionContext): void {
	const interactive = !!process.stdin.isTTY && ctx.hasUI;
	if (!interactive) {
		throw new Error(
			"model-assign refuses to write config outside an interactive terminal (inspection/headless). " +
				"Open pi interactively and run /model-assign, or call set_model_assignment from an interactive session.",
		);
	}
}



// ---------------------------------------------------------------------------
// the interactive interface
// ---------------------------------------------------------------------------

function buildFields(ctx: ExtensionContext): FieldDef[] {
	const profiles = discoverProfiles(ctx.cwd);
	const ov = loadOverview(profiles);
	const fields: FieldDef[] = [];
	for (const p of profiles) {
		fields.push({
			id: `profile:${p.name}`,
			label: `profile · ${p.name}`,
			group: "profiles",
			kind: "profile",
			profile: p,
			current: p.modelRef,
			currentDisplay: p.modelRef ?? "inherit session",
		});
	}
	fields.push({
		id: "compactor-model",
		label: "compactor · model",
		group: "compactor",
		kind: "compactor-model",
		current: ov.compactor.model,
		currentDisplay: ov.compactor.model ?? "built-in pi",
	});
	fields.push({
		id: "compactor-thinking",
		label: "compactor · thinking",
		group: "compactor",
		kind: "compactor-thinking",
		current: ov.compactor.thinkingLevel,
		currentDisplay: ov.compactor.thinkingLevel ?? "session",
	});
	fields.push({
		id: "spawn-default",
		label: "subagents default",
		group: "general",
		kind: "spawn-default",
		current: ov.subagentsDefault,
		currentDisplay: ov.subagentsDefault ?? "inherit session",
	});
	fields.push({
		id: "all-profiles",
		label: "all profiles",
		group: "general",
		kind: "all-profiles",
		current: null,
		currentDisplay: "set every profile",
	});
	return fields;
}

function choicesForField(field: FieldDef, candidates: Candidate[]): SelectItem[] {
	const isModelField = field.kind !== "compactor-thinking";
	const inheritLabel =
		field.kind === "compactor-thinking"
			? "inherit session level"
			: field.kind === "compactor-model"
				? "use built-in pi compaction"
				: "inherit session model";
	const inheritDesc =
		field.kind === "compactor-thinking"
			? "Don't pin a level — use the session's current thinking level."
			: field.kind === "compactor-model"
				? "Remove myCompact.model → use pi's built-in compaction."
				: "Remove the explicit model → fall back to subagents default / session model.";

	const items: SelectItem[] = [
		{ value: INHERIT, label: inheritLabel, description: inheritDesc },
	];
	if (field.kind === "compactor-thinking") {
		for (const level of THINKING_LEVELS) {
			items.push({ value: level, label: level, description: `thinking level: ${level}` });
		}
	} else {
		for (const c of candidates) {
			const badges = [
				c.live ? "loaded" : "",
				c.contextWindow ? `${c.contextWindow} ctx` : "",
			]
				.filter(Boolean)
				.join(" · ");
			items.push({
				value: c.ref,
				label: shortRef(c.ref),
				description: `${c.name}${badges ? `  —  ${badges}` : ""}`,
			});
		}
	}
	return items;
}

async function applyField(ctx: ExtensionContext, field: FieldDef, value: string): Promise<string> {
	requireInteractiveUser(ctx);
	const isInherit = value === INHERIT;
	switch (field.kind) {
		case "profile": {
			await writeProfileModel(field.profile!, isInherit ? null : value);
			return `${field.label} → ${isInherit ? "inherit session" : value}`;
		}
		case "compactor-model": {
			await setCompactor({ model: isInherit ? null : value });
			return `${field.label} → ${isInherit ? "built-in pi" : value}`;
		}
		case "compactor-thinking": {
			await setCompactor({ thinkingLevel: isInherit ? null : value });
			return `${field.label} → ${isInherit ? "session level" : value}`;
		}
		case "spawn-default": {
			await setSubagentsDefault(isInherit ? null : value);
			return `${field.label} → ${isInherit ? "inherit session" : value}`;
		}
		case "all-profiles": {
			let updated = 0;
			for (const p of discoverProfiles(ctx.cwd)) {
				if (await writeProfileModel(p, isInherit ? null : value)) updated++;
			}
			return `all profiles → ${isInherit ? "inherit session" : value} (${updated} updated)`;
		}
	}
}

class ModelAssignUI implements Component {
	private opts: ModelAssignOptions;
	private frameH: number;
	private bodyH: number;
	private border: DynamicBorder;
	private view: "fields" | "models" = "fields";
	private fields: FieldDef[];
	private filter = "";
	private activeField: FieldDef | null = null;
	private fieldsList: SelectList;
	private modelsList: SelectList | null = null;

	constructor(opts: ModelAssignOptions) {
		this.opts = opts;
		this.frameH = Math.max(12, Math.min(opts.rows - 4, 42));
		this.bodyH = this.frameH - 4;
		this.border = new DynamicBorder((s) => opts.theme.fg("dim", s));
		this.fields = opts.getFields();
		this.fieldsList = this.makeFieldsList();
	}

	private makeFieldsList(): SelectList {
		const items: SelectItem[] = this.fields.map((f) => ({
			value: f.id,
			label: f.label,
			description: `current: ${f.currentDisplay}`,
		}));
		const list = new SelectList(items, this.bodyH, getSelectListTheme(), {
			maxPrimaryColumnWidth: 32,
		});
		list.onSelect = (item) => this.openModels(item);
		list.onCancel = () => this.opts.done();
		return list;
	}

	private makeModelsList(field: FieldDef): SelectList {
		const items = choicesForField(field, this.opts.candidates);
		const list = new SelectList(items, this.bodyH, getSelectListTheme(), {
			maxPrimaryColumnWidth: 44,
		});
		list.onSelect = (item) => this.applyChoice(item);
		list.onCancel = () => {
			this.view = "fields";
			this.filter = "";
			this.activeField = null;
			this.opts.requestRender();
		};
		return list;
	}

	private openModels(item?: SelectItem): void {
		if (!item) item = this.fieldsList.getSelectedItem();
		if (!item) return;
		const field = this.fields.find((f) => f.id === item.value);
		if (!field) return;
		this.activeField = field;
		this.modelsList = this.makeModelsList(field);
		this.view = "models";
		this.filter = "";
		this.opts.requestRender();
	}

	private applyChoice(item?: SelectItem): void {
		if (!item) item = this.modelsList?.getSelectedItem();
		if (!item) return;
		const field = this.activeField;
		if (!field) return;
		const value = item.value;
		// Applies the write, then refreshes fields and returns to the field list.
		this.opts
			.onApply(field, value)
			.then((message) => {
				this.opts.onNotify(message);
				this.fields = this.opts.getFields();
				this.fieldsList = this.makeFieldsList();
				this.view = "fields";
				this.filter = "";
				this.activeField = null;
				this.opts.requestRender();
			})
			.catch((err) => {
				this.opts.onNotify(`Could not apply: ${err instanceof Error ? err.message : String(err)}`);
			});
	}

	handleInput(data: string): void {
		if (this.view === "fields") {
			if (matchesKey(data, "escape")) {
				this.opts.done();
				return;
			}
			this.handleListKey(data, this.fieldsList);
			return;
		}
		if (matchesKey(data, "escape")) {
			this.view = "fields";
			this.filter = "";
			this.activeField = null;
			this.opts.requestRender();
			return;
		}
		if (this.modelsList) this.handleListKey(data, this.modelsList);
	}

	/** Forward arrows/enter to the list; intercept printable chars as a live filter. */
	private handleListKey(data: string, list: SelectList): void {
		if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
			this.filter = this.filter.slice(0, -1);
			list.setFilter(this.filter);
			this.opts.requestRender();
			return;
		}
		if (/^[\x20-\x7e]$/.test(data) && !data.startsWith("\x1b")) {
			this.filter += data;
			list.setFilter(this.filter);
			this.opts.requestRender();
			return;
		}
		list.handleInput(data);
		this.opts.requestRender();
	}

	invalidate(): void {
		this.fieldsList.invalidate();
		this.modelsList?.invalidate();
	}

	render(width: number): string[] {
		const t = this.opts.theme;
		const lines: string[] = [];
		lines.push(this.border.render(width)[0] ?? "");
		const isFields = this.view === "fields";
		const title = isFields ? "Assign models" : `Assign model — ${this.activeField?.label ?? ""}`;
		let titleLine = t.fg("accent", t.bold(title));
		if (this.filter) titleLine += t.fg("dim", `  filter: ${this.filter}`);
		lines.push(" " + truncateToWidth(titleLine, width - 1, "…"));

		const body = (isFields ? this.fieldsList : this.modelsList)?.render(width - 2) ?? [];
		lines.push(" ".repeat(1));
		for (const l of body) lines.push(" " + l);
		while (lines.length < this.bodyH) lines.push("");
		lines.push(this.renderHelp(isFields));
		lines.push(this.border.render(width)[0] ?? "");
		while (lines.length < this.frameH) lines.push("");
		return lines.slice(0, this.frameH);
	}

	private renderHelp(isFields: boolean): string {
		const t = this.opts.theme;
		const help = isFields
			? "↑↓ move · type to filter · enter select · esc close"
			: "↑↓ move · type to filter · enter assign · esc back";
		return " " + t.fg("dim", help);
	}
}

// ---------------------------------------------------------------------------
// tools (LLM automation)
// ---------------------------------------------------------------------------

function registerTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "set_model_assignment",
		label: "Set model assignment",
		description:
			"Set the default model for a subagent profile, the compactor, or the subagent spawn default. " +
			"role = an agent profile name, 'compactor', or 'subagents-default'. " +
			"model = a 'provider/modelId' from models.json, or 'inherit' (profiles/spawn-default) or 'built-in' (compactor). " +
			"Use show_model_assignments first to see the current mapping.",
		parameters: Type.Object({
			role: Type.String({
				description: "Agent profile name (e.g. 'crawler'), 'compactor', or 'subagents-default'.",
			}),
			model: Type.String({
				description: "'provider/modelId' (e.g. 'llama-server/qwen38-27b'), or 'inherit' / 'built-in'.",
			}),
			thinkingLevel: Type.Optional(
				Type.String({
					description:
						"Only for the compactor: off|minimal|low|medium|high|xhigh|max. Leave empty to keep the session level.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			requireInteractiveUser(ctx);
			const { role, model, thinkingLevel } = params as {
				role: string;
				model: string;
				thinkingLevel?: string;
			};
			const { candidates } = await evalModelContext();
			const known = new Set(candidates.map((c) => c.ref));
			const inheritTok = model === "inherit" || model === "built-in";

			if (!inheritTok) {
				const bare = model.split("/").pop() ?? model;
				if (!known.has(model) && !(bare && known.has(`${candidates[0]?.provider}/${bare}`))) {
					const list = candidates.map((c) => c.ref).slice(0, 20).join(", ");
					throw new Error(
						`Unknown model "${model}". Known models: ${list}${candidates.length > 20 ? ", …" : ""}`,
					);
				}
			}

			let applied: string;
			if (role === "compactor") {
				await setCompactor({
					model: inheritTok ? null : model,
					thinkingLevel: thinkingLevel?.trim() || undefined,
				});
				applied = `compactor → ${inheritTok ? "built-in pi" : model}`;
			} else if (role === "subagents-default") {
				await setSubagentsDefault(inheritTok ? null : model);
				applied = `subagents.defaultModel → ${inheritTok ? "inherit session" : model}`;
			} else {
				const profiles = discoverProfiles(ctx.cwd);
				const profile = profiles.find((p) => p.name === role);
				if (!profile) {
					const names = profiles.map((p) => p.name).join(", ");
					throw new Error(`No agent profile "${role}". Profiles: ${names}`);
				}
				await writeProfileModel(profile, inheritTok ? null : model);
				applied = `${profile.name} → ${inheritTok ? "inherit session" : model}`;
			}

			return { content: [{ type: "text", text: `Set ${applied}.` }], details: { applied } };
		},
	});

	pi.registerTool({
		name: "show_model_assignments",
		label: "Show model assignments",
		description:
			"Return the current model assigned to each subagent profile, the compactor, and the subagent spawn default, plus the llama server status.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const profiles = discoverProfiles(ctx.cwd);
			const overview = loadOverview(profiles);
			const { server } = await evalModelContext();
			const lines: string[] = ["# Subagent & compactor model assignments"];
			lines.push(
				`llama server: ${server.reachable ? "up" : `down (${server.error ?? "?"})`} · loaded: ${server.ids.join(", ") || "—"}`,
			);
			if (overview.agents.length) {
				lines.push("", "## Profiles");
				for (const a of overview.agents) {
					lines.push(`- ${a.name} (${a.source}): ${a.model ?? "inherit session"}`);
				}
			}
			lines.push("", "## Compactor");
			lines.push(`- model: ${overview.compactor.model ?? "built-in pi compaction"}`);
			lines.push(`- thinkingLevel: ${overview.compactor.thinkingLevel ?? "session level"}`);
			lines.push(`- spawn-default (subagents.defaultModel): ${overview.subagentsDefault ?? "inherit session"}`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { overview, server } };
		},
	});
}

// ---------------------------------------------------------------------------
// extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	registerTools(pi);

	pi.registerCommand("model-assign", {
		description:
			"Assign models to subagent profiles, the compactor, and the spawn default (interface reads models.json + your llama server)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/model-assign is only available in interactive mode.", "warning");
				return;
			}
			const { candidates } = await evalModelContext();
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				return new ModelAssignUI({
					theme,
					candidates,
					rows: tui.terminal.rows,
					cols: tui.terminal.columns,
					getFields: () => buildFields(ctx),
					onApply: (field, value) => applyField(ctx, field, value),
					onNotify: (message) => ctx.ui.notify(message, "info"),
					requestRender: () => tui.requestRender(),
					done: () => done(),
				});
			});
		},
	});
}
