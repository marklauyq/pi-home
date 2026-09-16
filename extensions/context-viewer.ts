/**
 * Context Viewer Extension
 *
 * Captures and displays the system prompt / initial context sent to the LLM.
 *
 * Captures:
 *   - "initial" — Pi-level system prompt from the FIRST agent_start of the
 *     session (this is the context that accompanies the first model request)
 *   - "live"    — system prompt parsed from the most recent provider payload
 *     on before_provider_request (may include compaction/summary requests)
 *
 * Features:
 *   - One-line widget above the editor showing char counts
 *   - /context command: view initial (default) or live prompt in a scrollable
 *     overlay, or save to a temp file
 *
 * Usage:
 *   /context            → view initial prompt (scrollable overlay in TUI)
 *   /context live       → view most recent provider-level prompt
 *   /context save       → save initial prompt to a temp file
 *   /context save live  → save most recent prompt to a temp file
 *
 * Note: command handlers have no return value in pi — all user-facing output
 * goes through ctx.ui (custom overlay / notify).
 */
import {
  DynamicBorder,
  getMarkdownTheme,
  highlightCode,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Scrollable prompt viewer component ─────────────────────────────────────

interface ViewerOptions {
  rows: number;
  cols: number;
  theme: any; // pi UI theme (fg, bold, dim, ...)
  title: string;
  lines: string[];
  requestRender: () => void;
  done: (result?: unknown) => void;
}

class PromptViewer implements Component {
  private opts: ViewerOptions;
  private frameH: number;
  private bodyH: number;
  private scrollTop = 0;
  private border: DynamicBorder;

  constructor(opts: ViewerOptions) {
    this.opts = opts;
    this.frameH = Math.max(12, Math.min(opts.rows - 4, 40));
    this.bodyH = this.frameH - 4;
    this.border = new DynamicBorder((s) => opts.theme.fg("dim", s));
  }

  invalidate(): void {
    /* nothing cached */
  }

  handleInput(data: string): void {
    const max = Math.max(0, this.opts.lines.length - this.bodyH + 1);
    if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "q")) {
      this.opts.done();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollTop = Math.max(0, this.scrollTop - 1);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollTop = Math.min(max, this.scrollTop + 1);
    } else if (matchesKey(data, "space")) {
      this.scrollTop = Math.min(max, this.scrollTop + this.bodyH - 1);
    } else if (matchesKey(data, "b")) {
      this.scrollTop = Math.max(0, this.scrollTop - (this.bodyH - 1));
    } else if (matchesKey(data, "g")) {
      this.scrollTop = 0;
    } else if (matchesKey(data, "shift+g")) {
      this.scrollTop = max;
    } else {
      return;
    }
    this.opts.requestRender();
  }

  render(width: number): string[] {
    const t = this.opts.theme;
    const lines: string[] = [this.border.render(width)[0] ?? ""];
    const title = t.fg("accent", t.bold("System prompt")) + t.fg("dim", ` — ${this.opts.title}`);
    lines.push(truncateToWidth(title, width, "…"));
    const body: string[] = this.opts.lines
      .slice(this.scrollTop, this.scrollTop + this.bodyH - 1)
      .map((l) => " " + l);
    if (this.opts.lines.length > this.bodyH - 1) {
      const pos = `${Math.min(this.opts.lines.length, this.scrollTop + this.bodyH - 1)}/${this.opts.lines.length}`;
      body.push(t.fg("dim", `  … ${pos} …`));
    }
    while (body.length < this.bodyH) body.push("");
    lines.push(...body);
    lines.push(" " + t.fg("dim", "↑↓/jk scroll · space/b page · g/G top/bottom · q/enter/esc close"));
    lines.push(this.border.render(width)[0] ?? "");
    while (lines.length < this.frameH) lines.push("");
    return lines.slice(0, this.frameH);
  }
}

/** Render a prompt string into TUI lines (markdown-aware, with fallbacks). */
function renderPromptLines(text: string, cols: number, theme: any): string[] {
  try {
    const md = new Markdown(text, 1, 0, {
      ...getMarkdownTheme(),
      highlightCode: (code: string, lang?: string) => {
        try {
          return highlightCode(code, lang);
        } catch {
          return undefined;
        }
      },
    });
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const lines = md.render(Math.max(20, cols - 4)).filter((l) => !/^\s*```[\w-]*\s*$/.test(stripAnsi(l)));
    if (lines.length > 0) return lines;
  } catch {
    /* fall through to plain text */
  }
  return text.split("\n");
}

/** Write prompt to a fresh temp dir; returns the file path. Throws on failure. */
function savePromptToFile(prompt: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-context-"));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(dir, `pi-context-${timestamp}.txt`);
  writeFileSync(filePath, prompt, "utf-8");
  return filePath;
}

/** Rough token estimate (~4 chars/token) for display, e.g. "~4.3k tok". */
function roughTokens(chars: number): string {
  const t = Math.round(chars / 4);
  return t >= 1000 ? `~${(t / 1000).toFixed(1).replace(/\.0$/, "")}k tok` : `~${t} tok`;
}

/** Human "N chars (~M tok)" size label. */
function sizeLabel(prompt: string): string {
  return `${prompt.length.toLocaleString()} chars (${roughTokens(prompt.length)})`;
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Closure state ────────────────────────────────────────────────────────

  /** Pi-level system prompt captured at the first agent_start of the session */
  let initialPrompt: string | undefined;
  let initialCapturedAt: number | undefined;
  let initialCaptured = false;

  /** Provider-level system prompt from the most recent before_provider_request */
  let lastPrompt: string | undefined;
  let lastCapturedAt: number | undefined;

  // ── Extraction helpers ───────────────────────────────────────────────────

  /** Convert message/system content (string or text-block array) to a string. */
  function contentToString(content: unknown): string | undefined {
    if (typeof content === "string" && content.length > 0) return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (
          block != null &&
          typeof block === "object" &&
          "type" in block &&
          (block as Record<string, unknown>).type === "text" &&
          "text" in block &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          parts.push((block as Record<string, unknown>).text as string);
        }
      }
      if (parts.length > 0) return parts.join("\n\n");
    }
    return undefined;
  }

  /**
   * Extract the system prompt from a provider-level payload.
   *
   * Handles these shapes:
   *   1. payload.system is a plain string (Anthropic)
   *   2. payload.system is an array of text blocks
   *   3. first message with role "system" or "developer" (OpenAI-compatible)
   *
   * Returns undefined if no system prompt is found.
   */
  function extractSystemPrompt(payload: unknown): string | undefined {
    if (payload == null || typeof payload !== "object") return undefined;

    const obj = payload as Record<string, unknown>;

    // ── Anthropic: payload.system (string or array of blocks) ────────────
    if (obj.system != null) {
      const system = obj.system;

      // Plain string
      if (typeof system === "string" && system.length > 0) {
        return system;
      }

      // Array of text blocks — join them
      if (Array.isArray(system)) {
        const joined = contentToString(system);
        if (joined != null) return joined;
      }
    }

    // ── OpenAI-compatible: first message with role "system" or "developer" ──
    // (some providers, e.g. OpenAI-compatible servers, use role "developer")
    if (Array.isArray(obj.messages)) {
      for (const msg of obj.messages) {
        if (
          msg != null &&
          typeof msg === "object" &&
          ((msg as Record<string, unknown>).role === "system" ||
            (msg as Record<string, unknown>).role === "developer")
        ) {
          const text = contentToString((msg as Record<string, unknown>).content);
          if (text != null) return text;
        }
      }
    }

    return undefined;
  }

  // ── Event handlers ───────────────────────────────────────────────────────

  /** On the first agent_start, capture the Pi-level system prompt (the
   * "initial context" that ships with the first model request). */
  pi.on("agent_start", (_event, ctx) => {
    if (!initialCaptured) {
      initialPrompt = ctx.getSystemPrompt();
      initialCapturedAt = Date.now();
      initialCaptured = true;
    }
    updateWidget(ctx);
  });

  /** On every provider request, extract and store the provider-level prompt. */
  pi.on("before_provider_request", (event, ctx) => {
    const prompt = extractSystemPrompt(event.payload);
    if (prompt != null) {
      lastPrompt = prompt;
      lastCapturedAt = Date.now();
    }
    updateWidget(ctx);
  });

  /** On session shutdown, clear the widget (closure state can persist). */
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setWidget("context-viewer", undefined);
  });

  // ── Widget ───────────────────────────────────────────────────────────────

  /** One-line widget above the editor showing captured char counts. */
  function updateWidget(ctx: { ui: { setWidget: (key: string, content: string[] | undefined) => void } }): void {
    let display: string;

    if (initialPrompt != null && lastPrompt != null) {
      display = `ctx: ${sizeLabel(initialPrompt)} (initial) · ${sizeLabel(lastPrompt)} (live)`;
    } else if (initialPrompt != null) {
      display = `ctx: ${sizeLabel(initialPrompt)} (initial)`;
    } else if (lastPrompt != null) {
      display = `ctx: ${sizeLabel(lastPrompt)} (live)`;
    } else {
      display = "ctx: — (waiting for first request)";
    }

    ctx.ui.setWidget("context-viewer", [display]);
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  pi.registerCommand("context", {
    description:
      "View captured system prompts: /context (initial), /context live (last request), /context save [live] (write to file)",
    handler: async (args: string, ctx) => {
      const parts = (args || "").trim().toLowerCase().split(/\s+/).filter(Boolean);

      // Validate args: [] | [live] | [save] | [save live]
      let mode: "initial" | "live" | "save" | "save-live";
      if (parts.length === 0) mode = "initial";
      else if (parts.length === 1 && parts[0] === "live") mode = "live";
      else if (parts.length === 1 && parts[0] === "save") mode = "save";
      else if (parts.length === 2 && parts[0] === "save" && parts[1] === "live") mode = "save-live";
      else {
        ctx.ui.notify?.("Usage: /context · /context live · /context save [live]", "warning");
        return;
      }

      const isLive = mode === "live" || mode === "save-live";
      const prompt = isLive ? lastPrompt : initialPrompt;
      const capturedAt = isLive ? lastCapturedAt : initialCapturedAt;
      const label = isLive ? "live (last provider request)" : "initial";

      if (prompt == null) {
        ctx.ui.notify?.(
          isLive
            ? "No provider-level prompt captured yet — it appears after the first model request."
            : "No initial prompt captured yet — it appears after the first agent start.",
          "warning",
        );
        return;
      }

      const stamp = capturedAt ? new Date(capturedAt).toLocaleTimeString() : "unknown";

      // ── save mode: write to temp file ──────────────────────────────────
      if (mode === "save" || mode === "save-live") {
        try {
          const filePath = savePromptToFile(prompt);
          ctx.ui.notify?.(`Saved ${label} prompt (${sizeLabel(prompt)}, ${stamp}) → ${filePath}`, "info");
        } catch (err) {
          ctx.ui.notify?.(`Failed to save prompt: ${(err as Error).message}`, "error");
        }
        return;
      }

      // ── view mode: scrollable overlay in TUI; file fallback otherwise ──
      if (ctx.mode !== "tui") {
        // Non-interactive (e.g. -p mode): write to file and report the path.
        try {
          const filePath = savePromptToFile(prompt);
          ctx.ui.notify?.(`(non-interactive) ${label} prompt written to ${filePath}`, "info");
        } catch (err) {
          ctx.ui.notify?.(`Failed to save prompt: ${(err as Error).message}`, "error");
        }
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        return new PromptViewer({
          rows: tui.terminal.rows,
          cols: tui.terminal.columns,
          theme,
          title: `${label} · ${stamp} · ${sizeLabel(prompt)}`,
          lines: renderPromptLines(prompt, tui.terminal.columns, theme),
          requestRender: () => tui.requestRender(),
          done: (r) => done(r as unknown),
        });
      });
    },
  });
}
