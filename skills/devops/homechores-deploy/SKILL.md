---
name: homechores-deploy
description: Deploy the Home Care Scheduler (homechores) to its real production host — the `the CI runner box` server (ssh alias `the CI runner box`, <SEARXNG_HOST>) at `~/projects/homechores`, where it runs as a Docker Compose stack behind the Cloudflare tunnel at https://<HOMECARE_HOST>. Use for ANY "deploy / release / update / roll back the homechores app" task. Covers the backup → pull → build → verify → rollback cycle, the compose file layering, the required env vars, the migration-safety check, and the traps (Sites/wrangler is NOT the deploy path, the NAS is unreachable from the Mac, node is not on the non-interactive PATH).
---

# Home Care Scheduler — production deploy

**Production is NOT on the laptop and NOT on Cloudflare Sites.** It is a Docker Compose stack
on the `the CI runner box` box, serving `https://<HOMECARE_HOST>`.

Verified live on 2026-10-14.

## Layout

| Thing | Value |
|---|---|
| Host | ssh alias **`the CI runner box`** (`<SEARXNG_HOST>`, user `mark`, key auth works) |
| Checkout | `~/projects/homechores` (branch `main`) |
| Remotes | `origin` = `gitlab.com:marklauyq/homechores.git`, `mr1` = `gitlab.com:homescheduler/homechores.git` |
| Stack | project `homechores`, container **`homechores-scheduler-1`**, image **`home-care-scheduler:local`** |
| Compose | **`compose.yaml` + `compose.local.yaml`** (both `-f` flags, always) |
| Port | `0.0.0.0:3210` → container `3000` |
| Public URL | `https://<HOMECARE_HOST>` via the `cloudflared` container |
| Direct URL | `http://<SEARXNG_HOST>:3210` from the LAN, `http://127.0.0.1:3210` on the box |
| Data | bind mount `~/projects/homechores/selfhost-data` → `/data` (SQLite + rule photos) |

`compose.local.yaml` is **untracked** and holds the real run config: it `!override`s the port
back to 3210 (so the tunnel ingress needs no change) and sets `VINEXT_TRUSTED_HOSTS` to
`<HOMECARE_HOST>,<SEARXNG_HOST>:3210,localhost:3210,127.0.0.1:3210`. That trust config is
what makes the tunnel's `X-Forwarded-Host` rebuild the URL as `https://<HOMECARE_HOST>` —
required for the app's same-origin CSRF check (`lib/auth.ts` `requireSameOrigin`). Break it and
admin writes start failing with 403, not with an obvious error.

`compose.yaml` hard-requires `SITE_ORIGIN` and `SCHEDULER_HOST` (`${VAR:?}`). Both come from the
untracked **`.env`** in the project dir, which `docker compose` auto-loads — never inline them.

## Deploy

```sh
# 0. Land the change on main first (MR flow; see "Source" below).
git -C ~/Documents/projects/homechores fetch origin && git log --oneline -1 origin/main

# 1. Back up production data (never skip; refuses to overwrite an existing destination).
ssh the CI runner box 'bash -lc "mkdir -p ~/backups/homechores && cd ~/projects/homechores && \
  DEST=~/backups/homechores/pre-deploy-\$(date +%Y%m%d-%H%M%S) && \
  DATA_DIR=./selfhost-data node runtime/data.mjs backup \$DEST && echo BACKUP_TO=\$DEST"'

# 2. Pull.
ssh the CI runner box 'cd ~/projects/homechores && git fetch origin && git merge --ff-only origin/main'

# 3. Build + recreate. Cached layers make this ~15 s; cold it is minutes.
ssh the CI runner box 'cd ~/projects/homechores && \
  docker compose -f compose.yaml -f compose.local.yaml up -d --build'
```

Use `bg_start` for step 3 if the layer cache is cold.

## Verify (all four, every time)

```sh
ssh the CI runner box 'cd ~/projects/homechores &&
  docker ps --filter name=homechores --format "{{.Names}} {{.Status}} {{.Ports}}" &&
  curl -s -m 6 http://127.0.0.1:3210/api/health && echo &&
  python3 -c "
import sqlite3
c=sqlite3.connect(\"selfhost-data/scheduler.sqlite\")
for t in [\"tasks\",\"task_occurrences\",\"task_templates\",\"admin_users\",\"settings\"]:
    print(t, c.execute(f\"select count(*) from {t}\").fetchone()[0])
"'
```

1. **Container** `Up (healthy)` on `0.0.0.0:3210->3000/tcp`.
2. **`/api/health`** returns `{"ok":true}`.
3. **Data intact** — table counts must match the backup manifest exactly. Baseline as of
   2026-10-14: `tasks 40`, `task_occurrences 8936`, `task_templates 82`, `admin_users 1`,
   `settings 14`, `photos 0`.
4. **The new code is actually served.** Minification mangles names, so grep the chunk the page
   references for a literal that only the new commit introduces:

```sh
CHUNK=$(curl -s http://127.0.0.1:3210/ | grep -oE "current-time-line-[A-Za-z0-9_-]+\.js" | head -1)
curl -s "http://127.0.0.1:3210/_next/static/chunks/$CHUNK" | grep -c isContentEditable
```

A browser smoke test (page renders, zero console errors) is cheap and worth doing:

```sh
agent-browser --session pi-homechores-prod open http://<SEARXNG_HOST>:3210/
agent-browser --session pi-homechores-prod console   # expect nothing
agent-browser --session pi-homechores-prod close
```

## Migration safety

The Node target **auto-migrates at startup** from `drizzle/meta/_journal.json`
(`runtime/start.mjs`). So a deploy can silently mutate the production DB. Before step 3:

```sh
ssh the CI runner box 'cd ~/projects/homechores && ls drizzle/*.sql | wc -l && python3 -c "
import sqlite3
print([r[0] for r in sqlite3.connect(\"selfhost-data/scheduler.sqlite\")
       .execute(\"select name from _home_care_migrations order by name\")])
"'
```

If the disk list and the applied list match, the deploy is code-only — say so. If new
migrations appear, that is a schema change against live household data: confirm the backup
first and expect the container to apply them on boot.

## Rollback

```sh
# Data (if a migration or bad write landed): stop, restore, restart.
ssh the CI runner box 'bash -lc "cd ~/projects/homechores && docker compose -f compose.yaml \
  -f compose.local.yaml stop && DATA_DIR=./selfhost-data \
  node runtime/data.mjs restore ~/backups/homechores/pre-deploy-<STAMP> && \
  docker compose -f compose.yaml -f compose.local.yaml up -d"'
```

Code-only rollback: the previous image survives as a **dangling** image (e.g. `3ae54d7ab78a`)
until something prunes it — `docker image ls -f dangling=true`. Because that is fragile,
**retag before deploying** if the change is risky:
`ssh the CI runner box 'docker tag home-care-scheduler:local home-care-scheduler:pre-<stamp>'`,
then `docker tag` it back and `up -d`.

## Traps

- **`node` is not on the non-interactive PATH** on `the CI runner box` (it's under nvm / `~/.local/bin`).
  Any `ssh the CI runner box 'node ...'` fails with `command not found`. Wrap it: `ssh the CI runner box 'bash -lc "..."'`.
- **Sites / `wrangler` is not the deploy path.** `wrangler whoami` is unauthenticated and the
  Sites hosting skill isn't installed; `@openai/sites-vite-plugin` only copies
  `.openai/hosting.json` + `drizzle/**` into `dist/.openai`. Don't "helpfully" deploy with
  wrangler — AGENTS.md forbids touching the Site's real D1 binding.
- **The NAS is a different, unreachable installation.** `<NAS_LAN_HOST>` / `<LAN_HOST>` does not
  resolve or route from the Mac, and its Docker is GUI-managed. `deploy/nas/compose.yaml` is a
  mirror of that other stack — do not run it here, and note it builds with
  `HOME_CARE_BASE_PATH=/homecare` whereas the CI runner box serves the **root path**.
- **Never run a second stack against `selfhost-data`.** The two `-f` flags are mandatory; using
  only `compose.yaml` republishes on `127.0.0.1:3080` and can fail outright on the missing
  `${SITE_ORIGIN:?}` / `${SCHEDULER_HOST:?}`.
- **Don't use production as a testbed.** No disposable fixtures, no admin-account resets, no
  poking working-hours to make a UI element appear. Verify UI behaviour against the repo's
  disposable e2e harness (`e2e/harness.mjs`) instead, and verify production by bundle markers +
  health + smoke test.
- **Time-of-day matters for verification.** The current-time line only renders inside the stored
  working-hours window in Singapore time, so an evening deploy legitimately shows no line —
  that is not a regression.

## Source

Changes land on `main` via GitLab MRs on `marklauyq/homechores` (`glab mr create/merge`; the
CLI is authenticated). Validate before merging per the repo's own gate:
`npm run typecheck && npm test && npm run build && npm run test:worker && npm run test:e2e && git diff --check`.
A saved version or a merged branch is not a deploy — the deploy is step 3 above.
