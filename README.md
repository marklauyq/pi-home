> **Generated artifact.** `pi-home` is a sanitized snapshot of one person's
> [pi](https://github.com/badlogic/pi-mono) agent home, published by a generator
> (`scripts/make-public.mjs`). Hostnames, IPs and tokens are placeholders; releases
> replace `main` wholesale. Issues and PRs welcome.

# pi-home — pi agent home

`~/.pi/agent` is pi's **live config directory**: extensions, subagent profiles,
skills, prompts, themes, `models.json`, and `AGENTS.md`. There is no build step —
pi auto-discovers everything in this directory, and changes take effect in new
sessions immediately.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/marklauyq/pi-home/main/install.sh | bash
```

That checks prerequisites, installs pi itself if it is missing, clones this repo
into `~/.pi/agent`, and runs `scripts/pi-install.mjs`, which will ask you a few
questions (below). Flags: `--dry-run` (print the plan), `--dest <path>`,
`--skip-verify`.

### Prerequisites

- **Node.js 22+** — [nvm](https://github.com/nvm-sh/nvm) is the easiest way:
  `nvm install 22 && nvm use 22`
- **git** and **npm**
- Optionally your own model server (llama.cpp / any OpenAI-compatible endpoint)
  and a self-hosted [SearXNG](https://docs.searxng.org) for private web search.
  Both are optional — provider `/login` works instead.

### What the installer asks

| Prompt | Replaces | Where |
| --- | --- | --- |
| `MODEL_HOST` | `<MODEL_HOST>` | `models.json`, `settings.json` |
| `SEARXNG_HOST` | `<SEARXNG_HOST>` | `web-search.json`, `AGENTS.md` |
| n8n bearer token | `CHANGE_ME` | `mcp.json` (optional) |
| remote-control url + token | placeholder block | `settings.json` (optional) |

Prompts only run on a TTY; in `--dry-run`/`--non-interactive` mode they are
skipped and an empty answer keeps the placeholder. Everything is idempotent —
re-run `node ~/.pi/agent/scripts/pi-install.mjs` any time as a repair.

## What is in here

```
extensions/    pi extensions (subagents, background terminals, task queue, session recall, ...)
agents/        subagent profiles (scout, planner, crawler, reviewer, worker, emailer)
skills/        SKILL.md playbooks the agent loads on demand
prompts/       reusable prompt templates
themes/        TUI themes
remote/        LAN remote-control server + web client
scripts/       deterministic pipeline helpers
models.json    provider/model definitions (host is a placeholder)
AGENTS.md      global agent instructions
```

## Machine-local files are not in this repo

`auth.json`, `trust.json`, `mcp.json`, `settings.json`, `sessions/`,
`node_modules/` and provider credentials stay local. `settings.json.dist` and
`mcp.json.dist` are the templates the installer copies from — it never
overwrites an existing config. After cloning, the files you need to create
yourself are: provider login (`/login` in pi), and any `CHANGE_ME` tokens.

## Update

This repo is the live config, so `git pull` inside `~/.pi/agent` is the update —
then `npm install` if the lockfile changed. Re-running `install.sh` on an
existing git checkout is a repair, not a re-clone.
