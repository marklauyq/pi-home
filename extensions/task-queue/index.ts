/**
 * /task — per-project task queue with KIV (keep-in-view) questions.
 *
 * - The agent works the queue through task_* tools; the user works it
 *   through the `/task` TUI view. Both share one on-disk source of truth
 *   (<cwd>/.pi/task-queue/tasks.json).
 * - Queued tasks are inert: the extension never steers the agent mid-task.
 *   When the agent fully settles (agent_settled, idle, no in-progress
 *   task), the extension nudges it to start the next queued task.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as store from "./store.ts";
import { TaskQueueView } from "./view.ts";

interface SessionState {
	/** Last time the agent itself called any task_* tool. */
	lastTaskToolUse: number;
	/** task id -> last auto-nudge time (anti-spam). */
	lastNudge: Map<string, number>;
}

const NUDGE_COOLDOWN_MS = 30 * 60 * 1000;

function textResult(text: string, details?: unknown) {
	return { content: [{ type: "text", text }], details };
}

export default function (pi: ExtensionAPI) {
	const state: Record<string, SessionState> = {};

	function st(ctx: ExtensionContext): SessionState {
		const key = ctx.sessionManager.getSessionFile() ?? "default";
		if (!state[key]) state[key] = { lastTaskToolUse: 0, lastNudge: new Map() };
		return state[key];
	}

	function refreshWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			const parts = store.widgetParts(ctx.cwd);
			const lines: string[] = [];
			if (parts.active) {
				const t = parts.active;
				lines.push(`${ctx.ui.theme.fg("accent", `● ${t.id}`)} ${t.title}`);
			}
			if (parts.queued.length > 0) {
				const ids = parts.queued
					.sort((a, b) => b.priority - a.priority || (a.createdAt < b.createdAt ? -1 : 1))
					.map((t) => t.id)
					.join(", ");
				lines.push(
					ctx.ui.theme.fg("muted", `queued: ${parts.queued.length} (${ids})`) +
						(parts.blocked.length
							? `  ${ctx.ui.theme.fg("warning", `⚠ ${parts.blocked.length} waiting on you`)}`
							: ""),
				);
			} else if (parts.blocked.length > 0) {
				const b = parts.blocked[0];
				const open = b.questions.filter((x) => x.answer === null).length;
				lines.push(
					ctx.ui.theme.fg("warning", `⚠ ${b.id}: ${open} KIV question(s) waiting on you`),
				);
			}
			ctx.ui.setWidget("task-queue", lines.length ? lines : undefined);
		} catch {
			/* never break the host over a widget */
		}
	}

	function maybeNudge(ctx: ExtensionContext): void {
		if (!ctx.isIdle()) return; // busy — agent_settled handles it
		const q = store.loadQueue(ctx.cwd);
		if (q.tasks.some((t) => t.status === "in-progress")) return;
		const next = store.nextQueuedTask(q);
		if (!next) return;
		const s = st(ctx);
		const last = s.lastNudge.get(next.id) ?? 0;
		if (last && s.lastTaskToolUse < last && Date.now() - last < NUDGE_COOLDOWN_MS) return;
		s.lastNudge.set(next.id, Date.now());
		pi.sendUserMessage(
			`[task-queue] ${next.id} "${next.title}" is next in the queue and you are idle. Start it now: call task_start("${next.id}") (it returns the full task plus any answered KIV questions), run your clarity gate first, and don't rush — if anything is ambiguous, file KIV questions with task_ask instead of guessing.`,
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	// ------------------------------------------------------------------ tools

	const taskToolCommon = (ctx: ExtensionContext, after?: (task?: store.Task) => void) => {
		st(ctx).lastTaskToolUse = Date.now();
		refreshWidget(ctx);
		after?.();
	};

	const opText = (res: store.OpResult, okText: string) =>
		res.ok
			? textResult(okText, { taskId: res.task.id, status: res.task.status })
			: textResult(`ERROR: ${res.error}`, { error: res.error });

	pi.registerTool({
		name: "task_list",
		label: "Task Queue",
		description:
			"List the per-project task queue (queued / in-progress / blocked / done) including open KIV questions. Read-only. Queued tasks must NOT be started mid-task — only after the current task's full cycle is done.",
		parameters: Type.Object({}),
		execute: (_id, _params, _signal, _update, ctx) => {
			taskToolCommon(ctx);
			return textResult(store.listSummary(ctx.cwd));
		},
	});

	pi.registerTool({
		name: "task_add",
		label: "Task Add",
		description:
			"Add a follow-up task to the per-project queue (for work you discover along the way that should NOT interrupt the current task). Returns the new task id.",
		parameters: Type.Object({
			title: Type.String({ description: "Short imperative title, e.g. 'fix: auth redirect loop'" }),
			body: Type.Optional(Type.String({ description: "Full details: what, where, expected outcome" })),
		}),
		execute: (_id, p, _s, _u, ctx) => {
			const task = store.addTask(ctx.cwd, p.title, p.body);
			taskToolCommon(ctx);
			return textResult(`Queued ${task.id} "${task.title}" — it will start after the current task completes.`, {
				taskId: task.id,
			});
		},
	});

	pi.registerTool({
		name: "task_start",
		label: "Task Start",
		description:
			"Claim the next task you are allowed to work on. Fails if the task is not queued or still has unanswered KIV questions (in which case: wait, do not work on it). Returns the full task body plus all KIV Q&A.",
		parameters: Type.Object({
			id: Type.String({ description: "Task id, e.g. T-002" }),
		}),
		execute: (_id, p, _s, _u, ctx) => {
			const res = store.startTask(ctx.cwd, p.id);
			taskToolCommon(ctx);
			if (!res.ok) return opText(res, "");
			return textResult(
				`Task ${res.task.id} is now in-progress — it is YOUR current task until task_done.\n\n` +
					`${store.taskDetail(res.task)}\n\n` +
					`Clarity gate: do read-only recon first. If anything is ambiguous, call task_ask with KIV questions and stop guessing.`,
				{ taskId: res.task.id },
			);
		},
	});

	pi.registerTool({
		name: "task_ask",
		label: "Task Ask",
		description:
			"File KIV (clarification) questions on a task and park it as blocked until the user answers them via /task. Use INSTEAD of guessing when you lack clarity. The task returns to queued once all questions are answered.",
		parameters: Type.Object({
			id: Type.String({ description: "Task id, e.g. T-002" }),
			questions: Type.Array(Type.String(), {
				description: "Concrete, answerable questions (1-5). Each should state what you would do differently per answer.",
			}),
		}),
		execute: (_id, p, _s, _u, ctx) => {
			const res = store.askTask(ctx.cwd, p.id, p.questions);
			taskToolCommon(ctx);
			if (!res.ok) return opText(res, "");
			return textResult(
				`${res.task.id} is blocked on ${p.questions.length} KIV question(s). The user answers them via /task; the task re-queues automatically when the last one is answered. Tell the user briefly what you parked and why.`,
				{ taskId: res.task.id },
			);
		},
	});

	pi.registerTool({
		name: "task_block",
		label: "Task Block",
		description:
			"Park a task as blocked without KIV questions (e.g. waiting on an external event or a user decision not phrased as a question). The user can see it via /task and unblock by answering/adding context there.",
		parameters: Type.Object({
			id: Type.String({ description: "Task id, e.g. T-002" }),
			reason: Type.Optional(Type.String({ description: "Why it is blocked" })),
		}),
		execute: (_id, p, _s, _u, ctx) => {
			const res = store.blockTask(ctx.cwd, p.id, p.reason);
			taskToolCommon(ctx);
			return opText(res, `${res.task.id} parked as blocked.`);
		},
	});

	pi.registerTool({
		name: "task_done",
		label: "Task Done",
		description:
			"Mark the current in-progress task complete. Only call this AFTER the full build/test/validate cycle has passed. Include a summary of what changed and how it was validated.",
		parameters: Type.Object({
			id: Type.String({ description: "Task id, e.g. T-002" }),
			summary: Type.String({ description: "What was changed and how it was validated" }),
		}),
		execute: (_id, p, _s, _u, ctx) => {
			const res = store.doneTask(ctx.cwd, p.id, p.summary);
			taskToolCommon(ctx, () => maybeNudge(ctx));
			return opText(res, `${res.task.id} marked done.`);
		},
	});

	pi.registerTool({
		name: "task_note",
		label: "Task Note",
		description:
			"Append a progress note to a task (visible in the /task detail view). Use for meaningful milestones so state survives compaction.",
		parameters: Type.Object({
			id: Type.String({ description: "Task id, e.g. T-002" }),
			note: Type.String({ description: "Short progress note" }),
		}),
		execute: (_id, p, _s, _u, ctx) => {
			const res = store.noteTask(ctx.cwd, p.id, p.note);
			taskToolCommon(ctx);
			return opText(res, `Note added to ${p.id.toUpperCase()}.`);
		},
	});

	// ----------------------------------------------------------------- widget

	pi.on("session_start", async (_event, ctx) => {
		refreshWidget(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName.startsWith("task_")) {
			st(ctx).lastTaskToolUse = Date.now();
			refreshWidget(ctx);
		}
	});

	// Auto-start: agent fully settled, no task in progress, queue non-empty.
	// Note: in print/-p mode the session is disposed around this event, so
	// ctx access can throw "stale" — that just means there is no session
	// left to nudge, which is fine.
	pi.on("agent_settled", async (_event, ctx) => {
		try {
			if (!ctx.isIdle()) return;
			refreshWidget(ctx);
			const q = store.loadQueue(ctx.cwd);
			if (q.tasks.some((t) => t.status === "in-progress")) return;
			const next = store.nextQueuedTask(q);
			if (!next) return;
			const s = st(ctx);
			const last = s.lastNudge.get(next.id) ?? 0;
			if (last && s.lastTaskToolUse < last && Date.now() - last < NUDGE_COOLDOWN_MS) return;
			s.lastNudge.set(next.id, Date.now());
			pi.sendUserMessage(
				`[task-queue] ${next.id} "${next.title}" is next in the queue and you are idle. Start it now: call task_start("${next.id}") (it returns the full task plus any answered KIV questions), run your clarity gate first, and don't rush — if anything is ambiguous, file KIV questions with task_ask instead of guessing.`,
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			/* stale ctx (print-mode disposal) or queue hiccup: never break the host */
		}
	});

	// ------------------------------------------------------------------ /task

	pi.registerCommand("task", {
		description: "Task queue — navigate tasks, add, answer KIV questions (↑↓ enter n p x esc)",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				console.log(store.listSummary(ctx.cwd));
				return;
			}

			while (true) {
				let wantsNew = false;
				await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
					const view = new TaskQueueView(
						theme,
						() => {
							const q = store.loadQueue(ctx.cwd);
							return { tasks: q.tasks, sorted: store.sortTasks(q.tasks) };
						},
						(op, taskId) => {
							if (op === "cancel") store.cancelTask(ctx.cwd, taskId);
							else store.bumpPriority(ctx.cwd, taskId);
							refreshWidget(ctx);
						},
						(taskId, questionId, answer) => {
							const res = store.answerQuestion(ctx.cwd, taskId, questionId, answer);
							refreshWidget(ctx);
							return res.ok;
						},
						{
							close: () => done(undefined),
							newTask: () => {
								wantsNew = true;
								done(undefined);
							},
						},
						() => done(undefined),
					);
					return view;
				});

				// If the user answered KIV questions, a blocked task may now be
				// re-queued — if we're idle, auto-start kicks in right away.
				maybeNudge(ctx);

				if (!wantsNew) return;

				const title = await ctx.ui.input("Task title:", "e.g. fix: auth redirect loop");
				if (!title || !title.trim()) continue; // back to the list
				const body = await ctx.ui.editor("Task details (what / where / expected outcome — optional):", "");
				const task = store.addTask(ctx.cwd, title.trim(), body?.trim());
				refreshWidget(ctx);
				ctx.ui.notify(`Queued ${task.id} — starts after the current task completes`, "info");
				if (ctx.isIdle()) maybeNudge(ctx);
				// loop: reopen the list
			}
		},
	});
}
