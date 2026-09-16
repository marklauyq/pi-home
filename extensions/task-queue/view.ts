/**
 * /task — interactive task-queue view.
 *
 * One navigable list: in-progress on top, then blocked (⚠ = waiting on the
 * user), then queued, then recent history. No commands to memorize:
 *
 *   list mode    ↑↓ move · enter open · n new · p bump priority · x cancel · esc close
 *   detail mode  esc back · a answer open KIV question · p bump · x cancel
 *   answer mode  type · enter submit · esc back
 *   confirm mode y confirm cancel · n/esc dismiss
 *
 * The view is stateless between renders — it re-reads the queue on every
 * keypress, so anything the agent does concurrently is reflected live.
 */
import {
	DynamicBorder,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export interface TaskQueueSnapshot {
	tasks: import("./store.ts").Task[];
	sorted: import("./store.ts").Task[];
}

export interface TaskQueueViewActions {
	/** Close the view without further action. */
	close: () => void;
	/** User wants to add a new task; caller collects title/body then reopens. */
	newTask: () => void;
}

type Mode = "list" | "detail" | "confirm" | "answer";

interface AnswerState {
	taskId: string;
	questionId: number;
	prompt: string;
	text: string;
}

export class TaskQueueView implements Component {
	private container: Container;
	private actions: TaskQueueViewActions;
	private mode: Mode = "list";
	private cursor = 0;
	private detailTaskId: string | null = null;
	private confirmTaskId: string | null = null;
	private answer: AnswerState | null = null;
	private notice: string | null = null;

	constructor(
		private theme: Theme,
		private load: () => TaskQueueSnapshot,
		private act: (op: "cancel" | "bump", taskId: string) => void,
		private answerFn: (taskId: string, questionId: number, answer: string) => boolean,
		actions: TaskQueueViewActions,
		private closeView: () => void,
	) {
		this.actions = actions;
		this.container = new Container();
	}

	// ---------------------------------------------------------------- render

	render(width: number): string[] {
		const snap = this.load();
		const w = Math.max(width, 40);
		const lines: string[] = [];

		const border = new DynamicBorder((s: string) => this.theme.fg("accent", s));
		lines.push(...border.render(w).map((l) => l ?? ""));

		if (this.mode === "detail" && this.detailTaskId) {
			this.renderDetail(snap, w - 2, lines);
		} else if (this.mode === "list") {
			this.renderList(snap, w - 2, lines);
		}

		if (this.answer) {
			lines.push("");
			lines.push(
				this.theme.fg("accent", `${this.answer.prompt} `) +
					this.answer.text +
					this.theme.fg("accent", "▊"),
			);
		}
		if (this.notice) {
			lines.push(this.theme.fg("dim", this.notice));
		}

		const help =
			this.mode === "list"
				? "↑↓ move · enter open · n new · p bump · x cancel · esc close"
				: this.mode === "answer"
					? "type · enter submit · esc back"
					: this.mode === "confirm"
						? "y confirm · n/esc dismiss"
						: "esc back · a answer KIV · p bump · x cancel";
		lines.push(this.theme.fg("dim", help));

		lines.push(...border.render(w).map((l) => l ?? ""));
		return lines;
	}

	invalidate(): void {
		this.container.invalidate();
	}

	private statusLabel(t: import("./store.ts").Task): string {
		const open = t.questions.filter((x) => x.answer === null).length;
		switch (t.status) {
			case "in-progress":
				return this.theme.fg("accent", "● in-progress");
			case "blocked":
				return this.theme.fg("warning", `⚠ waiting on you${open ? ` (${open})` : ""}`);
			case "queued":
				return this.theme.fg("muted", `queued${t.priority > 0 ? ` +${t.priority}` : ""}`);
			case "done":
				return this.theme.fg("dim", "✓ done");
			case "cancelled":
				return this.theme.fg("dim", "✗ cancelled");
		}
	}

	private rowText(t: import("./store.ts").Task, selected: boolean): string {
		const prefix = selected ? this.theme.fg("accent", "▸") : " ";
		const title = t.title.length > 46 ? t.title.slice(0, 45) + "…" : t.title;
		return `${prefix} ${t.id}  ${this.statusLabel(t)}  ${title}`;
	}

	private renderList(snap: TaskQueueSnapshot, width: number, lines: string[]): void {
		const all = snap.sorted;
		const historyStart = all.findIndex((t) => t.status === "done" || t.status === "cancelled");
		const interactive = historyStart === -1 ? all : all.slice(0, historyStart);
		const history = all.slice(Math.max(historyStart, 0));

		this.cursor = Math.min(this.cursor, Math.max(interactive.length - 1, 0));

		lines.push(this.theme.bold("Task Queue") + this.theme.fg("dim", ` — ${all.length} task(s)`));
		lines.push("");
		if (all.length === 0) {
			lines.push(this.theme.fg("dim", "Empty. Press n to add a task."));
		}
		for (let i = 0; i < interactive.length; i++) {
			lines.push(this.rowText(interactive[i], i === this.cursor));
		}
		if (history.length > 0) {
			lines.push("");
			lines.push(this.theme.fg("dim", "history (last 5):"));
			const recent = history
				.slice()
				.reverse()
				.slice(0, 5);
			for (const t of recent) lines.push(this.rowText(t, false));
		}
	}

	private renderDetail(snap: TaskQueueSnapshot, width: number, lines: string[]): void {
		const t = snap.tasks.find((x) => x.id === this.detailTaskId);
		if (!t) {
			this.mode = "list";
			this.renderList(snap, width, lines);
			return;
		}
		lines.push(this.theme.bold(`${t.id}  ${t.title}`));
		lines.push(this.statusLabel(t));
		lines.push("");
		if (t.body) {
			for (const l of wrapTextWithAnsi(t.body, Math.max(width - 2, 20))) lines.push("  " + l);
		}
		if (t.questions.length > 0) {
			lines.push("");
			lines.push(this.theme.bold("KIV questions:"));
			for (const x of t.questions) {
				lines.push(`  ${this.theme.fg("accent", `Q${x.id}`)}: ${x.q}`);
				lines.push(
					"    " +
						(x.answer !== null
							? this.theme.fg("success", `A: ${x.answer}`)
							: this.theme.fg("warning", "A: (waiting — press a to answer)")),
				);
			}
		}
		const notes = t.history.filter((h) => h.event === "note");
		if (notes.length > 0) {
			lines.push("");
			lines.push(this.theme.bold("Notes:"));
			for (const n of notes.slice(-6)) lines.push(`  - ${n.detail}`);
		}
		if (t.result) {
			lines.push("");
			lines.push(this.theme.fg("success", `Result: ${t.result}`));
		}
		const recent = t.history
			.filter((h) => !["note"].includes(h.event))
			.slice(-5);
		if (recent.length > 0) {
			lines.push("");
			lines.push(this.theme.fg("dim", "history: " + recent.map((h) => h.event).join(" → ")));
		}
	}

	// ----------------------------------------------------------------- input

	handleInput(data: string): boolean {
		// Answer mode first — it owns every key.
		if (this.answer) {
			if (matchesKey(data, "escape")) {
				this.answer = null;
				this.mode = "detail";
				return true;
			}
			if (matchesKey(data, "enter")) {
				const text = this.answer.text.trim();
				const a = this.answer;
				this.answer = null;
				if (!text) {
					this.mode = "detail";
					this.notice = "Empty answer — discarded";
					return true;
				}
				const ok = this.answerFn(a.taskId, a.questionId, text);
				if (ok) {
					this.mode = "detail";
					this.notice = "Answer saved. " + this.nextOpenQuestion(a.taskId);
				} else {
					this.mode = "list";
					this.notice = null;
				}
				return true;
			}
			if (data === "\x7f" || data === "\x08") {
				this.answer.text = this.answer.text.slice(0, -1);
				return true;
			}
			if (data.length === 1 && data >= " " && data !== "\x1b") {
				this.answer.text += data;
				return true;
			}
			return false;
		}

		// Confirm (cancel) mode.
		if (this.mode === "confirm" && this.confirmTaskId) {
			if (matchesKey(data, "enter") || data === "y" || data === "Y") {
				const id = this.confirmTaskId;
				this.confirmTaskId = null;
				this.act("cancel", id);
				this.mode = this.detailTaskId ? "detail" : "list";
				this.notice = `${id} cancelled`;
				return true;
			}
			if (matchesKey(data, "escape") || data === "n" || data === "N") {
				this.confirmTaskId = null;
				this.mode = this.detailTaskId ? "detail" : "list";
				this.notice = null;
				return true;
			}
			if (matchesKey(data, "up") || matchesKey(data, "down")) return true;
			return false;
		}

		// Shared keys.
		if (matchesKey(data, "escape")) {
			if (this.mode === "detail") {
				this.mode = "list";
				this.notice = null;
				return true;
			}
			this.actions.close();
			this.closeView();
			return true;
		}
		this.notice = null;

		if (this.mode === "detail" && this.detailTaskId) {
			const t = this.load().tasks.find((x) => x.id === this.detailTaskId);
			if (data === "a" || data === "A") {
				const open = t?.questions.filter((x) => x.answer === null);
				if (open.length === 0) {
					this.notice = "No open KIV questions";
					return true;
				}
				const q = open[0];
				this.answer = {
					taskId: t!.id,
					questionId: q.id,
					prompt: `${t!.id} Q${q.id} >`,
					text: "",
				};
				this.mode = "answer";
				return true;
			}
			if (data === "p" || data === "P") {
				this.act("bump", t!.id);
				this.notice = `${t!.id} moved up in the queue`;
				return true;
			}
			if (data === "x" || data === "X") {
				if (t!.status === "done" || t!.status === "cancelled") {
					this.notice = "Already finished";
					return true;
				}
				this.confirmTaskId = t!.id;
				this.mode = "confirm";
				return true;
			}
		}

		if (this.mode === "list") {
			if (matchesKey(data, "up")) {
				this.cursor = Math.max(this.cursor - 1, 0);
				return true;
			}
			if (matchesKey(data, "down")) {
				this.cursor += 1; // clamped in renderList
				return true;
			}
			if (matchesKey(data, "enter")) {
				const snap = this.load();
				const all = snap.sorted;
				const historyStart = all.findIndex((t) => t.status === "done" || t.status === "cancelled");
				const interactive = historyStart === -1 ? all : all.slice(0, historyStart);
				const t = interactive[this.cursor];
				if (t) {
					this.detailTaskId = t.id;
					this.mode = "detail";
				}
				return true;
			}
			if (data === "n" || data === "N") {
				this.actions.newTask();
				return true;
			}
			if (data === "p" || data === "P") {
				const snap = this.load();
				const all = snap.sorted;
				const historyStart = all.findIndex((t) => t.status === "done" || t.status === "cancelled");
				const interactive = historyStart === -1 ? all : all.slice(0, historyStart);
				const t = interactive[this.cursor];
				if (!t) return true;
				if (t.status !== "queued") {
					this.notice = "Only queued tasks can be re-prioritized";
				} else {
					this.act("bump", t.id);
					this.notice = `${t.id} moved up in the queue`;
				}
				return true;
			}
			if (data === "x" || data === "X") {
				const snap = this.load();
				const all = snap.sorted;
				const historyStart = all.findIndex((t) => t.status === "done" || t.status === "cancelled");
				const interactive = historyStart === -1 ? all : all.slice(0, historyStart);
				const t = interactive[this.cursor];
				if (!t) return true;
				if (t.status === "done" || t.status === "cancelled") {
					this.notice = "Already finished";
				} else {
					this.confirmTaskId = t.id;
					this.mode = "confirm";
				}
				return true;
			}
		}
		return false;
	}

	private nextOpenQuestion(taskId: string): string {
		const t = this.load().tasks.find((x) => x.id === taskId);
		if (!t) return "";
		const open = t.questions.filter((x) => x.answer === null);
		if (open.length === 0) return "task is ready — it will start automatically.";
		return `${open.length} more question(s) to answer (a).`;
	}
}
