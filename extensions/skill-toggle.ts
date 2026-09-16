/**
 * skill-toggle — enable/disable skills via a git-tracked file.
 *
 * Config: <agentDir>/disabled-skills.json  (~/.pi/agent/disabled-skills.json)
 *   A JSON array of skill names, or {"disabled": [...]}:
 *   ["blender-iterate", "context-reset"]
 *
 * Disabled skills are:
 *   - removed from the <available_skills> block in the system prompt
 *     (recomputed on every agent start, so edits take effect on the
 *      very next prompt — no reload needed)
 *   - blocked if invoked via /skill:<name>
 *
 * Commands:
 *   /skill-off <name...>   disable skill(s) (add to file)
 *   /skill-on  <name...>   enable skill(s) (remove from file)
 *   /skill-disabled        list disabled skill names
 */
import {
  getAgentDir,
  formatSkillsForPrompt,
  type ExtensionAPI,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const CONFIG_PATH = join(getAgentDir(), "disabled-skills.json");

function atomicWrite(path: string, json: string): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, json, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

let configParseError: string | undefined;

function readDisabled(): Set<string> {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    configParseError = undefined;
    const parsed = JSON.parse(raw);
    const list: unknown = Array.isArray(parsed) ? parsed : (parsed as { disabled?: unknown })?.disabled;
    if (Array.isArray(list)) {
      return new Set(list.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean));
    }
    configParseError = `expected a JSON array of skill names (or {"disabled": [...]}) in ${CONFIG_PATH}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      configParseError = undefined;
      return new Set();
    }
    configParseError = (err as Error).message;
  }
  return new Set();
}

/** Surface a broken config file once, from a context that can notify. */
function surfaceConfigError(ctx: { ui?: { notify?: (msg: string, kind?: "info" | "warning" | "error") => void } }): void {
  if (configParseError) {
    const msg = `disabled-skills.json is not valid — nothing is currently disabled. ${configParseError}`;
    console.error(`[skill-toggle] ${msg}`);
    ctx.ui?.notify?.(msg, "error");
  }
}

function writeDisabled(set: Set<string>): void {
  atomicWrite(CONFIG_PATH, `${JSON.stringify([...set].sort(), null, 2)}\n`);
}

const SKILL_NAME_RE = /^\/skill:(\S+)/;

function loadedSkillNames(ctx: { getSystemPromptOptions: () => { skills?: { name: string }[] } }): string[] {
  return (ctx.getSystemPromptOptions().skills ?? []).map((s) => s.name.toLowerCase());
}

export default function skillToggle(pi: ExtensionAPI) {
  // ---- filter the system prompt on every agent start ----------------------
  pi.on("before_agent_start", (event) => {
    const skills = event.systemPromptOptions.skills;
    if (!skills || skills.length === 0) return;
    const disabled = readDisabled();
    if (disabled.size === 0) return;

    const hidden = skills.filter((s) => disabled.has(s.name.toLowerCase()));
    if (hidden.length === 0) return;

    // The <available_skills> block was produced by pi with the same function
    // on the same skill objects, so this replaces it exactly.
    const oldBlock = formatSkillsForPrompt(skills);
    if (oldBlock === "") return; // nothing was in the prompt to begin with
    const newBlock = formatSkillsForPrompt(skills.filter((s) => !disabled.has(s.name.toLowerCase())));
    const prompt = event.systemPrompt.split(oldBlock).join(newBlock);
    if (prompt === event.systemPrompt) return; // block not present (e.g. no read tool)
    return { systemPrompt: prompt };
  });

  // ---- block /skill:<disabled-name> invocations ----------------------------
  pi.on("input", (event, ctx) => {
    const m = event.text.trim().match(SKILL_NAME_RE);
    if (!m) return;
    const disabled = readDisabled();
    if (!disabled.has(m[1].toLowerCase())) return;
    ctx.ui.notify?.(`Skill "${m[1]}" is disabled. /skill-on ${m[1]} to re-enable.`, "warning");
    return { action: "handled" as const };
  });

  // ---- management commands -------------------------------------------------
  const toggle = (args: string, add: boolean, ctx: { ui?: { notify?: (msg: string, kind?: "info" | "warning" | "error") => void }; getSystemPromptOptions: () => { skills?: { name: string }[] } }) => {
    const names = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (names.length === 0) {
      ctx.ui?.notify?.(`Usage: ${add ? "/skill-off" : "/skill-on"} <skill-name> [more-names...]`, "info");
      return;
    }
    const set = readDisabled();
    surfaceConfigError(ctx);
    const loaded = loadedSkillNames(ctx);
    let changed = 0;
    for (const name of names) {
      const present = set.has(name);
      if (present !== add) {
        if (add) set.add(name);
        else set.delete(name);
        changed++;
      }
      if (add && loaded.length > 0 && !loaded.includes(name) && !present) {
        ctx.ui?.notify?.(`Warning: "${name}" is not among the currently loaded skills.`, "warning");
      }
    }
    if (changed > 0) writeDisabled(set);
    ctx.ui?.notify?.(
      changed > 0
        ? `${add ? "Disabled" : "Enabled"}: ${names.join(", ")} (now ${set.size} disabled, effective from the next prompt)`
        : `Nothing to do${set.size === 0 ? "" : ` — ${set.size} skill(s) still disabled`}`,
      "info",
    );
  };

  pi.registerCommand("skill-off", {
    description: "Disable skills: /skill-off <name...> (removes them from the system prompt)",
    handler: (args, ctx) => toggle(args, true, ctx),
  });
  pi.registerCommand("skill-on", {
    description: "Re-enable skills: /skill-on <name...>",
    handler: (args, ctx) => toggle(args, false, ctx),
  });
  pi.registerCommand("skill-disabled", {
    description: "List disabled skill names",
    handler: (_args, ctx) => {
      const set = readDisabled();
      surfaceConfigError(ctx);
      ctx.ui?.notify?.(set.size === 0 ? "No skills disabled." : `Disabled (${set.size}): ${[...set].sort().join(", ")}`, "info");
    },
  });

  pi.registerCommand("skill-toggle", {
    description: "Interactive on/off list of all skills (space/enter toggles, writes disabled-skills.json)",
    handler: async (_args, ctx) => {
      const skills = ctx.getSystemPromptOptions().skills ?? [];
      if (ctx.mode !== "tui") {
        ctx.ui.notify?.("/skill-toggle needs the interactive TUI. Use /skill-off /skill-on instead.", "warning");
        return;
      }
      if (skills.length === 0) {
        ctx.ui.notify?.("No skills are loaded.", "info");
        return;
      }
      const disabled = readDisabled();
      surfaceConfigError(ctx);
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        return new SkillsToggleView({
          rows: tui.terminal.rows,
          cols: tui.terminal.columns,
          theme,
          skills,
          disabled,
          requestRender: () => tui.requestRender(),
          notify: (msg, kind) => ctx.ui.notify?.(msg, kind),
          done: (r) => done(r as unknown),
        });
      });
    },
  });
}

// ============================================================================
// TUI: checklist of skills, toggle on/off, persist to disabled-skills.json
// ============================================================================

interface ToggleViewOptions {
  rows: number;
  cols: number;
  theme: any; // pi UI theme (fg, bold, dim, ...)
  skills: Skill[];
  disabled: Set<string>; // lowercase names, mutated + persisted on toggle
  requestRender: () => void;
  notify: (msg: string, kind?: "info" | "warning" | "error") => void;
  done: (result?: unknown) => void;
}

class SkillsToggleView implements Component {
  private opts: ToggleViewOptions;
  private frameH: number;
  private bodyH: number;
  private filter = "";
  private index = 0;

  constructor(opts: ToggleViewOptions) {
    this.opts = opts;
    this.frameH = Math.max(12, Math.min(opts.rows - 4, 40));
    this.bodyH = this.frameH - 4;
  }

  private borderLine(width: number): string {
    return "┌" + "─".repeat(Math.max(0, width - 2)) + "┐";
  }

  private visible(): Skill[] {
    const f = this.filter.trim().toLowerCase();
    if (!f) return this.opts.skills;
    return this.opts.skills.filter((s) => s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f));
  }

  invalidate(): void {
    // static frame; nothing cached
  }

  handleInput(data: string): void {
    const items = this.visible();
    if (matchesKey(data, "escape")) {
      this.opts.done();
      return;
    }
    if (matchesKey(data, "up")) {
      this.index = items.length > 0 ? (this.index + items.length - 1) % items.length : 0;
      this.opts.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.index = items.length > 0 ? (this.index + 1) % items.length : 0;
      this.opts.requestRender();
      return;
    }
    if ((matchesKey(data, "space") || matchesKey(data, "enter")) && items.length > 0) {
      this.toggleSelected(items[this.index]);
      return;
    }
    if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
      this.filter = this.filter.slice(0, -1);
      this.clampIndex();
      this.opts.requestRender();
      return;
    }
    if (/^[\x20-\x7e]$/.test(data)) {
      this.filter += data;
      this.clampIndex();
      this.opts.requestRender();
      return;
    }
  }

  private clampIndex(): void {
    const n = this.visible().length;
    this.index = n === 0 ? 0 : Math.min(this.index, n - 1);
  }

  private toggleSelected(skill: Skill): void {
    const name = skill.name.toLowerCase();
    const next = new Set(this.opts.disabled);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    try {
      atomicWrite(CONFIG_PATH, `${JSON.stringify([...next].sort(), null, 2)}\n`);
      this.opts.disabled = next;
      this.opts.requestRender();
    } catch (err) {
      this.opts.notify(`Failed to update ${CONFIG_PATH}: ${(err as Error).message}`, "error");
    }
  }

  render(width: number): string[] {
    const t = this.opts.theme;
    const items = this.visible();
    const offCount = this.opts.skills.filter((s) => this.opts.disabled.has(s.name.toLowerCase())).length;
    const enabledCount = this.opts.skills.length - offCount;
    let title = t.fg("accent", t.bold("Skill Toggles")) + t.fg("dim", ` (${enabledCount} on · ${offCount} off)`);
    if (this.filter) title += t.fg("dim", `  filter: ${this.filter}`);

    const lines: string[] = [];
    lines.push(this.borderLine(width));
    lines.push(truncateToWidth(title, width, "…"));
    if (items.length === 0) {
      lines.push(t.fg("dim", "  (no skills match)"));
    } else {
      const maxPage = Math.max(0, items.length - this.bodyH);
      const scrollTop = Math.min(this.index, maxPage);
      for (let i = scrollTop; i < Math.min(items.length, scrollTop + this.bodyH - 1); i++) {
        lines.push(this.renderRow(items[i], i === this.index, width));
      }
      if (items.length > this.bodyH - 1) {
        lines.push(t.fg("dim", `  … ${Math.min(items.length, scrollTop + this.bodyH - 1)}/${items.length} …`));
      }
    }
    lines.push(" " + t.fg("dim", "↑↓ move · type to filter · space/enter toggle · esc close"));
    lines.push(this.borderLine(width));
    while (lines.length < this.frameH) lines.push("");
    return lines.slice(0, this.frameH);
  }

  private renderRow(skill: Skill, selected: boolean, width: number): string {
    const t = this.opts.theme;
    const on = !this.opts.disabled.has(skill.name.toLowerCase());
    const marker = on ? "[x]" : "[ ]";
    const desc = (skill.description.split("\n")[0] ?? "").trim();
    const prefix = selected ? t.fg("accent", ">") : " ";
    const markerCol = on ? t.fg("success", marker) : t.fg("dim", marker);
    const nameCol = on ? t.bold(skill.name) : t.fg("dim", t.bold(skill.name));
    const inner = `${markerCol} ${nameCol}${desc ? t.fg("dim", " — " + desc) : ""}`;
    return truncateToWidth(prefix + " " + inner, width, "…");
  }
}
