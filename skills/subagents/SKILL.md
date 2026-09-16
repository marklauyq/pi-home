---
name: subagents
description: Spawn and manage background subagents (subagent_spawn/check/wait/cancel/list, /subagents takeover). Use when delegating self-contained tasks to headless pi subagents or when the user asks to manage/inspect/steer running subagents.
---

# Subagents

Each subagent is a headless in-process pi session with its own context window and its own session file (visible in /resume). It cannot see the parent conversation, cannot ask the user, and cannot spawn more subagents or background terminals. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Background-first rule

**Always run subagents in the background and never wait for them — unless the user explicitly asks you to wait.** `subagent_spawn` is fire-and-forget — it returns immediately and results arrive automatically as follow-up messages when the child settles. Do not block on a result; just let it arrive.

- **Never call `subagent_wait`** unless the user explicitly asks you to wait for a subagent's result (exception: a hard dependency where the next step is impossible without the output — e.g. scout → planner chaining).
- After spawning, **continue useful parent work** — gather context, prepare follow-up spawns, do other tasks. If there is nothing to do, just end the turn; the results will arrive on their own.
- Use `subagent_check({ id })` to peek at progress without blocking.
- Use `subagent_cancel({ ids })` to stop runs while preserving partial transcripts.
- The user can open `/subagents` to inspect a live transcript, steer a run by typing, or abort it; `/btw <question>` asks a one-off side question without blocking the main run.

At most 4 subagents run concurrently.

## Spawn parameters

Call `subagent_spawn` with a complete `prompt` and short `name`. Optional: `agent` (named agent), `working_dir`, `model`, `reasoning_effort`. Also: `subagent_list()` inventories all subagents (running and settled).

## Named agents

| Agent | Purpose | Notes |
| ----- | ------- | ----- |
| `scout` | Fast codebase recon | read-only tools; returns compressed context |
| `planner` | Implementation plans | read-only tools |
| `worker` | General-purpose implementation | full tool set |
| `reviewer` | Code review | read + bash |

Pass the name via the `agent` parameter. Project-local agents (.pi/agents) are available when the project is trusted.

## Models and thinking

Omitting `model` uses the named agent's model (frontmatter), then `subagents.defaultModel` from settings (currently `llama-server/qwen35b-nvfp4`), then the parent model. `reasoning_effort` maps 1:1 to pi thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (omitted = inherit the parent level). Prefer `provider/model-id` form for explicit models.

## Passing context between steps

Children are isolated: to chain steps (scout → planner → worker), you must obtain each child's output before spawning the next. This is the hard-dependency case where `subagent_wait` (or reading the delivered follow-up message) is appropriate — otherwise, never wait.
