---
name: background-terminals
description: Run and manage long-lived shell commands in background terminals (bg_start/bg_status/bg_list/bg_kill, /ps). Use for dev servers, watchers, streaming builds, and other commands that should keep running while the agent continues working.
---

# Background Terminals

Use `bg_start` for long-running commands; use regular `bash` for quick commands.

## Start

Call `bg_start` with:

- `command`: shell command to run
- `title`: short recognizable label
- `working_dir`: project directory when different from the current directory

Background commands receive no stdin. Never use them for interactive prompts.

After starting, continue useful work instead of polling. The terminal sends exactly one completion message when it exits.

## Inspect and stop

- `bg_status({ id })`: current status + tail of output, only when needed.
- `bg_list()`: inventory all tracked terminals (running and settled).
- `bg_kill({ ids })`: SIGTERM→SIGKILL the whole process tree when a process is no longer needed or is stuck.
- Tell the user they can open `/ps` to inspect live output (stdout/stderr toggle) and kill terminals interactively.

Prefer meaningful titles and avoid starting duplicate servers or watchers. Full output is captured to spill files; tool and completion output shows a concise tail. Terminals are session-scoped and are stopped during shutdown or session transitions.
