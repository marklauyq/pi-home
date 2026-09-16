/**
 * my-compact — run pi's built-in compaction with a configured model
 * and thinking level (e.g. summarize with a smaller local model, or disable
 * thinking for summarization while keeping it on for normal turns).
 *
 * Config in `~/.pi/agent/settings.json` (or `<project>/.pi/settings.json`;
 * project wins per field):
 *
 *   "myCompact": {
 *     "model": "llama-server/qwen35b-nvfp4",  // provider/modelId; omit → built-in compaction
 *     "thinkingLevel": "off"                  // off|minimal|low|medium|high|xhigh|max; omit → session level
 *   }
 *
 * Legacy key "customCompaction" is still honored ("myCompact" wins if both present).
 *
 * Reuses the built-in `compact()` (structured summary format, file tracking,
 * split-turn handling, iterative previous-summary merge) and only overrides
 * the model and thinking level. Falls back to built-in compaction (returning
 * undefined) when the model is unknown, auth is missing, or the call errors.
 * Applies to manual /compact, auto-compaction, and overflow recovery.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	compact,
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface CustomCompactionConfig {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asThinkingLevel(v: unknown): ThinkingLevel | undefined {
	return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v)
		? (v as ThinkingLevel)
		: undefined;
}

/** Per-field merge: project settings win over global; missing/invalid → undefined. */
/** "myCompact" preferred; legacy "customCompaction" still honored. */
function compactSection(settings: any): any {
	return settings?.myCompact ?? settings?.customCompaction;
}

function loadConfig(ctx: ExtensionContext): CustomCompactionConfig {
	const global = compactSection(readJson(path.join(getAgentDir(), "settings.json")) as any);
	const project = compactSection(readJson(path.join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")) as any);
	const cfg: CustomCompactionConfig = {};
	if (project || global) {
		cfg.model = asString(project?.model) ?? asString(global?.model);
		cfg.thinkingLevel = asThinkingLevel(project?.thinkingLevel) ?? asThinkingLevel(global?.thinkingLevel);
	}
	return cfg;
}

/** ProviderHeaders may contain null (delete-header) values; compact() only takes string values. */
function withoutDeletedHeaders(
	headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) if (v !== null) out[k] = v;
	return out;
}

/** Mirror settings-manager retry defaults so transient stream drops behave like built-in compaction. */
function loadRetryPolicy(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
	const retry = (readJson(path.join(getAgentDir(), "settings.json")) as any)?.retry;
	return {
		enabled: typeof retry?.enabled === "boolean" ? retry.enabled : true,
		maxRetries: typeof retry?.maxRetries === "number" ? retry.maxRetries : 3,
		baseDelayMs: typeof retry?.baseDelayMs === "number" ? retry.baseDelayMs : 2000,
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		const cfg = loadConfig(ctx);
		if (!cfg.model) return; // not configured → built-in compaction

		// "provider/modelId" (modelId may itself contain "/")
		const slash = cfg.model.indexOf("/");
		if (slash <= 0) {
			ctx.ui.notify(`my-compact: model must be "provider/modelId" (got "${cfg.model}"); using default`, "warning");
			return;
		}
		const provider = cfg.model.slice(0, slash);
		const modelId = cfg.model.slice(slash + 1);

		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) {
			ctx.ui.notify(`my-compact: model "${cfg.model}" not found; using default`, "warning");
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`my-compact: no auth for ${cfg.model} (${auth.error}); using default`, "warning");
			return;
		}
		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		const thinkingLevel: ThinkingLevel = cfg.thinkingLevel ?? ctx.thinkingLevel ?? "off";

		try {
			ctx.ui.notify(`Compacting with ${provider}/${model.id} (thinking: ${thinkingLevel})`, "info");
			const result = await compact(
				event.preparation,
				requestModel,
				auth.apiKey,
				withoutDeletedHeaders(auth.headers),
				event.customInstructions,
				event.signal,
				thinkingLevel,
				undefined, // streamFn: default completeSimple, same as built-in when no custom stream is installed
				auth.env,
				loadRetryPolicy(),
			);
			return { compaction: result };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!event.signal.aborted) {
				ctx.ui.notify(`my-compact failed: ${message}; using default`, "error");
			}
			return; // undefined → session falls back to built-in compaction
		}
	});
}
