/**
 * /user-qns — list all questions you typed in this session.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";

type ContentBlock = { type?: string; text?: string };
type SessionEntry = {
	type: string;
	message?: { role?: string; content?: unknown };
};

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return (content as ContentBlock[])
		.filter((b) => b && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

function collectUserQuestions(entries: SessionEntry[]): string[] {
	const questions: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = extractText(entry.message.content);
		if (text) questions.push(text);
	}
	return questions;
}

function oneLine(text: string, max: number): string {
	const first = text.split("\n").find((l) => l.trim()) ?? "";
	return first.length > max ? first.slice(0, max - 1) + "…" : first;
}

function formatTime(entry: { timestamp?: string }): string {
	if (!entry?.timestamp) return "";
	const d = new Date(entry.timestamp);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function showFullQuestion(title: string, body: string, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(new Markdown(body, 1, 1, getMarkdownTheme()));
		container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
		container.addChild(border);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("user-qns", {
		description: "List all questions you typed in this session",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getBranch() as SessionEntry[];
			const questions = collectUserQuestions(entries);

			if (questions.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("No user questions in this session yet", "info");
				else console.log("No user questions in this session yet");
				return;
			}

			if (ctx.mode !== "tui") {
				// Non-TUI: plain printout
				questions.forEach((q, i) => console.log(`#${i + 1} ${oneLine(q, 200)}`));
				return;
			}

			const times: (string | undefined)[] = entries
				.filter((e) => e.type === "message" && e.message?.role === "user")
				.map((e) => (e as { timestamp?: string }).timestamp)
				.map(formatTime);

			const items = questions.map((q, i) => {
				const time = times[i] ? `${times[i]}  ` : "";
				return `${time}#${i + 1}  ${oneLine(q, 100)}`;
			});

			const choice = await ctx.ui.select("Your questions (Enter to view full text)", items);
			if (choice === undefined) return;

			const index = items.indexOf(choice);
			if (index === -1) return;
			await showFullQuestion(`Question #${index + 1} of ${questions.length}`, questions[index], ctx);
		},
	});
}
