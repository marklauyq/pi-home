/**
 * pi Cat Header
 *
 * Replaces the built-in startup header with the official pi.dev block logo
 * alongside an ASCII cat logo, a tagline, and keybinding hints (all centered).
 *
 * Commands:
 *   /pi-header      (re)apply the big pi + cat header
 *   /builtin-header restore pi's built-in header
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// --- Art blocks (all single-width chars) ---

// Official pi.dev logo (geometric π: top bar, full left leg, mid stem,
// short right leg, square dot), 2x-scale of the SVG's 4x4 cell grid,
// 8 cols x 8 rows (no trailing spaces; padding added at render time)
const PI_ART = [
  "██████",
  "██████",
  "██  ██",
  "██  ██",
  "████  ██",
  "████  ██",
  "██    ██",
  "██    ██",
];
const PI_WIDTH = 8;

// ASCII cat (27 rows)
const CAT_ART = [
  "",
  "",
  "",
  "",
  "    \\    /\\",
  "     )  ( ')",
  "    (  /  )",
  "     \\(__)|"
];
const CAT_WIDTH = Math.max(...CAT_ART.map((l) => l.length));
const GAP = 2;
const CAT_START = PI_WIDTH + GAP; // cat column offset in side-by-side layout
const ART_WIDTH = CAT_START + CAT_WIDTH; // total side-by-side art width
const WIDE_MIN = ART_WIDTH; // min viewport width for side-by-side

function catLines(theme: Theme): string[] {
  return CAT_ART.map((l) => theme.fg("text", l));
}

class PiCatHeader {
  private theme: Theme;

  constructor(theme: Theme) {
    this.theme = theme;
  }

  render(width: number): string[] {
    const th = this.theme;
    const pi = PI_ART.map((l) => th.bold(th.fg("accent", l)));
    const cat = catLines(th);

    // NOTE: pad/center by VISIBLE width — styled lines carry ANSI bytes and
    // s.length would make the pad math always collapse to 0.
    const center = (s: string) => " ".repeat(Math.max(0, Math.floor((width - visibleWidth(s)) / 2))) + s;

    const lines: string[] = [];

    // Side-by-side when the terminal is wide enough (cat top-aligned with the pi),
    // the whole block centered horizontally
    if (width >= WIDE_MIN) {
      const off = Math.max(0, Math.floor((width - ART_WIDTH) / 2));
      const lead = " ".repeat(off);
      const gap = " ".repeat(GAP);
      const rows = Math.max(pi.length, cat.length);
      for (let i = 0; i < rows; i++) {
        const piLine = i < pi.length ? pi[i] : "";
        const catLine = i < cat.length ? cat[i] : "";
        lines.push(lead + piLine + " ".repeat(Math.max(0, PI_WIDTH - piLine.length)) + gap + catLine);
      }
    } else {
      const off1 = " ".repeat(Math.max(0, Math.floor((width - PI_WIDTH) / 2)));
      const off2 = " ".repeat(Math.max(0, Math.floor((width - CAT_WIDTH) / 2)));
      lines.push(...pi.map((l) => off1 + l), "");
      lines.push(...cat.map((l) => off2 + l));
    }

    // Tagline + keybinding hints (centered)
    lines.push(
      center(th.bold(th.fg("accent", "π")) + " " + th.fg("muted", "coding agent") + th.fg("dim", ` v${VERSION}`)),
    );
    const hint = (key: string, desc: string) => `${th.fg("dim", key)} ${th.fg("muted", desc)}`;
    const sep = th.fg("muted", " · ");
    const hintLine =
      hint("esc", "interrupt") + sep + hint("/", "commands") + sep + hint("!", "bash") + sep + hint("ctrl+p", "cycle model");
    // Drop the hint line entirely when it cannot fit (better than a chopped hint)
    if (visibleWidth(hintLine) <= width) {
      lines.push(center(hintLine));
    }

    // Safety net: pi treats any rendered line wider than the terminal as fatal,
    // so guarantee every line fits the viewport.
    return lines.map((l) => truncateToWidth(l, width));
  }

  invalidate(): void {}
  dispose(): void {}
}

function applyHeader(
  ctx: { ui: { setHeader: (f: unknown) => void; notify: (msg: string, kind: "info") => void }; mode: string },
) {
  if (ctx.mode !== "tui") return;
  ctx.ui.setHeader((_tui: unknown, theme: Theme) => new PiCatHeader(theme));
  ctx.ui.notify("pi cat header enabled", "info");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    applyHeader(ctx);
  });

  pi.registerCommand("pi-header", {
    description: "Show the big pi + ASCII cat header",
    handler: async (_args, ctx) => {
      applyHeader(ctx);
    },
  });

  pi.registerCommand("builtin-header", {
    description: "Restore the built-in pi header",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in header restored", "info");
    },
  });
}
