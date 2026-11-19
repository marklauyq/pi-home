---
description: Scout gathers context, planner creates implementation plan (no implementation)
---
Execute this workflow as sequential subagent spawns. Children cannot see each other's context, so pass the scout's findings into the planner's prompt.

1. subagent_spawn with agent "scout": find all code relevant to: $@
2. subagent_wait for the scout, then subagent_spawn with agent "planner": create an implementation plan for "$@" using the scout's findings (include them verbatim in the prompt).
3. subagent_wait for the planner and present the plan.
