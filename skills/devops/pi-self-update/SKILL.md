---
name: pi-self-update
description: Update pi's own agent home (~/.pi/agent) from the remote repo — commit local config changes, pull, sync node_modules, verify the install still boots, and push. Use when the user asks to "update the pi agent", "sync my agent config", "pull the latest pi setup", or to keep a machine's ~/.pi/agent current.
---

# Pi Self-Update

`~/.pi/agent` is both pi's live config and the git working tree (repo `pi-home`). Updating it means: ship local changes, pull remote changes, keep `node_modules` in step with the lockfile, verify pi still boots, and push.

**The deterministic steps are a script** — `node ~/.pi/agent/scripts/pi-self-update.mjs <step>`. It prints a JSON result to stdout and exits 0 on ok, 1 on "needs the agent". Never re-type its commands by hand, and never skip a step because the script output looks fine — run every step in order.

Deliberately absent from the script: `commit`, `reset --hard`, `clean -fd`, `checkout -- .` — those stay agent territory (judgment or explicit approval required).

Remote: `git@github.personal:marklauyq/pi-home.git` (personal account ssh alias).

## Step 0 — Snapshot

```bash
node ~/.pi/agent/scripts/pi-self-update.mjs snapshot
```

Read the JSON: `ahead`/`behind`, `modified` + `untracked` (machine-local files are gitignored and don't appear), `head`.

## Step 1 — Ship local changes (agent judgment)

If `modified` is non-empty:

- Config changes (extensions, agents, prompts, themes, models, AGENTS.md) → commit and push:
  ```bash
  git add -A && git commit -m "checkpoint: <short summary>" && git push
  ```
  Use the `checkpoint: <summary>` convention so history stays readable.
- If unsure whether a local change should be kept (e.g. accidental test edit), show the user the diff (`git diff`) before committing. Never `git checkout -- .` in this repo without explicit approval.

## Step 2 — Pull remote changes

```bash
node ~/.pi/agent/scripts/pi-self-update.mjs pull
```

- `ok: true` → continue.
- `ok: false` with `conflicts` → **stop**, show the user the conflicted files and resolve with their help. Do not force-pull.

## Step 3 — Sync node_modules

```bash
node ~/.pi/agent/scripts/pi-self-update.mjs sync-node
```

Hash-checks `package-lock.json` against `node_modules/.pi-lock-hash` and runs `npm install` only when stale (the `subagent` and `background-terminals` extensions fail to load without `effect`). `inSync: true` → continue.

## Step 4 — Verify pi still works

```bash
node ~/.pi/agent/scripts/pi-self-update.mjs verify
```

Runs the full smoke test in a separate process (never the current session): JSON-validates `settings.json` / `models.json` / `trust.json`, headless `pi -p "Reply with exactly: PI-OK"`, and a tmux TUI check (session starts, no error markers, model replies). Verification is **not optional** — a broken commit breaks pi on every machine that pulls it.

- `ok: true` → continue.
- `ok: false` → read which part failed (`json` / `headless` / `tmux` / `crashLog`) and **follow the `pi-tmux-verify` skill's Debug section** to find and fix the culprit. Re-run `verify` until it passes.

## Step 5 — Push anything local

If Step 1 created commits that haven't been pushed:

```bash
node ~/.pi/agent/scripts/pi-self-update.mjs push
```

Pushes; on rejection it runs `pull --rebase` and retries once (never force-pushes). `ok: false` → show the user the output and stop.

## Step 6 — Update the pi binary and packages

```bash
node ~/.pi/agent/scripts/pi-self-update.mjs update-pi
```

Runs `pi update` + `pi update --extensions` and reports version before/after.

- If `changed: true` (binary bumped): re-run Step 4 (`verify`) — a new binary can change extension APIs. If the bump touched `package-lock.json` via the pull, re-run Step 3 too.
- A specific package can be updated alone: `pi update <package-source>`.
- The model catalog can be refreshed with `pi update --models`.

## Reporting

Summarize: what was committed/pushed, what was pulled (commit range), whether npm install ran, the verification result (ok / broken + what), and the binary version change. Note that the current session keeps its old config/binary in memory — new sessions (or a pi restart) pick up everything.

## Safety rules

- Never `git reset --hard`, `git clean -fd`, or `git checkout -- .` in this repo without explicit user approval.
- Never commit gitignored files (`git add -f` is a red flag). If a new machine-local file appears, add it to `.gitignore` instead.
- Never force-pull or force-push.
- Verification (Step 4) is not optional, and re-run after any binary update.
