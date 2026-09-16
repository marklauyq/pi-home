/**
 * /skills-view — interactive browser for all skills the agent can see.
 *
 * - List view: every loaded skill (name + one-line description + scope),
 *   with live prefix filtering (type to filter, backspace to clear).
 * - Detail view: full SKILL.md content rendered as markdown, scrollable.
 *
 * Keys:
 *   list:   ↑/↓ move · type to filter · enter open · esc close
 *   detail: ↑/↓ or j/k scroll · space/b page · g/G top/bottom · q/enter/esc back
 */
import {
  getMarkdownTheme,
  getSelectListTheme,
  highlightCode,
  type ExtensionAPI,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";

interface ViewerOptions {
  rows: number;
  cols: number;
  theme: any; // pi UI theme (fg, bold, dim, ...)
  skills: Skill[];
  requestRender: () => void;
  done: (result?: unknown) => void;
}

class SkillsViewer implements Component {
  private opts: ViewerOptions;
  private frameH: number;
  private bodyH: number;
  private view: "list" | "detail" = "list";
  private filter = "";
  private selectList: SelectList;
  private detail: { skill: Skill; lines: string[]; scrollTop: number; error?: string } | null = null;

  constructor(opts: ViewerOptions) {
    this.opts = opts;
    this.frameH = Math.max(12, Math.min(opts.rows - 4, 40));
    this.bodyH = this.frameH - 4;

    const items: SelectItem[] = opts.skills.map((skill) => ({
      value: `${skill.name} ${skill.description}`,
      label: skill.name,
      description: this.itemDescription(skill),
    }));
    this.selectList = new SelectList(items, this.bodyH, getSelectListTheme(), {
      maxPrimaryColumnWidth: 32,
    });
    this.selectList.onSelect = (item) => this.openSelected(item);
    this.selectList.onCancel = () => this.opts.done();
  }

  private borderLine(width: number): string {
    return this.opts.theme.fg("dim", "─".repeat(Math.max(0, width)));
  }

  private openSelected(item?: SelectItem): void {
    if (!item) item = this.selectList.getSelectedItem();
    if (!item) return; // no match (e.g. active filter) — stay on the list
    const skill = this.opts.skills.find((s) => s.name === item.label);
    if (skill) this.openDetail(skill);
  }

  private itemDescription(skill: Skill): string {
    const tags: string[] = [skill.sourceInfo.scope];
    if (skill.disableModelInvocation) tags.push("model-hidden");
    const firstLine = skill.description.split("\n")[0] ?? "";
    return `${tags.join(" · ")} — ${firstLine}`;
  }

  private openDetail(skill?: Skill): void {
    if (!skill) {
      skill = this.opts.skills[0];
    }
    if (!skill) return;
    let lines: string[] = [];
    let error: string | undefined;
    try {
      const content = readFileSync(skill.filePath, "utf8");
      const md = new Markdown(content, 1, 0, {
        ...getMarkdownTheme(),
        highlightCode: (code: string, lang?: string) => {
          try {
            return highlightCode(code, lang);
          } catch {
            return undefined;
          }
        },
      });
      lines = md.render(Math.max(20, this.opts.cols - 4));
      if (!lines.length) lines = [themeFallback(content)];
    } catch (err) {
      error = `Could not read ${skill.filePath}: ${(err as Error).message}`;
      lines = [error];
    }
    this.detail = { skill, lines, scrollTop: 0, error };
    this.view = "detail";
    this.opts.requestRender();
  }

  invalidate(): void {
    this.selectList.invalidate();
  }

  handleInput(data: string): void {
    if (this.view === "list") {
      this.handleListKey(data);
      return;
    }
    this.handleDetailKey(data);
  }

  private handleListKey(data: string): void {
    if (matchesKey(data, "escape")) {
      this.opts.done();
      return;
    }
    if (matchesKey(data, "return")) {
      this.openSelected();
      return;
    }
    if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
      this.filter = this.filter.slice(0, -1);
      this.selectList.setFilter(this.filter);
      this.opts.requestRender();
      return;
    }
    // Printable characters build the filter.
    if (/^[\x20-\x7e]$/.test(data) && !data.startsWith("\x1b")) {
      this.filter += data;
      this.selectList.setFilter(this.filter);
      this.opts.requestRender();
      return;
    }
    this.selectList.handleInput(data);
    this.opts.requestRender();
  }

  private handleDetailKey(data: string): void {
    const d = this.detail;
    if (!d) return;
    const max = Math.max(0, d.lines.length - this.bodyH);
    if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "q")) {
      this.view = "list";
      this.detail = null;
      this.opts.requestRender();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      d.scrollTop = Math.max(0, d.scrollTop - 1);
      this.opts.requestRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      d.scrollTop = Math.min(max, d.scrollTop + 1);
      this.opts.requestRender();
      return;
    }
    if (matchesKey(data, "space")) {
      d.scrollTop = Math.min(max, d.scrollTop + this.bodyH - 1);
      this.opts.requestRender();
      return;
    }
    if (matchesKey(data, "b")) {
      d.scrollTop = Math.max(0, d.scrollTop - (this.bodyH - 1));
      this.opts.requestRender();
      return;
    }
    if (matchesKey(data, "g")) {
      d.scrollTop = 0;
      this.opts.requestRender();
      return;
    }
    if (matchesKey(data, "shift+g")) {
      d.scrollTop = max;
      this.opts.requestRender();
      return;
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(this.borderLine(width));
    if (this.view === "list") {
      lines.push(this.renderTitle(width, this.opts.skills.length, true));
      lines.push(...this.renderListBody(width));
    } else {
      const d = this.detail;
      const path = d ? d.skill.sourceInfo.path : "";
      lines.push(this.renderTitle(width, 1, false, d ? d.skill.name : "", path));
      lines.push(...this.renderDetailBody(width, d));
    }
    lines.push(this.renderHelp());
    lines.push(this.borderLine(width));
    // Pad/trim to a stable frame height so the layout never jumps.
    while (lines.length < this.frameH) lines.push("");
    return lines.slice(0, this.frameH);
  }

  private renderTitle(width: number, count: number, isList: boolean, skillName = "", path = ""): string {
    const t = this.opts.theme;
    let title = isList
      ? t.fg("accent", t.bold("Skills")) + t.fg("dim", ` (${count})`)
      : t.fg("accent", t.bold("Skill")) + " " + t.fg("accent", t.bold(skillName));
    if (!isList && path) {
      title += t.fg("dim", `  ${truncateToWidth(path, Math.max(8, width - visibleWidth(title) - 4), "…")}`);
    }
    if (isList && this.filter) {
      title += t.fg("dim", `  filter: ${this.filter}`);
    }
    return truncateToWidth(title, width, "…");
  }

  private renderListBody(width: number): string[] {
    const body = this.selectList.render(width - 2);
    const padded = [" ".repeat(1), ...body.map((l) => " " + l), " ".repeat(1)];
    return padTo(padded, this.bodyH);
  }

  private renderDetailBody(width: number, d: { lines: string[]; scrollTop: number; error?: string } | null): string[] {
    const t = this.opts.theme;
    if (!d) return padTo([], this.bodyH);
    const body: string[] = d.lines.slice(d.scrollTop, d.scrollTop + this.bodyH - 1).map((l) => " " + l);
    if (d.lines.length > this.bodyH - 1) {
      const pos = `${Math.min(d.lines.length, d.scrollTop + this.bodyH - 1)}/${d.lines.length}`;
      body.push(t.fg("dim", `  … ${pos} …`));
    }
    if (d.error) body.push(t.fg("error", "  " + d.error));
    return padTo(body, this.bodyH);
  }

  private renderHelp(): string {
    const t = this.opts.theme;
    const help =
      this.view === "list"
        ? "↑↓ move · type to filter · enter open · esc close"
        : "↑↓/jk scroll · space/b page · g/G top/bottom · q/enter/esc back";
    return " " + t.fg("dim", help);
  }
}

function padTo(lines: string[], height: number): string[] {
  const out = lines.slice(0, height);
  while (out.length < height) out.push("");
  return out;
}

function themeFallback(content: string): string[] {
  return content.split("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("skills-view", {
    description: "Browse all available skills: list, filter, and open to read the full SKILL.md",
    handler: async (_args, ctx) => {
      const skills = ctx.getSystemPromptOptions().skills ?? [];
      if (ctx.mode !== "tui") {
        ctx.ui.notify?.(`/skills-view is only available in interactive mode. ${skills.length} skill(s) loaded.`, "warning");
        return;
      }
      if (skills.length === 0) {
        ctx.ui.notify("No skills are loaded (check ~/.pi/agent/skills and settings).", "info");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        return new SkillsViewer({
          rows: tui.terminal.rows,
          cols: tui.terminal.columns,
          theme,
          skills,
          requestRender: () => tui.requestRender(),
          done: (r) => done(r as unknown),
        });
      });
    },
  });
}
