---
description: Worker implements, reviewer reviews, worker applies feedback
---
Execute this workflow as sequential subagent spawns. Children cannot see each other's context, so pass each step's output into the next step's prompt.

1. subagent_spawn with agent "worker": implement the task: $@
2. subagent_wait for the worker, then subagent_spawn with agent "reviewer": review the implementation (include the worker's report and the changed files in the prompt).
3. subagent_wait for the reviewer, then subagent_spawn with agent "worker": apply the review feedback (include the full review in the prompt).
4. subagent_wait for the final worker and report the result.
