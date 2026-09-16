---
description: Full implementation workflow - scout gathers context, planner creates plan, worker implements
---
Execute this workflow as sequential subagent spawns. Children cannot see each other's context, so pass each step's output into the next step's prompt.

1. subagent_spawn with agent "scout": find all code relevant to: $@
2. subagent_wait for the scout, then subagent_spawn with agent "planner": create an implementation plan for "$@" using the scout's findings (include them verbatim in the prompt).
3. subagent_wait for the planner, then subagent_spawn with agent "worker": implement the plan (include the full plan in the prompt).
4. subagent_wait for the worker and report the result.
