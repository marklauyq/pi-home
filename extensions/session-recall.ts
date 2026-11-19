/**
 * session-recall — re-read a session and feed it back into agent context.
 *
 * Two tools (agent-facing, no user command):
 *
 *   session_recall   — cheap overview of this session (or another .jsonl
 *                      session file): every recallable entry truncated to
 *                      small per-role caps, filterable (filter/head/tail/
 *                      search/toolName). Filters match on FULL text;
 *                      truncation happens last.
 *   session_message  — full (bounded) text of one entry, by #index (from
 *                      session_recall) or entry id.
 *
 * Entry lines carry a stable handle: `#N` position in the active branch
 * (append-only growth keeps earlier positions stable) plus the 8-char
 * entry id, e.g. `[u #3:95c63bbf 14:17] …`
 */
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { basename } from "node:path";

// ── types ────────────────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: "text"; text: string }> };
type MsgBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
};
type AnyMessage = {
  role: string;
  content?: unknown;
  toolName?: string;
  isError?: boolean;
};

// per-entry caps for the overview (chars)
const CAP_USER = 300;
const CAP_ASSISTANT = 300;
const CAP_TOOL_RESULT = 200;
const CAP_COMPACT = 400;
const CAP_CALL_LINE = 120;

// ── small helpers ────────────────────────────────────────────────────────────

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + ` …[${text.length - max} more chars]`;
}

function fmtTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function blocksOf(content: unknown): MsgBlock[] {
  return Array.isArray(content) ? (content as MsgBlock[]) : [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function thinkingOf(content: unknown): string {
  return blocksOf(content)
    .filter((b) => b.type === "thinking" && typeof b.thinking === "string")
    .map((b) => b.thinking as string)
    .join("\n");
}

function callsOf(content: unknown): MsgBlock[] {
  return blocksOf(content).filter((b) => b.type === "toolCall");
}

function imageCount(content: unknown): number {
  return blocksOf(content).filter((b) => b.type === "image").length;
}

function oneLine(s: string, cap: number): string {
  return clip(s.replace(/\s+/g, " ").trim(), cap);
}

// ── entry classification ─────────────────────────────────────────────────────

function isRecallable(e: SessionEntry): boolean {
  return (
    e.type === "message" ||
    e.type === "compaction" ||
    e.type === "branch_summary" ||
    e.type === "custom_message"
  );
}

function roleOf(e: SessionEntry): string {
  if (e.type === "compaction") return "compaction";
  if (e.type === "branch_summary") return "branch_summary";
  if (e.type === "custom_message") return "custom_message";
  return ((e as { message?: AnyMessage }).message?.role ?? "unknown") as string;
}

/** Full, untruncated text of an entry — used for search matching. */
function entryFullText(e: SessionEntry): string {
  if (e.type === "message") {
    const m = e.message as AnyMessage;
    if (m.role === "toolResult") return `${m.toolName ?? ""}\n${textOf(m.content)}`;
    let t = textOf(m.content);
    for (const c of callsOf(m.content)) t += `\n${c.name ?? "?"} ${JSON.stringify(c.arguments ?? {})}`;
    return t;
  }
  if (e.type === "compaction") return String((e as { summary?: unknown }).summary ?? "");
  if (e.type === "branch_summary") return String((e as { summary?: unknown }).summary ?? "");
  if (e.type === "custom_message") {
    const c = (e as { content?: unknown }).content;
    return typeof c === "string" ? c : textOf(c);
  }
  return "";
}

// ── rendering ────────────────────────────────────────────────────────────────

function shortLine(e: SessionEntry, idx: number): string {
  const id = (e.id ?? "").slice(0, 8);
  const when = fmtTime(e.timestamp);
  const tag = when ? `${when} ` : "";

  if (e.type === "compaction") {
    const tokens = (e as { tokensBefore?: number }).tokensBefore;
    const s = clip(String((e as { summary?: unknown }).summary ?? ""), CAP_COMPACT);
    return `[c #${idx}:${id}] ${tag}COMPACT${tokens != null ? ` (was ${Math.round(tokens / 1000)}k tokens)` : ""} — ${s}`;
  }
  if (e.type === "branch_summary") {
    const s = clip(String((e as { summary?: unknown }).summary ?? ""), CAP_COMPACT);
    return `[c #${idx}:${id}] ${tag}BRANCH-SUMMARY — ${s}`;
  }
  if (e.type === "custom_message") {
    const c = (e as { content?: unknown; customType?: string }).content;
    const s = clip(typeof c === "string" ? c : textOf(c), CAP_USER);
    return `[x #${idx}:${id}] ${tag}CUSTOM:${(e as { customType?: string }).customType ?? "?"} — ${s}`;
  }

  const m = e.message as AnyMessage;
  if (m.role === "user") {
    const t = textOf(m.content);
    const imgs = imageCount(m.content);
    return `[u #${idx}:${id}] ${tag}${clip(t, CAP_USER) || "(non-text user message)"}${imgs ? ` [image x${imgs}]` : ""}`;
  }

  if (m.role === "toolResult") {
    return `[t #${idx}:${id}] ${tag}← ${m.toolName ?? "?"}${m.isError ? " (ERROR)" : ""} — ${clip(textOf(m.content), CAP_TOOL_RESULT) || "(no text)"}`;
  }

  // assistant
  const t = textOf(m.content);
  const lines: string[] = [
    `[a #${idx}:${id}] ${tag}${clip(t, CAP_ASSISTANT) || "(no text)"}`,
  ];
  const th = thinkingOf(m.content);
  if (th) lines[0] += ` [thinking ${th.length}ch]`;
  const imgs = imageCount(m.content);
  if (imgs) lines[0] += ` [image x${imgs}]`;
  for (const c of callsOf(m.content)) {
    const a = c.arguments;
    const raw =
      a && typeof a === "object"
        ? (() => {
            const o = a as Record<string, unknown>;
            const interesting = o.command ?? o.path ?? o.url ?? o.query ?? o.pattern ?? o.note ?? o.name;
            return typeof interesting === "string" ? interesting : JSON.stringify(o);
          })()
        : String(a ?? "");
    lines.push(`    → ${c.name ?? "?"}(${oneLine(raw, CAP_CALL_LINE)})`);
  }
  return lines.join("\n");
}

function fullText(e: SessionEntry, maxChars: number, includeThinking: boolean): string {
  if (e.type === "compaction") {
    const c = e as { summary?: unknown; tokensBefore?: number; firstKeptEntryId?: string };
    const parts = [String(c.summary ?? "")];
    if (c.tokensBefore != null) parts.push(`(tokensBefore: ${c.tokensBefore}${c.firstKeptEntryId ? `, firstKeptEntryId: ${c.firstKeptEntryId}` : ""})`);
    return clip(parts.join("\n"), maxChars);
  }
  if (e.type === "branch_summary") return clip(String((e as { summary?: unknown }).summary ?? ""), maxChars);
  if (e.type === "custom_message") {
    const c = (e as { content?: unknown }).content;
    return clip(typeof c === "string" ? c : textOf(c), maxChars);
  }

  const m = e.message as AnyMessage;
  if (m.role === "toolResult") {
    const t = textOf(m.content);
    return `${m.isError ? "ERROR: " : ""}${clip(t, maxChars) || "(no text)"}`;
  }

  if (m.role === "assistant") {
    const parts: string[] = [];
    const t = textOf(m.content);
    parts.push(t ? clip(t, maxChars) : "(no text)");
    const th = thinkingOf(m.content);
    if (th) {
      parts.push(
        includeThinking
          ? `--- thinking ---\n${clip(th, maxChars)}`
          : `[thinking: ${th.length} chars omitted; re-call with thinking: true]`,
      );
    }
    for (const c of callsOf(m.content)) {
      parts.push(`--- toolCall ${c.name ?? "?"} ---\n${clip(JSON.stringify(c.arguments ?? {}, null, 1), Math.min(4000, maxChars))}`);
    }
    return parts.join("\n");
  }

  // user (default)
  return clip(textOf(m.content) || "(non-text user message)", maxChars);
}

// ── session loading ──────────────────────────────────────────────────────────

/** getBranch() order differs across pi versions (root-first or leaf-first); normalize to chronological. */
function branchChrono(sm: SessionManager): SessionEntry[] {
  const b = sm.getBranch() as SessionEntry[];
  if (b.length > 1) {
    const first = Date.parse(b[0].timestamp ?? "");
    const last = Date.parse(b[b.length - 1].timestamp ?? "");
    if (Number.isFinite(first) && Number.isFinite(last) && first > last) b.reverse();
  }
  return b;
}

function loadEntries(path: string | undefined, ctx: ExtensionContext): { entries?: SessionEntry[]; label?: string; error?: string } {
  if (path) {
    if (!path.endsWith(".jsonl")) return { error: `path must be a .jsonl session file (got "${path}")` };
    if (!existsSync(path)) return { error: `no such file: ${path}` };
    let sm: SessionManager;
    try {
      sm = SessionManager.open(path);
    } catch (e) {
      return { error: `failed to open session: ${(e as Error).message}` };
    }
    return { entries: branchChrono(sm), label: basename(path) };
  }
  const sm = ctx.sessionManager;
  const file = sm.getSessionFile();
  return { entries: branchChrono(sm), label: file ? basename(file) : "(current session, unsaved)" };
}

type Indexed = { e: SessionEntry; idx: number };

function recallableList(entries: SessionEntry[]): Indexed[] {
  return entries.map((e, i) => ({ e, idx: i + 1 })).filter((x) => isRecallable(x.e));
}

// fit lines into a char budget: keep head + tail, elide the middle
function fitLines(items: Indexed[], render: (x: Indexed) => string, budget: number): string[] {
  const rendered = items.map((x) => ({ idx: x.idx, text: render(x) }));
  const total = rendered.reduce((n, l) => n + l.text.length + 1, 0);
  if (total <= budget) return rendered.map((l) => l.text);

  const headBudget = Math.floor(budget * 0.5);
  const out: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < rendered.length; i++) {
    if (used + rendered[i].text.length + 1 > headBudget) break;
    out.push(rendered[i].text);
    used += rendered[i].text.length + 1;
  }
  const tailBudget = budget - used - 200;
  const tail: string[] = [];
  let usedT = 0;
  for (let j = rendered.length - 1; j > i; j--) {
    if (usedT + rendered[j].text.length + 1 > tailBudget) break;
    tail.unshift(rendered[j].text);
    usedT += rendered[j].text.length + 1;
  }
  const endIdx = rendered.length - tail.length;
  if (endIdx > i) {
    out.push(`[… elided ${endIdx - i} entries (#${rendered[i].idx}–#${rendered[endIdx - 1].idx}); narrow with head/tail/search]`);
  }
  out.push(...tail);
  return out;
}

function describeFilters(p: { filter?: string; head?: number; tail?: number; search?: string; toolName?: string }): string {
  const bits: string[] = [];
  bits.push(p.filter ?? "full");
  if (p.head != null) bits.push(`head ${p.head}`);
  if (p.tail != null) bits.push(`tail ${p.tail}`);
  if (p.search) bits.push(`search "${p.search}"`);
  if (p.toolName) bits.push(`tool ${p.toolName}`);
  return bits.join(", ");
}

// ── shared parameter fragments ───────────────────────────────────────────────

const pathParam = Type.Optional(
  Type.String({
    description:
      "Absolute path to a different .jsonl session file to read instead of the current session (e.g. an older session or a subagent transcript under ~/.pi/agent/sessions/).",
  }),
);
const toolNameParam = Type.Optional(
  Type.String({ description: 'Only tool results and assistant calls for this tool name, e.g. "bash".' }),
);

// ── extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "session_recall",
    label: "Session Recall",
    description:
      "Re-read this session (or another .jsonl session file via `path`) as a cheap overview: every user/assistant/tool-result/compaction entry truncated to a few hundred chars, numbered `#N:<entry-id>`. Filters match the FULL text, then lines are truncated. After locating an entry, call session_message with its #index or entry id for the untruncated text. Use after compaction to recover lost detail, before writing handoffs, or to re-check what the user asked.",
    parameters: Type.Object({
      filter: Type.Optional(
        Type.Union(
          [
            Type.Literal("full"),
            Type.Literal("user"),
            Type.Literal("assistant"),
            Type.Literal("tool"),
            Type.Literal("user-qns"),
          ],
          { description: 'Entry filter (default "full"). "user" and "user-qns" keep only user messages.' },
        ),
      ),
      head: Type.Optional(Type.Number({ minimum: 1, description: "First N entries (after filters)." })),
      tail: Type.Optional(Type.Number({ minimum: 1, description: "Last N entries (after filters)." })),
      search: Type.Optional(
        Type.String({ description: "Case-insensitive substring; keep only entries whose full text matches." }),
      ),
      toolName: toolNameParam,
      path: pathParam,
      maxChars: Type.Optional(
        Type.Number({ minimum: 500, description: "Total output budget in chars (default 60000); head+tail kept, middle elided." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.head != null && params.tail != null) {
        return ok("Error: use head OR tail, not both.");
      }
      const loaded = loadEntries(params.path, ctx);
      if (loaded.error) return ok(loaded.error);
      const all = recallableList(loaded.entries ?? []);
      if (all.length === 0) {
        return ok(`${loaded.label}: no recallable entries (empty session)`);
      }

      let sel = all;
      if (params.filter === "user" || params.filter === "user-qns") {
        sel = sel.filter((x) => roleOf(x.e) === "user");
      } else if (params.filter === "assistant") {
        sel = sel.filter((x) => roleOf(x.e) === "assistant");
      } else if (params.filter === "tool") {
        sel = sel.filter((x) => roleOf(x.e) === "toolResult");
      }
      if (params.toolName) {
        sel = sel.filter((x) => {
          if (roleOf(x.e) === "toolResult") {
            return ((x.e as { message?: AnyMessage }).message?.toolName ?? "") === params.toolName;
          }
          if (roleOf(x.e) === "assistant") {
            return callsOf((x.e as { message?: AnyMessage }).message?.content).some((c) => c.name === params.toolName);
          }
          return false;
        });
      }
      if (params.search) {
        const s = params.search.toLowerCase();
        sel = sel.filter((x) => entryFullText(x.e).toLowerCase().includes(s));
      }
      if (params.head != null) sel = sel.slice(0, params.head);
      if (params.tail != null) sel = sel.slice(-params.tail);

      if (sel.length === 0) {
        return ok(
          `${loaded.label}: no entries match (${describeFilters(params)}); the session has ${all.length} recallable entries, #1–#${all.length}`,
        );
      }

      const header = `=== session: ${loaded.label} | ${all.length} entries total, showing ${sel.length} | ${describeFilters(params)} ===`;
      const budget = params.maxChars ?? 60_000;
      const lines = fitLines(sel, (x) => shortLine(x.e, x.idx), budget - header.length - 1);
      return ok([header, ...lines].join("\n"));
    },
  });

  pi.registerTool({
    name: "session_message",
    label: "Session Message",
    description:
      "Show the full (bounded) text of one session entry — by #index from session_recall or by entry id. Use to expand an entry that was truncated in the overview: tool results, long user messages, assistant replies, compaction summaries.",
    parameters: Type.Object({
      index: Type.Union([Type.Number(), Type.String()], {
        description: 'Entry #index (e.g. 12 or "12") from session_recall, or its entry id (e.g. "95c63bbf").',
      }),
      path: pathParam,
      maxChars: Type.Optional(
        Type.Number({ minimum: 100, description: "Output budget in chars, head-preserved (default 20000)." }),
      ),
      thinking: Type.Optional(
        Type.Boolean({ description: "Include assistant thinking blocks (default false; they are only noted)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const loaded = loadEntries(params.path, ctx);
      if (loaded.error) return ok(loaded.error);
      const all = recallableList(loaded.entries ?? []);
      if (all.length === 0) return ok(`${loaded.label}: no recallable entries (empty session)`);

      const raw = params.index;
      let hit: Indexed | undefined;
      if (typeof raw === "number" && Number.isInteger(raw)) {
        hit = all.find((x) => x.idx === raw);
      } else {
        const s = String(raw).trim();
        hit = all.find((x) => (x.e.id ?? "") === s) ?? all.find((x) => (x.e.id ?? "").startsWith(s));
        if (!hit && /^\d+$/.test(s)) hit = all.find((x) => x.idx === Number(s));
      }
      if (!hit) {
        const lastIdx = all[all.length - 1].idx;
        return ok(
          `No entry "${String(raw)}" in ${loaded.label}. Valid: entry positions #1–#${lastIdx} (as printed by session_recall, with gaps) or an entry id like "${(all[0].e.id ?? "").slice(0, 8)}". Run session_recall (e.g. tail: 10) to see current indices.`,
        );
      }

      const maxChars = params.maxChars ?? 20_000;
      const body = fullText(hit.e, maxChars, params.thinking ?? false);
      return ok(`=== #${hit.idx}:${(hit.e.id ?? "").slice(0, 8)} [${roleOf(hit.e)}] ${hit.e.timestamp} ===\n${body}`);
    },
  });
}
