/**
 * Agents widget card — main-agent + subagent status rendered above the editor.
 *
 * While the main agent is running, its card shows an animated ASCII cat instead
 * of a "Main Agent / Running..." label: two poses (the header cat and the
 * "jgs" cat) swapped once per second. The subagent card and the throttled
 * subagent progress preview line are carried over from the old widget-card.
 *
 * Supersedes extensions/widget-card.ts (same cards, plus the cat animation).
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "agents-widget";

/** Cat poses, swapped every CAT_INTERVAL_MS while the main agent runs. */
const CAT_POSES: string[][] = [
  // The pi header cat (see pi-cat-header.ts).
  [
    "\\    /\\  ",
    " )  ( ') ",
    "(  /  )  ",
    " \\(__)|  ",
  ],
  // The new cat.
  [
    "/    /\\  ",
    "(   ( ') ",
    ")  /  )  ",
    " \\(__)|  ",
  ],
];
const CAT_INTERVAL_MS = 1000;

/**
 * Both poses are drawn on one canvas, LEFT-aligned (padded on the right), so the
 * leading spaces you type are exactly the leading spaces you get. Right-aligning
 * instead would reposition each row by its own length, which makes the whole cat
 * drift sideways on every frame swap.
 */
const CAT_CANVAS_WIDTH = Math.max(...CAT_POSES.flat().map((l) => l.length));
const CAT_FRAMES = CAT_POSES.map((pose) =>
  pose.map((l) => l + " ".repeat(CAT_CANVAS_WIDTH - l.length)),
);

/** Blank columns kept between the cat canvas and each card border. The card
 * centres the canvas, so this is the only knob for "more air around the cat"
 * — it widens the card, it never shifts the cat relative to the other frame. */
const CAT_SIDE_PADDING = 11;
const MAIN_CARD_WIDTH = Math.max(20, CAT_CANVAS_WIDTH + CAT_SIDE_PADDING * 2);
const SIDE_CARD_WIDTH = 32;
const CARD_GAP = 2;

// ---------------------------------------------------------------- state

let mainAgentActive = false;
let subagentRunning = 0;
let lastProgressData = "";
let frame = 0;

let timer: ReturnType<typeof setInterval> | null = null;
let tuiRef: any = null; // captured from the widget factory, for requestRender()
let uiRef: any = null;

function startAnimation() {
  if (timer) return;
  timer = setInterval(() => {
    frame = (frame + 1) % CAT_FRAMES.length;
    try {
      tuiRef?.requestRender?.();
    } catch {
      // TUI may be tearing down; the interval is cleared on agent_settled.
    }
  }, CAT_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

function stopAnimation() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ---------------------------------------------------------------- rendering

function formatProgress(data: any): string {
  const agent = data?.agent || "agent";
  const turns = data?.turns ?? 0;
  const out = (data?.output || "").replace(/\s+/g, " ").trim();
  const preview = out ? ` · ${out.slice(0, 60)}${out.length > 60 ? "…" : ""}` : "";
  return `${agent} · turn ${turns}${preview}`;
}

/** One card: border / optional title / body lines / spacer / border. */
interface Card {
  lines: string[];
  width: number;
  /** Background-filled row used to grow a short card to its row's height. */
  spacer: string;
}

function renderCard(
  title: string | null,
  body: string[],
  cardWidth: number,
  theme: Theme,
  bodyColor: "text" | "accent" = "text",
): Card {
  const border = theme.fg("borderAccent", "━".repeat(cardWidth));
  const bgLine = theme.bg("toolPendingBg", " ".repeat(cardWidth));
  const centered = (raw: string, styled?: string) => {
    const text = raw.length > cardWidth - 2 ? raw.slice(0, cardWidth - 2) : raw;
    const padLeft = Math.floor((cardWidth - text.length) / 2);
    const padRight = cardWidth - text.length - padLeft;
    // Pad on the raw string: styled strings carry ANSI bytes and s.length
    // would make the pad math collapse.
    return theme.bg(
      "toolPendingBg",
      " ".repeat(padLeft) + (styled ?? text) + " ".repeat(padRight),
    );
  };

  const lines = [border];
  if (title) {
    const raw = ` ${title} `;
    lines.push(
      centered(raw, theme.bold(theme.fg("accent", raw.length > cardWidth - 2 ? raw.slice(0, cardWidth - 2) : raw))),
    );
  }
  for (const line of body) lines.push(centered(line, theme.fg(bodyColor, line)));
  lines.push(bgLine, border);
  return { lines, width: cardWidth, spacer: bgLine };
}

/** Card widths shrink to the viewport; pi treats any line wider than the
 * terminal as fatal, so every rendered line is truncated as a safety net. */
function fitWidth(desired: number, width: number): number {
  return Math.max(8, Math.min(desired, width));
}

function buildCards(width: number, theme: Theme): string[] {
  const lines: string[] = [];
  if (lastProgressData) lines.push(truncateToWidth(theme.fg("muted", lastProgressData), width));

  const cards: Card[] = [];
  // Sub-agent card stays visible while any child runs, independently of the main agent.
  if (subagentRunning > 0) {
    cards.push(
      renderCard("Sub Agent", [`${subagentRunning} running`], fitWidth(SIDE_CARD_WIDTH, width), theme),
    );
  }
  // Main-agent card: the animated cat, no label.
  if (mainAgentActive) {
    cards.push(
      renderCard(null, CAT_FRAMES[frame], fitWidth(MAIN_CARD_WIDTH, width), theme, "accent"),
    );
  }
  if (cards.length === 0) return lines;

  // Group cards into rows, wrapping when the terminal width is exceeded.
  const rows: number[][] = [];
  let row: number[] = [];
  let rowWidth = 0;
  for (let j = 0; j < cards.length; j++) {
    const cardWidth = cards[j].width;
    const needed = row.length > 0 ? CARD_GAP + cardWidth : cardWidth;
    if (row.length > 0 && rowWidth + needed > width) {
      rows.push(row);
      row = [j];
      rowWidth = cardWidth;
    } else {
      row.push(j);
      rowWidth += row.length === 1 ? cardWidth : CARD_GAP + cardWidth;
    }
  }
  if (row.length > 0) rows.push(row);

  for (const group of rows) {
    // Equalise heights in the row: a short card grows with background rows
    // above its bottom border instead of ending early next to a taller one.
    const height = Math.max(...group.map((j) => cards[j].lines.length), 1);
    for (const j of group) {
      const card = cards[j];
      while (card.lines.length < height) card.lines.splice(card.lines.length - 1, 0, card.spacer);
    }
    for (let i = 0; i < height; i++) {
      const parts: string[] = [];
      for (let j = 0; j < group.length; j++) {
        const card = cards[group[j]].lines;
        parts.push(i < card.length ? card[i] : "");
        if (j < group.length - 1) parts.push(" ".repeat(CARD_GAP));
      }
      lines.push(parts.join(""));
    }
  }
  return lines.map((l) => truncateToWidth(l, width));
}

function paint() {
  const ui = uiRef;
  if (!ui) return;
  try {
    if (!mainAgentActive && subagentRunning === 0 && !lastProgressData) {
      ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    ui.setWidget(WIDGET_KEY, (tui: any, theme: Theme) => {
      tuiRef = tui;
      return {
        render: (width: number) => buildCards(width, theme),
        invalidate: () => {},
      };
    });
  } catch {
    // UI unavailable (print/RPC mode or teardown).
  }
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  // Subagent extension events: running count, throttled progress preview,
  // settlement notices. Subagents are background-from-spawn, so there is no
  // tool-call tracking to do here.
  pi.events.on("subagent/running", (data: any) => {
    subagentRunning = data?.running ?? 0;
    if (subagentRunning === 0) lastProgressData = "";
    paint();
  });

  pi.events.on("subagent/progress", (data: any) => {
    lastProgressData = formatProgress(data);
    paint();
  });

  pi.events.on("subagent/settled", () => paint());

  pi.on("session_start", (_event, ctx) => {
    mainAgentActive = false;
    subagentRunning = 0;
    lastProgressData = "";
    frame = 0;
    stopAnimation();
    uiRef = ctx.hasUI ? ctx.ui : null;
    paint();
  });

  pi.on("agent_start", (_event, ctx) => {
    uiRef = ctx.hasUI ? ctx.ui : uiRef;
    mainAgentActive = true;
    startAnimation();
    paint();
  });

  // agent_settled (not agent_end): pi may auto-retry / auto-compact / drain
  // queued follow-ups after agent_end, and the cat should keep running through
  // those gaps.
  pi.on("agent_settled", () => {
    mainAgentActive = false;
    stopAnimation();
    paint();
  });

  pi.on("session_shutdown", () => {
    stopAnimation();
    tuiRef = null;
    try {
      uiRef?.setWidget(WIDGET_KEY, undefined);
    } catch {
      // UI may already be gone.
    }
    uiRef = null;
    mainAgentActive = false;
    subagentRunning = 0;
    lastProgressData = "";
  });
}
