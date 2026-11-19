---
name: subagent-build
description: Decompose coding/build work into subagent-sized tasks and write zero-decision prompts for them. Use BEFORE spawning any worker/reviewer subagent to implement, fix, or test code. Covers task sizing, firm-guideline prompt structure, the report-verification rule, and guard clauses that stop local-model failure modes (re-runs, param questions, contract drift).
---

# Subagent Build Discipline

Mechanics (spawn/check/wait/cancel, named agents, models): see the `subagents`
skill. This skill is about **what to put in the prompt** and **how to split
the work** so a child — often a weak local model — cannot get lost.

## The planner rule

You are the planner. A subagent is a compiler: it executes a fully-specified
unit of work and reports output. **Every judgment call must happen in YOUR
head, not in the child's context.** Before spawning, test your draft prompt:

> "Can a child complete this without deciding a single thing?"

If any step requires the child to *figure out*, *choose*, *interpret*, or
*look something up that you already know* — fix the prompt (add the value,
the contract, the exact command) or split the task. Then re-test.

## Task sizing

- **One deliverable per subagent**: one file, one function pair, one test
  suite, one endpoint. "Implement the feature" is too big; "add
  `authenticate(req)` to `server.mjs` between lines X and Y, returning
  exactly {…}" is right.
- **Chain, don't merge**: build → test → review are separate spawns with
  hard dependencies (wait for each result before the next). Never "build and
  test and review in one go".
- **Context the child cannot get**: it cannot ask the user, cannot see this
  conversation. If the answer to "what value?" / "which port?" / "what does
  the API return?" exists in your context, it goes in the prompt, verbatim.

## Prompt structure (every build prompt has all 7 blocks)

1. **READ FIRST** — exact file paths, in order. "Read X before writing
   anything."
2. **DELIVERABLE** — one sentence: which file(s), what changes, nothing
   else. "Modify ONLY `<path>`. Do not touch `<paths>`."
3. **FIRM SPEC** — the actual contract, not a vibe: exact function
   signatures, exact status codes, exact error bodies, exact string
   literals, exact env var names. Copy contracts from the SOURCE, not from
   docs (a doc may be stale — if you quote one, add "verify against the
   source file first; the source wins").
4. **VALUES** — every concrete input: agent names, ports ("use 4871; I
   verified it is free via lsof"), dummy values, paths, token lengths.
   Never let the child invent a name, port, or fixture value.
5. **GUARDS** — explicit prohibitions: "Do not git commit. Do not deploy.
   Do not run the server on port 4870."
   Add situational guards case-by-case when a known failure mode applies
   (e.g. "run the command exactly once, do not retry" for a
   side-effecting command in a retry-prone setup) — but do not pad every
   prompt with boilerplate guards.
6. **VERIFY** — the exact acceptance command and its expected output: "Run
   `bash test.sh`; iterate until it prints `PASS 24/24` and exits 0. No
   other definition of done."
7. **REPORT** — the exact report shape: "Report: (a) the full test output,
   (b) `git diff --stat` of your changes, (c) any spec point you could not
   implement, listed honestly. No summary beyond that."

Never write self-correcting instructions ("do X… no wait, do Y"). The child
executes both. If your spec changed, the prompt says the final form once.

## Failure triage (when a child misbehaves)

Do not blame the model. Re-read your prompt and find the decision point you
left open:

| Symptom | Cause in your prompt | Fix |
|---|---|---|
| Asked user for a parameter | Value wasn't given | Add it to VALUES |
| Re-ran a side-effecting command | Ambiguous done-signal for the child | Add a one-off single-run guard + clarify what success looks like |
| Followed a wrong API contract | Quoted stale docs | Quote source + "source wins" |
| "Timed out / waiting for user" on a testable path | No self-service test path | Tell it how to satisfy the precondition itself |
| Half-finished, wandered off scope | Task too big / no file boundary | Split; tighten DELIVERABLE |

Re-spawn with the fixed prompt. A child failure is a planner bug until
proven otherwise.

## The verification rule (lead-side)

A subagent's "done" report is a **claim**, not a fact — and neither is your
memory of what it did. Before proceeding to the next phase:

1. Run the acceptance command **yourself** (tests, health check).
2. `git diff --stat` and read the diff — confirm scope matches the prompt.
3. Grep for the specific claims ("it added field X", "it never logs Y").

Only then commit (the child never commits) and spawn the next phase.
Deployment, credentials, tunnels, and production containers are LEAD-only
steps, always.
