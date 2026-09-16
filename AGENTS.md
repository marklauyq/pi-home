# Global Agent Instructions

## Never print secrets into context

Do not echo credentials, API keys, tokens, passwords, or authorization headers into the conversation — even for local models.
- Never `cat`/`read` files that hold live credentials (e.g. `~/.pi/agent/mcp.json`, `auth.json`) raw. If you must inspect one, redact first, e.g. `sed -E 's/(Bearer |token|password)[^"\n]+/\1<REDACTED>/Ig' file`.
- If a credential accidentally appears in context, disclose that immediately, offer a fresh session (`/new`), and recommend rotating the credential if it was a shared secret.

## Tool Usage Preference

When modifying existing files, prefer `edit` for targeted changes over `write` for the entire file. Use `edit` for changes under 50 lines.

## Web search: always headless

- Always call `web_search` with `workflow: "none"` — the interactive curator popup annoys the user and steals their browser. Never let a search open the curation UI.
- Search goes through the self-hosted SearXNG on `your SearXNG host` (`http://<SEARXNG_HOST>:8888`), configured in `~/.pi/agent/web-search.json` (`searxngBaseUrl` + `ssrf.allowRanges` for that /32). A configured SearXNG is tried **first** in `auto` mode, so don't pass `provider` unless overriding. No third-party search API keys are configured — don't suggest providers the user has no key for.
- SearXNG's own `duckduckgo` and `google` engines get captcha-walled from this residential IP; results come from its other engines (33–38 per query in practice). Google/DDG are also unusable via `agent-browser` for the same reason — use Wikipedia/Mojeek-style targets for browser demos.
- For multi-angle research, use `queries` (2–4 varied angles) rather than one query.

## Servers & ports

- **Check the port before spinning up any server** — and before *suggesting* one. `lsof -nP -iTCP:<port> -sTCP:LISTEN` first (or list all listeners with `lsof -nP -iTCP -sTCP:LISTEN` and pick from the gaps); if the port is in use, use a different one (`--port` / `PORT=`) instead of shadowing it. Never name a port in a command or suggestion without having just verified it's free. Beware: on macOS an IPv6 wildcard bind (`*:8080`) happily coexists with a loopback-only bind on the *same* port number and silently shadows it for `localhost`/`[::1]` clients — two listeners on one port is not "fine". (2026-08-23: a background `node server.mjs` on `*:8080` shadowed the user's `llama-server` on `127.0.0.1:8080`; a follow-up guess of `8090` was also already taken.)
- **Don't leave background servers running after the task.** Stop them (`bg_kill`) unless the user explicitly wants one kept up; if one must stay, say which port and how to stop it.

## Subagents: background by default

All subagents run in the background from spawn: `subagent_spawn` is fire-and-forget (in-process pi sessions with their own session files), and unawaited results are delivered automatically as follow-up messages. Max 4 concurrent.
- Do useful parent work while children run (pre-checks, gathering context, preparing follow-ups). **Never call `subagent_wait`** unless the user explicitly asks you to wait, or the next step is a hard dependency on a specific result (e.g. scout → planner chaining).
- Use `subagent_check` to peek, `subagent_list` to inventory, `subagent_cancel` to stop (partial transcripts are preserved).
- The user can steer/inspect a running subagent at any time with `/subagents` (live takeover) and ask one-off side questions with `/btw`.
- Long-running shell processes (dev servers, watchers, builds) go to background terminals (`bg_start`, `/ps`) instead of blocking `bash`.

## This repo is the agent's home

`~/.pi/agent` is both the live pi agent config and the git working tree — there is no separate copy to sync.

- **`pi update --extensions` on npm 12+:** `pi-mcp-adapter` pulls `@modelcontextprotocol/client|core` from `https://pkg.pr.new/...` URL tarballs, and npm 12 defaults to `allow-remote = none`, so the install fails with `EALLOWREMOTE`. Fix once per machine: `echo 'allow-remote=all' > ~/.pi/agent/npm/.npmrc` (npm reads that file even though pi invokes `npm install --prefix ~/.pi/agent/npm`). `npm/` is gitignored, so this file is machine-local and must be recreated after a fresh checkout. Alternative if you don't want URL tarballs: pin `pi-mcp-adapter` below the version that introduced them (2.32.1 was registry-only).
- **Bootstrap after a pull on any machine:** `cd ~/.pi/agent && npm install` — installs `effect` (tracked in the root `package.json`, `node_modules/` is gitignored). The remote-sync extension detects an out-of-sync `node_modules` (marker in `node_modules/.pi-lock-hash` vs the committed lockfile), offers to pull, and runs `npm install` automatically after the pull. Without the install, the `subagent` and `background-terminals` extensions fail to load. No build steps or postinstall scripts involved.

- **Changes take effect immediately.** pi auto-discovers extensions from `extensions/` and reloads them at runtime, so editing a file on disk is the running state. There is no build step.
- **Checkpoint after meaningful changes.** After any meaningful config change (extensions, agents, prompts, themes, models, or this file), run `git add -A`, commit, and push with a `checkpoint: <summary>` message, consistent with the history.
- **`.gitignore` is the safety net.** Machine-local and sensitive files (`auth.json`, `trust.json`, `sessions/`, `models-store.json`, `pi-crash.log`, `node_modules/`) must never enter the repo. If a new machine-local file appears, add it to `.gitignore` rather than committing it.
- **Other machines.** On any machine, the repo should be checked out directly at `~/.pi/agent` — that checkout IS the live config; no sync scripts or mirror subdirectories exist. (The old `~/pi-global` clone and `sync.sh` mirrors were retired 2026-08-17.) Git operations against github.com on this machine go through the `github.personal` ssh alias (personal account `marklauyq`).

## Public release: pi-home

`marklauyq/pi-home` (public) is a **generated, sanitized snapshot** of this repo — never edited by hand, never contains private history.

- Generator: `scripts/make-public.mjs` (`build` / `check` / `publish`; JSON out, exit 0/1). Installer sources live in `scripts/public-assets/` (`install.sh` = the curl entrypoint, `pi-install.mjs` = prompting bootstrap).
- The scrub map + BANNED patterns are in `make-public.mjs`. **When you add a skill/file that mentions a new host, IP, username, or service domain, add it to SCRUBS (and BANNED if it must never leak)** — otherwise it ships to the public repo.
- Auto-publish: `.github/workflows/publish.yml` runs on every push to main on the **the CI runner box docker runner** (`~/actions-runner/docker-compose.yml`, image `home-runner`, registered as `pi-home-runner`, labels `the CI runner box`). `check` gates the push: a leak = red X, nothing public changes.
- Cross-repo push uses the repo secret `PI_HOME_PUSH_TOKEN` (fine-grained PAT, `pi-home` contents-write only).
- Manual re-publish: `node scripts/make-public.mjs publish`.
- New-machine install: `curl -fsSL https://raw.githubusercontent.com/marklauyq/pi-home/main/install.sh | bash`.

## Task queue (/task)

Per-project queue at `<project>/.pi/task-queue/tasks.json`. The user drives it with the `/task` TUI view; you drive it with the `task_*` tools. The file is the single source of truth — your context may be compacted, the queue is not.

- **Queued tasks are inert.** While your current task is in flight (including while subagents are out), never start a queued task — even if the user adds one mid-flight. You'll be nudged when it's time.
- **Full cycle before done**: implement → build/test → validate. Call `task_done` only after seeing validation pass, with a summary of what changed and how it was validated.
- **Clarity gate**: when you start a task, do read-only recon first. If you cannot execute confidently, stop: file KIV questions via `task_ask` (the task blocks, the user answers via /task) and say what you parked and why. Never half-guess into execution — blocking a task is cheaper than a wrong build.
- **KIV answers** arrive via `task_start` when the task restarts — read them, don't assume.
- **Auto-start**: after finishing a task with a non-empty queue, you'll get a `[task-queue]` nudge — start that task. If you end work while a task is still `in-progress`, do not start others; finish or report on that one first.
- **`task_note`** at meaningful milestones so state survives compaction.

## Building pi extensions

You are running inside pi and can read, write, and reload your own extensions. When you build or change an extension, work like this:

1. **Don't guess APIs.** Before using an extension API, confirm it exists and how it behaves by consulting pi's own extension documentation and the existing extensions in this repo. If you assume an API shape, you will usually be wrong.
2. **Study working examples.** The extensions already in this project are your reference for the correct patterns (event subscription, registering tools/commands, widgets, the event bus). Read them before writing new code.
3. **Verify before declaring done.** A file that was written is not the same as a feature that works. Make your change take effect, observe the actual result, and confirm it behaves as intended. If it errored or produced the wrong output, fix it and verify again. Do not report success until you have seen it work.
4. **Reloading.** Auto-discovered extensions can be reloaded at runtime without restarting pi. Find the supported mechanism in the documentation rather than assuming one.
