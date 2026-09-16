/**
 * /ext-view — interactive browser for all extensions in this agent's extensions dir.
 *
 * - List view: every extension (name + one-line description + kind),
 *   with live prefix filtering (type to filter, backspace to clear).
 * - Detail view: full source file rendered as a syntax-highlighted code block, scrollable.
 *
 * Keys:
 *   list:   ↑/↓ move · type to filter · enter open · esc close
 *   detail: ↑/↓ or j/k scroll · space/b page · g/G top/bottom · q/enter/esc back
 */
import {
  DynamicBorder,
  getMarkdownTheme,
  getSelectListTheme,
  highlightCode,
  type ExtensionAPI,
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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

interface ExtEntry {
  name: string;
  description: string;
  kind: "file" | "dir";
  filePath: string;
}

interface ViewerOptions {
  rows: number;
  cols: number;
  theme: any; // pi UI theme (fg, bold, dim, ...)
  extensions: ExtEntry[];
  requestRender: () => void;
  done: (result?: unknown) => void;
}

class ExtViewer implements Component {
  private opts: ViewerOptions;
  private frameH: number;
  private bodyH: number;
  private view: "list" | "detail" = "list";
  private filter = "";
  private selectList: SelectList;
  private detail: { ext: ExtEntry; lines: string[]; scrollTop: number; error?: string } | null = null;
  private border: DynamicBorder;

  constructor(opts: ViewerOptions) {
    this.opts = opts;
    this.frameH = Math.max(12, Math.min(opts.rows - 4, 40));
    this.bodyH = this.frameH - 4;
    this.border = new DynamicBorder((s) => opts.theme.fg("dim", s));

    const items: SelectItem[] = opts.extensions.map((ext) => ({
      value: `${ext.name} ${ext.description}`,
      label: ext.name,
      description: `${ext.kind} — ${ext.description.split("\n")[0] ?? ""}`,
    }));
    this.selectList = new SelectList(items, this.bodyH, getSelectListTheme(), {
      maxPrimaryColumnWidth: 28,
    });
    this.selectList.onSelect = (item) => this.openSelected(item);
    this.selectList.onCancel = () => this.opts.done();
  }

  private openSelected(item?: SelectItem): void {
    if (!item) item = this.selectList.getSelectedItem();
    if (!item) return; // no match (e.g. active filter) — stay on the list
    const ext = this.opts.extensions.find((e) => e.name === item.label);
    if (ext) this.openDetail(ext);
  }

  private openDetail(ext?: ExtEntry): void {
    if (!ext) ext = this.opts.extensions[0];
    if (!ext) return;
    let lines: string[] = [];
    let error: string | undefined;
    try {
      const content = readFileSync(ext.filePath, "utf8");
      const md = new Markdown("```ts\n" + content + "\n```", 1, 0, {
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
      lines = md
        .render(Math.max(20, this.opts.cols - 4))
        .filter((l) => !/^\s*```[\w-]*\s*$/.test(stripAnsi(l)));
      if (!lines.length) lines = ext.filePath.split("\n");
    } catch (err) {
      error = `Could not read ${ext.filePath}: ${(err as Error).message}`;
      lines = [error];
    }
    this.detail = { ext, lines, scrollTop: 0, error };
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
    lines.push(this.border.render(width)[0] ?? "");
    if (this.view === "list") {
      lines.push(this.renderTitle(width, this.opts.extensions.length, true));
      lines.push(...this.renderListBody(width));
    } else {
      const d = this.detail;
      const path = d ? d.ext.filePath : "";
      lines.push(this.renderTitle(width, 1, false, d ? d.ext.name : "", path));
      lines.push(...this.renderDetailBody(width, d));
    }
    lines.push(this.renderHelp());
    lines.push(this.border.render(width)[0] ?? "");
    // Pad/trim to a stable frame height so the layout never jumps.
    while (lines.length < this.frameH) lines.push("");
    return lines.slice(0, this.frameH);
  }

  private renderTitle(width: number, count: number, isList: boolean, extName = "", path = ""): string {
    const t = this.opts.theme;
    let title = isList
      ? t.fg("accent", t.bold("Extensions")) + t.fg("dim", ` (${count})`)
      : t.fg("accent", t.bold("Extension")) + " " + t.fg("accent", t.bold(extName));
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

  private renderDetailBody(
    width: number,
    d: { lines: string[]; scrollTop: number; error?: string } | null,
  ): string[] {
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

/** Extract a one-line description from a leading doc comment, falling back to the first // line. */
function extractDescription(source: string): string {
  const doc = source.match(/^\/\*\*\s*\n([\s\S]*?)\*\//);
  if (doc) {
    const first = doc[1]
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trim())
      .find((l) => l.length > 0);
    if (first) return first;
  }
  // Fallback: first plain // comment within the first 15 lines (avoids grabbing mid-file code comments).
  const plain = source
    .split("\n")
    .slice(0, 15)
    .find((l) => l.trimStart().startsWith("//") && !l.trimStart().startsWith("///"));
  if (plain) return plain.trim().replace(/^\/\/\s*/, "");
  return "(no description)";
}

function discoverExtensions(): ExtEntry[] {
  const extDir = dirname(__filename);
  const entries: ExtEntry[] = [];
  for (const dirent of readdirSync(extDir, { withFileTypes: true })) {
    const name = dirent.name;
    if (!name || name.startsWith("_")) continue;
    if (dirent.isFile() && name.endsWith(".ts")) {
      const path = join(extDir, name);
      let description = "(no description)";
      try {
        description = extractDescription(readFileSync(path, "utf8"));
      } catch {
        /* unreadable file — keep placeholder */
      }
      entries.push({ name: name.replace(/\.ts$/, ""), description, kind: "file", filePath: path });
    } else if (dirent.isDirectory()) {
      const indexPath = join(extDir, name, "index.ts");
      try {
        statSync(indexPath);
      } catch {
        continue; // not an extension directory
      }
      let description = "(no description)";
      try {
        description = extractDescription(readFileSync(indexPath, "utf8"));
      } catch {
        /* unreadable file — keep placeholder */
      }
      entries.push({ name, description, kind: "dir", filePath: indexPath });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("ext-view", {
    description: "Browse all loaded extensions: list, filter, and open to read the source",
    handler: async (_args, ctx) => {
      const extensions = discoverExtensions();
      if (ctx.mode !== "tui") {
        ctx.ui.notify?.(`/ext-view is only available in interactive mode. ${extensions.length} extension(s) found.`, "warning");
        return;
      }
      if (extensions.length === 0) {
        ctx.ui.notify("No extensions found in the extensions directory.", "info");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        return new ExtViewer({
          rows: tui.terminal.rows,
          cols: tui.terminal.columns,
          theme,
          extensions,
          requestRender: () => tui.requestRender(),
          done: (r) => done(r as unknown),
        });
      });
    },
  });
}
