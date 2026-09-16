---
name: pi-tmux-verify
description: Smoke-test that pi still starts and works after settings or extension changes, by running pi headless and inside a background tmux session, then inspecting the output. Use after modifying ~/.pi/agent (extensions, settings.json, models.json, themes, AGENTS.md) to validate nothing is broken.
---

# Pi Smoke Test (tmux)

Changes in `~/.pi/agent` (extensions, settings, models, themes) take effect immediately in new pi processes. A broken extension or malformed JSON can crash pi at startup or render a blank TUI. Validate end-to-end before declaring a config change done.

**Never test your own session.** Always launch a separate pi process (session name `pi-test` below).

## Step 0 — Snapshot state

```bash
tmux list-sessions 2>/dev/null
ls -l ~/.pi/agent/pi-crash.log 2>/dev/null   # note the timestamp
```

## Step 1 — Quick headless check (catches startup crashes)

```bash
pi -p "Reply with exactly: PI-OK" --no-session 2>&1 | tail -5
```

Expected: `PI-OK`. If this fails with a module-load, JSON-parse, or extension error, pi is broken — skip to **Debug**. If it fails with a model/provider error (no response, timeout, auth failure), that is a provider issue, not necessarily a pi issue — note it and continue to the TUI check.

## Step 2 — Full TUI check via tmux

```bash
tmux new-session -d -s pi-test -x 120 -y 40 pi --no-session
sleep 3
tmux capture-pane -pt pi-test
```

Checklist for the captured screen:

- pi's startup UI is present (not blank, not a wall of errors)
- No red error text: `Error`, `TypeError`, `Cannot find module`, `Unhandled promise rejection`, `crash`
- The editor / input area rendered
- Expected widgets from active extensions are visible (e.g. ext-list, token-per-sec footer)
- The session is still alive: `tmux list-sessions | grep pi-test`

If the session died, the screen is gone — check the crash log instead:

```bash
ls -l ~/.pi/agent/pi-crash.log   # new timestamp?
tail -40 ~/.pi/agent/pi-crash.log
```

## Step 3 — Exercise the agent

```bash
tmux send-keys -t pi-test "Reply with exactly: PI-OK" Enter
sleep 10        # allow longer for slow or local models
tmux capture-pane -t pi-test | tail -15
```

Expected: a `PI-OK` reply and the editor usable again.

## Step 4 — Teardown

```bash
tmux kill-session -t pi-test
```

`--no-session` keeps the test ephemeral, so no session files pile up.

## Debug: find what's broken

1. Isolate extensions from settings:
   ```bash
   pi -p "hi" --no-session --no-extensions 2>&1 | tail -5
   ```
   If this works, an extension is the culprit.
2. Bisect extensions one at a time:
   ```bash
   pi -p "hi" --no-session --no-extensions -e ~/.pi/agent/extensions/<suspect>.ts 2>&1 | tail -5
   ```
3. Validate the JSON config files:
   ```bash
   for f in ~/.pi/agent/settings.json ~/.pi/agent/models.json ~/.pi/agent/trust.json; do
     node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" >/dev/null && echo "OK $f" || echo "BROKEN $f"
   done
   ```
4. See the live startup error — keep the pane alive after the crash:
   ```bash
   tmux new-session -d -s pi-test -x 120 -y 40 'pi --no-session --verbose; echo "--- exited $?"; exec sh'
   sleep 3
   tmux capture-pane -pt pi-test | tail -30
   ```
   `--verbose` surfaces startup detail; the `exec sh` fallback keeps the pane attached so you can read the failure, then `tmux kill-session -t pi-test`.

## Pass criteria

- Headless `pi -p` returns the expected reply
- The TUI session starts, renders the normal UI with no error text, and stays alive
- A prompt sent via tmux gets a model reply
- No new timestamp in `~/.pi/agent/pi-crash.log`

## Notes

- If the TUI shows `Warning: tmux extended-keys-format is xterm...`, it is harmless for a smoke test (keybinding edge cases only). For regular interactive use, add `set -g extended-keys-format csi-u` to `~/.tmux.conf` and restart tmux.
- Use a unique session name if `pi-test` already exists.
