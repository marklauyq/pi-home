/**
 * Task-queue store — pure, synchronous read/modify/write against a
 * per-project JSON file: <cwd>/.pi/task-queue/tasks.json
 *
 * Single process (pi TUI), so plain sync fs is safe. Writes are atomic
 * (tmp + rename). No state lives in memory here — the disk file is the
 * single source of truth shared between the agent (task_* tools) and
 * the user (/task view).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type TaskStatus = "queued" | "in-progress" | "blocked" | "done" | "cancelled";

export interface TaskQuestion {
	id: number;
	q: string;
	answer: string | null;
	askedAt: string;
	answeredAt: string | null;
}

export interface HistoryEntry {
	at: string;
	event: string;
	detail?: string;
}

export interface Task {
	id: string;
	title: string;
	body: string;
	status: TaskStatus;
	/** Higher runs first among queued tasks. */
	priority: number;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	/** Summary recorded at task_done. */
	result: string | null;
	questions: TaskQuestion[];
	history: HistoryEntry[];
}

export interface TaskQueue {
	version: 1;
	nextId: number;
	tasks: Task[];
}

export type OpResult = { ok: true; task: Task } | { ok: false; error: string };

export function queueDir(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "task-queue");
}

export function queuePath(cwd: string): string {
	return path.join(queueDir(cwd), "tasks.json");
}

function now(): string {
	return new Date().toISOString();
}

export function emptyQueue(): TaskQueue {
	return { version: 1, nextId: 1, tasks: [] };
}

export function loadQueue(cwd: string): TaskQueue {
	try {
		const raw = fs.readFileSync(queuePath(cwd), "utf8");
		const parsed = JSON.parse(raw) as TaskQueue;
		if (!parsed || !Array.isArray(parsed.tasks)) return emptyQueue();
		parsed.nextId = parsed.nextId || 1 + parsed.tasks.length;
		return parsed;
	} catch {
		return emptyQueue();
	}
}

export function saveQueue(cwd: string, q: TaskQueue): void {
	const dir = queueDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	const target = queuePath(cwd);
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(q, null, 2) + "\n", "utf8");
	fs.renameSync(tmp, target);
}

function normalizeId(id: string): string {
	return String(id || "").trim().toUpperCase();
}

export function findTask(q: TaskQueue, id: string): Task | undefined {
	const needle = normalizeId(id);
	return q.tasks.find((t) => t.id === needle);
}

export function openQuestions(task: Task): TaskQuestion[] {
	return task.questions.filter((x) => x.answer === null);
}

function history(task: Task, event: string, detail?: string): void {
	task.history.push({ at: now(), event, detail });
}

/** Order used everywhere for display / picking the next task. */
export function sortTasks(tasks: Task[]): Task[] {
	const rank: Record<TaskStatus, number> = {
		"in-progress": 0,
		blocked: 1,
		queued: 2,
		done: 3,
		cancelled: 4,
	};
	return [...tasks].sort((a, b) => {
		const r = rank[a.status] - rank[b.status];
		if (r !== 0) return r;
		if (a.priority !== b.priority) return b.priority - a.priority;
		return a.createdAt < b.createdAt ? -1 : 1;
	});
}

/** The task the agent should work on next, or undefined. */
export function nextQueuedTask(q: TaskQueue): Task | undefined {
	const queued = sortTasks(q.tasks.filter((t) => t.status === "queued"));
	return queued[0];
}

export function addTask(cwd: string, title: string, body = ""): Task {
	const q = loadQueue(cwd);
	const task: Task = {
		id: `T-${String(q.nextId).padStart(3, "0")}`,
		title: title.trim(),
		body: (body || "").trim(),
		status: "queued",
		priority: 0,
		createdAt: now(),
		startedAt: null,
		completedAt: null,
		result: null,
		questions: [],
		history: [],
	};
	q.nextId += 1;
	history(task, "queued");
	q.tasks.push(task);
	saveQueue(cwd, q);
	return task;
}

export function startTask(cwd: string, id: string): OpResult {
	const q = loadQueue(cwd);
	const task = findTask(q, id);
	if (!task) return { ok: false, error: `No task ${normalizeId(id)}` };
	if (task.status !== "queued") {
		return { ok: false, error: `${task.id} is ${task.status}, not queued — nothing to start` };
	}
	const open = openQuestions(task);
	if (open.length > 0) {
		return {
			ok: false,
			error: `${task.id} has ${open.length} unanswered KIV question(s) — it is not ready. Do not work on it; answers will arrive via /task.`,
		};
	}
	task.status = "in-progress";
	task.startedAt = now();
	history(task, "started");
	saveQueue(cwd, q);
	return { ok: true, task };
}

export function blockTask(cwd: string, id: string, reason = ""): OpResult {
	const q = loadQueue(cwd);
	const task = findTask(q, id);
	if (!task) return { ok: false, error: `No task ${normalizeId(id)}` };
	if (task.status !== "queued" && task.status !== "in-progress") {
		return { ok: false, error: `${task.id} is ${task.status} — cannot block` };
	}
	task.status = "blocked";
	history(task, "blocked", reason.trim() || undefined);
	saveQueue(cwd, q);
	return { ok: true, task };
}

export function doneTask(cwd: string, id: string, summary = ""): OpResult {
	const q = loadQueue(cwd);
	const task = findTask(q, id);
	if (!task) return { ok: false, error: `No task ${normalizeId(id)}` };
	if (task.status !== "in-progress") {
		return { ok: false, error: `${task.id} is ${task.status} — only in-progress tasks can be completed` };
	}
	task.status = "done";
	task.completedAt = now();
	task.result = summary.trim() || null;
	history(task, "done", task.result || undefined);
	saveQueue(cwd, q);
	return { ok: true, task };
}

export function cancelTask(cwd: string, id: string): OpResult {
	const q = loadQueue(cwd);
	const task = findTask(q, id);
	if (!task) return { ok: false, error: `No task ${normalizeId(id)}` };
	if (task.status === "done" || task.status === "cancelled") {
		return { ok: false, error: `${task.id} is already ${task.status}` };
	}
	task.status = "cancelled";
	task.completedAt = now();
	history(task, "cancelled");
	saveQueue(cwd, q);
	return { ok: true, task };
}

export function bumpPriority(cwd: string, id: string): OpResult {
	const q = loadQueue(cwd);
	const task = findTask(q, id);
	if (!task) return { ok: false, error: `No task ${normalizeId(id)}` };
	if (task.status !== "queued") {
		return { ok: false, error: `Only queued tasks can be re-prioritized (${task.id} is ${task.status})` };
	}
	task.priority += 1;
	history(task, "priority", `priority=${task.priority}`);
	saveQueue(cwd, q);
	return { ok: true, task };
}

/**
 * File KIV questions on a task. The task is parked: queued/blocked stays
 * blocked, in-progress is blocked too — the agent must stop guessing and
 * wait for user answers.
 */
export function askTask(cwd: string, id: string, questions: string[]): OpResult {
	const q = loadQueue(cwd);
	const task = findTask(q, id);
	if (!task) return { ok: false, error: `No task ${normalizeId(id)}` };
	if (task.status === "done" || task.status === "cancelled") {
		return { ok: false, error: `${task.id} is ${task.status} — cannot add questions` };
	}
	const nextQId = (task.questions.length ? Math.max(...task.questions.map((x) => x.id)) : 0) + 1;
	questions
		.map((x) => x.trim())
		.filter(Boolean)
		.forEach((text, i) => {
			task.questions.push({
				id: nextQId + i,
				q: text,
				answer: null,
				askedAt: now(),
				answeredAt: null,
			});
		});
	if (task.status === "in-progress") {
		task.status = "blocked";
		history(task, "blocked", "waiting for KIV answers");
	} else if (task.status === "queued") {
		task.status = "blocked";
		history(task, "blocked", "waiting for KIV answers");
	}
	saveQueue(cwd, q);
	return { ok: true, task };
}

/**
 * Answer one KIV question. When the task's last open question is answered
 * and the task was blocked, it goes back to queued (the auto-start hook
 * picks it up).
 */
export function answerQuestion(cwd: string, taskId: string, questionId: number, answer: string): OpResult {
	const q = loadQueue(cwd);
	const task = findTask(q, taskId);
	if (!task) return { ok: false, error: `No task ${normalizeId(taskId)}` };
	const question = task.questions.find((x) => x.id === questionId);
	if (!question) return { ok: false, error: `${task.id} has no question #${questionId}` };
	if (question.answer !== null) return { ok: false, error: `Question #${questionId} of ${task.id} is already answered` };
	question.answer = answer.trim();
	question.answeredAt = now();
	history(task, "kiv-answered", `Q${question.id}`);
	const stillBlocked = openQuestions(task).length > 0;
	if (task.status === "blocked" && !stillBlocked) {
		task.status = "queued";
		history(task, "requeued", "all KIV questions answered");
	}
	saveQueue(cwd, q);
	return { ok: true, task };
}

export function noteTask(cwd: string, id: string, note: string): OpResult {
	const q = loadQueue(cwd);
	const task = findTask(q, id);
	if (!task) return { ok: false, error: `No task ${normalizeId(id)}` };
	if (task.status === "cancelled") return { ok: false, error: `${task.id} is cancelled` };
	const text = note.trim();
	if (!text) return { ok: false, error: "Empty note" };
	history(task, "note", text);
	saveQueue(cwd, q);
	return { ok: true, task };
}

/** Plain-text summary, also used by task_list and non-TUI /task. */
export function listSummary(cwd: string): string {
	const q = loadQueue(cwd);
	if (q.tasks.length === 0) return "Task queue is empty. Add one with /task (press n) or task_add.";
	const lines = sortTasks(q.tasks).map((t) => {
		const open = openQuestions(t).length;
		const kq = open > 0 ? `  ⚠ ${open} KIV question(s) awaiting your answer` : "";
		return `${t.id}  [${t.status}]  ${t.title}${kq}`;
	});
	lines.push("");
	lines.push("KIV questions:");
	const kqs = q.tasks
		.flatMap((t) => openQuestions(t).map((x) => ({ t, x })));
	lines.push(kqs.length ? kqs.map(({ t, x }) => `  ${t.id} Q${x.id}: ${x.q}`).join("\n") : "  (none)");
	return lines.join("\n");
}

/** Compact widget content; empty array = nothing worth showing. */
export function widgetParts(cwd: string): { active?: Task; queued: Task[]; blocked: Task[] } {
	const q = loadQueue(cwd);
	const active = q.tasks.find((t) => t.status === "in-progress");
	const queued = q.tasks.filter((t) => t.status === "queued");
	const blocked = q.tasks.filter((t) => t.status === "blocked");
	return { active, queued, blocked };
}

/** Everything the agent needs when claiming a task. */
export function taskDetail(task: Task): string {
	const lines: string[] = [];
	lines.push(`${task.id} — ${task.title}`);
	lines.push(`status: ${task.status}`);
	if (task.body) {
		lines.push("", "Task:", task.body);
	}
	if (task.questions.length > 0) {
		lines.push("");
		lines.push("KIV questions:");
		for (const x of task.questions) {
			lines.push(`  Q${x.id}: ${x.q}`);
			lines.push(`    A: ${x.answer ?? "(unanswered)"}`);
		}
	}
	const notes = task.history.filter((h) => h.event === "note");
	if (notes.length > 0) {
		lines.push("");
		lines.push("Notes:");
		for (const n of notes) lines.push(`  - ${n.detail}`);
	}
	if (task.result) {
		lines.push("", "Result:", task.result);
	}
	return lines.join("\n");
}
