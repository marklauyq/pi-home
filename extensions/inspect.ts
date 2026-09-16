/**
 * inspect — give the agent eyes on its own extensions, automatically.
 *
 * Loads a pi extension file in an isolated child process (using pi's own jiti),
 * runs its factory against recording stubs, fires session_start, renders any
 * widgets, and captures setStatus/setWidget output + registrations + errors.
 *
 * Two entry points:
 *   - tool `inspect_extension(path)` — the model can call it explicitly.
 *   - a `tool_result` hook — after ANY write/edit of an extensions/*.ts file,
 *     it auto-runs and injects the report into the tool result. This is the key
 *     bit: the model cannot "forget" to verify; it always sees what it built.
 *
 * It never touches the live session — the target runs against stubs in a child
 * process, so inspecting is side-effect free for the running pi.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Child loader (ESM). Loads target via jiti, runs it against stubs, prints JSON.
const CHILD_LOADER = `
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
const [, , jitiStatic, target] = process.argv;
const report = { tools: [], commands: [], events: [], widgets: [], statuses: [], headers: [], errors: [] };
const lastStr = (a) => { const l = a[a.length - 1]; return typeof l === "string" ? l : ""; };
const theme = new Proxy(function () {}, { get: () => (...a) => lastStr(a), apply: (_t, _th, a) => lastStr(a) });
const tui = new Proxy(function () {}, { get: () => () => undefined, apply: () => undefined });
const sessionStart = [];
const widgets = [];
let headerVal = null;
const ctx = {
  cwd: process.cwd(), hasUI: false, mode: "tui",
  ui: new Proxy({
    theme,
    setWidget: (k, v, o) => widgets.push({ k, v, o }),
    setStatus: (k, t) => report.statuses.push({ key: k, text: t }),
    setHeader: (v) => { headerVal = v === undefined ? null : v; },
    notify() {}, confirm: async () => true,
    select: async () => null, input: async () => "", editor: async () => "",
    setTitle: () => {}, setEditorText: () => {},
  }, {
    get: (t, p) => p in t ? t[p] : () => undefined,
  }),
};
const pi = new Proxy({}, { get: (_t, p) => {
  if (p === "on") return (e, h) => { report.events.push(e); if (e === "session_start") sessionStart.push(h); };
  if (p === "registerTool") return (d) => report.tools.push((d && d.name) || "(unnamed)");
  if (p === "registerCommand") return (n) => report.commands.push(n);
  if (p === "events") return { on: () => () => {}, emit: () => {} };
  return () => undefined;
}});
try {
  const { createJiti } = await import(pathToFileURL(jitiStatic).href);
  // Mirror pi's real extension-loader aliases so value imports of the pi
  // packages (and typebox) resolve in isolation, matching the live runtime.
  const piRoot = path.resolve(jitiStatic, "..", "..", "..", "..");
  const alias = {
    "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
    "@mariozechner/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
  };
  const piRequire = createRequire(path.join(piRoot, "dist", "index.js"));
  // ESM-aware fallback: pi-ai & co ship import-only conditional exports that
  // CJS require.resolve cannot see (pi's real loader resolves them fine via
  // import.meta.resolve). Read the package's exports map directly.
  const resolveEsmSubpath = (packageName, subpath) => {
    const pkgDir = path.join(piRoot, "node_modules", packageName);
    let pj;
    try {
      pj = JSON.parse(
        fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
      );
    } catch {
      return undefined;
    }
    const key = subpath ? \`./\${subpath}\` : ".";
    const entry = pj.exports?.[key];
    const file =
      typeof entry === "string"
        ? entry
        : entry?.import ?? entry?.default ?? entry?.require;
    return typeof file === "string" ? path.join(pkgDir, file) : undefined;
  };
  for (const [name, spec] of [
    ["@earendil-works/pi-tui", "@earendil-works/pi-tui"],
    ["@earendil-works/pi-ai", "@earendil-works/pi-ai/compat"],
    ["typebox", "typebox"],
    ["@sinclair/typebox", "typebox"],
  ]) {
    try {
      alias[name] = piRequire.resolve(spec);
    } catch {
      const parts = spec.split("/");
      const scoped = spec.startsWith("@");
      const pkgName = scoped
        ? parts.slice(0, 2).join("/")
        : parts[0];
      const sub = parts.slice(scoped ? 2 : 1).join("/");
      const esm = resolveEsmSubpath(pkgName, sub);
      if (esm) alias[name] = esm;
    }
  }
  const jiti = createJiti(pathToFileURL(target).href, { moduleCache: false, alias });
  const factory = await jiti.import(target, { default: true });
  if (typeof factory !== "function") report.errors.push("no default-exported function");
  else {
    try { factory(pi); } catch (e) { report.errors.push("factory: " + ((e && e.message) || e)); }
    for (const h of sessionStart) {
      try { await h({ type: "session_start", reason: "reload" }, ctx); }
      catch (e) { report.errors.push("session_start: " + ((e && e.message) || e)); }
    }
    for (const w of widgets) {
      try {
        const lines = typeof w.v === "function" ? (w.v(tui, theme)?.render?.(80)) : w.v;
        report.widgets.push({ key: w.k, lines: Array.isArray(lines) ? lines : [String(lines)] });
      } catch (e) { report.widgets.push({ key: w.k, error: (e && e.message) || String(e) }); }
    }
    if (headerVal !== null) {
      try {
        const lines = typeof headerVal === "function" ? (headerVal(tui, theme)?.render?.(80)) : headerVal;
        report.headers.push({ lines: Array.isArray(lines) ? lines : [String(lines)] });
      } catch (e) { report.headers.push({ error: (e && e.message) || String(e) }); }
    }
  }
} catch (e) { report.errors.push("load: " + ((e && e.message) || e)); }
process.stdout.write(JSON.stringify(report));
`;

function jitiStaticPath(): string {
	return path.join(
		path.dirname(process.execPath),
		"..",
		"lib",
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"node_modules",
		"jiti",
		"lib",
		"jiti-static.mjs",
	);
}

interface InspectResult {
	text: string;
	hasError: boolean;
}

async function runInspect(pi: ExtensionAPI, abs: string, cwd: string): Promise<InspectResult> {
	if (!fs.existsSync(abs)) return { text: `inspect: file not found: ${abs}`, hasError: true };
	const jitiStatic = jitiStaticPath();
	if (!fs.existsSync(jitiStatic)) return { text: `inspect: could not locate jiti at ${jitiStatic}`, hasError: true };

	const loaderPath = path.join(os.tmpdir(), `pi-inspect-${process.pid}-${path.basename(abs)}.mjs`);
	fs.writeFileSync(loaderPath, CHILD_LOADER, "utf8");
	try {
		const res = await pi.exec(process.execPath, [loaderPath, jitiStatic, abs], { cwd, timeout: 30_000 });
		let report: any;
		try {
			report = JSON.parse(res.stdout.trim());
		} catch {
			return { text: `inspect: loader produced no parseable report.\nstdout: ${res.stdout}\nstderr: ${res.stderr}`, hasError: true };
		}

		const out: string[] = [];
		out.push(`Inspected: ${abs}`);
		out.push(`Tools:    ${report.tools?.length ? report.tools.join(", ") : "(none)"}`);
		out.push(`Commands: ${report.commands?.length ? report.commands.join(", ") : "(none)"}`);
		out.push(`Events:   ${report.events?.length ? [...new Set(report.events)].join(", ") : "(none)"}`);
		for (const s of report.statuses ?? []) out.push(`  [status ${s.key}] = ${JSON.stringify(s.text)}`);
		for (const h of report.headers ?? []) {
			if (h.error) out.push(`  [header] RENDER ERROR: ${h.error}`);
			else out.push(`  [header] renders:\n${(h.lines ?? []).map((l: string) => `    ${l}`).join("\n")}`);
		}
		out.push(`Widgets set: ${report.widgets?.length ?? 0}`);
		for (const w of report.widgets ?? []) {
			if (w.error) out.push(`  [widget ${w.key}] RENDER ERROR: ${w.error}`);
			else out.push(`  [widget ${w.key}] renders:\n${(w.lines ?? []).map((l: string) => `    ${l}`).join("\n")}`);
		}
		const hasError = (report.errors?.length ?? 0) > 0;
		if (hasError) {
			out.push(`\nERRORS:`);
			for (const e of report.errors) out.push(`  - ${e}`);
		}
		const renderedNothing =
			(report.widgets?.length ?? 0) === 0 && (report.statuses?.length ?? 0) === 0 &&
			(report.headers?.length ?? 0) === 0 && (report.tools?.length ?? 0) === 0;
		out.push(
			hasError
				? `\nVerdict: loaded WITH ERRORS — fix before declaring done.`
				: renderedNothing
					? `\nVerdict: loaded, but registered/rendered nothing observable — confirm it actually does something.`
					: `\nVerdict: loaded cleanly.`,
		);
		return { text: out.join("\n"), hasError };
	} finally {
		try {
			fs.unlinkSync(loaderPath);
		} catch {
			/* ignore */
		}
	}
}

function isExtensionFile(p: string | undefined): p is string {
	if (!p) return false;
	return p.endsWith(".ts") && /(^|[/\\])extensions[/\\]/.test(p);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "inspect_extension",
		label: "Inspect Extension",
		description:
			"Load a pi extension file in isolation and report what it registers (tools, commands, events) and exactly what its widgets/status render, plus any load/render errors. Verify an extension actually works before declaring it done.",
		promptSnippet:
			"inspect_extension(path) — load an extension in isolation and report its registrations, rendered output, and errors",
		promptGuidelines: [
			"To check whether any pi extension works (yours or an existing one), call inspect_extension on its file and read the rendered output and verdict — do not judge from the source alone.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the extension .ts file (absolute, or relative to the project root)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const abs = path.isAbsolute(params.path) ? params.path : path.resolve(ctx.cwd, params.path);
			const r = await runInspect(pi, abs, ctx.cwd);
			return { content: [{ type: "text", text: r.text }], isError: r.hasError };
		},
	});

	// Auto-verify: after writing/editing any extensions/*.ts file, inject the inspection.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (event.isError) return;
		const filePath = (event.input?.file_path ?? event.input?.path) as string | undefined;
		if (!isExtensionFile(filePath)) return;
		const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);

		const r = await runInspect(pi, abs, ctx.cwd);
		return {
			isError: r.hasError,
			content: [
				...event.content,
				{ type: "text" as const, text: `\n\n── auto-inspect (harness) ──\n${r.text}` },
			],
		};
	});
}
