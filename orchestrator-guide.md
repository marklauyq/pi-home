# Orchestrator Mode Quick Reference

## How to Start

**Option 1: Use the alias (recommended)**
```bash
pi-orch
```

**Option 2: Start with flags**
```bash
pi --extension ~/.pi/agent/extensions/orchestrator-mode.ts --orchestrator
```

**Option 3: Toggle in running session**
```
/orchestrator
```

## What You Can Do

### Single Sub-Agent
```
Use scout to understand this codebase
Use reviewer to review this diff
Ask oracle for a second opinion on my plan
```

### Parallel Sub-Agents
```
Run parallel reviewers: one for correctness, one for tests
Run scout and researcher in parallel
```

### Chained Workflows
```
Chain: scout -> planner -> worker
Use scout to find auth code, then have planner create implementation plan
```

### Background Runs
```
Run reviewer in the background on this branch
```

## Available Sub-Agents

| Agent | Purpose |
|-------|---------|
| `scout` | Fast codebase reconnaissance |
| `researcher` | Web/docs research with sources |
| `planner` | Implementation plans (no editing) |
| `worker` | Implementation work (edits files) |
| `reviewer` | Code review and small fixes |
| `oracle` | Second opinion, challenges assumptions |
| `context-builder` | Gathers context for handoffs |
| `delegate` | Lightweight general delegate |

## What's Blocked

In orchestrator mode, **every tool is disabled** except the sub-agent tools:

**Allowed:** `subagent`, `subagent_supervisor`, `subagent_wait`, `intercom`

Everything else (`read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`, plus
any extension tools like `hashline_edit` or web access) is removed from the
model's tool list, and a `tool_call` guard blocks anything that slips through.

## Persistence

The mode is stored in the session. Resuming with `pi -c` (or the session
picker) restores orchestrator mode automatically — no flag needed.

## Toggle Off

```
/orchestrator
```

Toggling off appends a note to the LLM context so the model knows the
restrictions are lifted. Or restart pi without the orchestrator flag.

## Common Workflows

### Code Review Loop
```
Use worker to implement this, then run reviewer to check it
```

### Deep Analysis
```
Run parallel scouts on frontend and backend, then synthesize findings
```

### Plan Then Implement
```
Chain: scout "analyze codebase" -> planner "create plan" -> wait for approval -> worker "implement"
```

### Second Opinion
```
Ask oracle to review this approach and challenge assumptions
```

## Status Indicator

When active, you'll see `🎭 orchestrator` in the footer.

## Auto-Review (companion extension)

`~/.pi/agent/extensions/auto-review.ts` makes sure built work gets checked.
Whenever a run changes files — directly via `edit`/`write`/`replace`, or through
a `worker`/`delegate` sub-agent — and the agent settles without a review, it
injects an `[AUTO-REVIEW]` message that makes the agent spawn a `reviewer`
sub-agent on the changes. A completed `reviewer` (or `oracle`) run clears the
state. The nudge states explicitly that running tests does not replace the
review. Up to 3 nudges per user prompt; the last one escalates to a
user-level message. New file changes reset the nudge budget.

- Works in both normal and orchestrator mode (footer shows `🔎 auto-review`).
- Toggle with `/autoreview` (on by default; state persists in the session).
- Skips silently if the `subagent` tool isn't available.
