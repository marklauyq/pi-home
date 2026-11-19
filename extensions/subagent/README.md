# Subagents

Spawn background subagents as **in-process pi sessions** (`createAgentSession`
from the pi SDK), managed by an Effect v4 core. Ported/adapted from
[davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup)
(pi backend only; their claude/codex harnesses are not included).

## Tools (model-facing)

| Tool | Purpose |
|------|---------|
| `subagent_spawn` | Fire-and-forget spawn: `prompt`, `name`, optional `agent`, `working_dir`, `model`, `reasoning_effort`. Max 4 concurrent. |
| `subagent_wait` | Block until the listed subagents settle; returns their outputs (budgeted). |
| `subagent_cancel` | Abort running subagents; partial transcripts are preserved. |
| `subagent_check` | Non-blocking peek at status + latest output. |
| `subagent_list` | Inventory of running and settled subagents. |

Unawaited subagents deliver their result automatically as a follow-up message
when they settle (deferred + flushed on `agent_settled`; `subagent_wait`
consumes pending deliveries to avoid duplicates).

## Commands (user-facing)

- `/subagents` — picker of all subagents → full **takeover view**: live
  streaming transcript, an input line that **steers** the running child
  (`session.steer`), abort via the `app.clear` keybinding, scrolling.
- `/btw [question]` — one-off side question on a subagent; answer shows in the
  transcript as a `by the way` entry (never injected into the model context).

## Named agents

`.md` files with YAML frontmatter, discovered fresh on each spawn:

- `~/.pi/agent/agents/*.md` (user level, always)
- `.pi/agents/*.md` (project level; requires a trusted project)

```markdown
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
model: llama-server/qwen35b-nvfp4
---
System prompt for the agent goes here.
```

Pass the name via `subagent_spawn({ agent: "scout" })`: the body becomes the
child's operating instructions, `tools` restricts the child's tool set
(allowlist), `model` is the default model hint.

**Model resolution:** explicit `model` param → agent frontmatter model →
`subagents.defaultModel` from settings (project overrides global) → inherit
the parent model. `reasoning_effort` maps 1:1 to pi thinking levels.

## Child session properties

- Real session files (`SessionManager.create(cwd)`) — visible in `/resume`.
- Child resources loaded per-cwd with trust gating
  (`DefaultResourceLoader` + `SettingsManager`); alternate working dirs are
  trusted only via the persisted `ProjectTrustStore`.
- Child tool denylist: `subagent_*` and `bg_*` (no recursion; terminals die
  with the child anyway).
- `bindExtensions({ mode: "print" })` starts child extension hooks
  headless; 3-minute per-tool-call timeout guard on child tools.
- All child teardown (steer queue clear, abort, `session_shutdown`, dispose)
  is bounded (5s) so a wedged child cannot hang shutdown.

## Architecture

Effect v4 (`effect@4-beta` in `~/.pi/agent/package.json`):

- `src/backends/pi.ts` — session factory; translates `AgentSession` events
  (deltas, tool execution, queue updates, settlement) into a normalized
  `SubagentEvent` stream.
- `src/manager.ts` — `SubagentManager` service: scoped entries, event pump
  fibers folding streams into `SubagentSnapshot`s, wait interest,
  cancel/settle, pruning (max 64 tracked), and a synchronous
  `SubagentReadModel` for the TUI.
- `src/runtime.ts` — Layer composition + one `ManagedRuntime`; `runTool()`
  is the async boundary that converts Effect exits to thrown Errors.
- `index.ts` — tools, commands, message/entry renderers, deferred result
  delivery, and event-bus notifications.

## Integration with this repo

- **widget-card** listens to event-bus `subagent/running` (count changes),
  `subagent/progress` (throttled one-line preview), `subagent/settled`.
- **skills**: `skills/subagents/SKILL.md` guides model usage;
  `AGENTS.md` "Subagents: background by default" sets the operating rules.
- **workflow prompts** in `prompts/` (`/implement`, `/scout-and-plan`,
  `/implement-and-review`) orchestrate named agents via sequential
  spawn/wait (children are isolated; outputs pass through prompts).

## Notes / limits

- Max 4 running subagents; 64 tracked before pruning.
- Output budgets: 24 KB spawn/preview, 48 KB total wait output (16 KB per agent).
- `subagent_wait` interruption (Ctrl+C) releases interest; children keep running.
- Effect version is a beta pin — see `skills/effect-extensions/SKILL.md`.
