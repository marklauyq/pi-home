---
name: secrets-intake
description: Deliver a credential to the agent one time with the user's phone approval, when the user is away from the terminal. Use for ANY "I'm not at my terminal / I'm on my phone" situation that needs a password, 2FA seed, or API key not already in the `secret` store. Runs ~/Documents/projects/secrets-intake/intake.sh, which creates an intake record, notifies the user over Telegram, and returns the single-use value on stdout without it ever being stored on disk.
compatibility: Requires the secrets-intake server running on the CI runner box (tunnel https://<SECRETS_INTAKE_HOST>), ~/Documents/projects/secrets-intake/intake.sh, and a git-ignored ~/.pi/agent/secrets-intake.json holding the API key.
---

# Secrets Intake

Per-read, phone-approved secret delivery. Use when you need a credential
(vault password, 2FA seed, API key, login) and the user is **not at the
terminal** — they deliver the value from their phone.

## When to use

- User says "I'm not at my terminal" / "I'm away" / "I'm on my phone"
- You need a credential that is not stored on disk or in the `secret` store
- The user has approved the specific use (you tell them what you need and why)

## How to use

**Run this one command:**

```bash
bash ~/Documents/projects/secrets-intake/intake.sh "<item>" "<reason>"
```

- `<item>` — short label shown on the phone (e.g. "UOB login password")
- `<reason>` — what you need it for (e.g. "Bank statement scrape")
- **stdout** — the secret value (on success)
- **stderr** — error message (on failure)
- **exit 0** — success, value on stdout
- **exit 1** — failure (server down, user didn't deliver, expired, etc.)

The script handles everything: health check, intake creation (API-key
authenticated), server-side Telegram notification, status polling, one-shot
value consumption. No other steps needed.

### One-liner pattern (value never hits the transcript)

When the value goes directly into a command (e.g. filling a browser form):

```bash
agent-browser --session pi-uob fill @eN "$(bash ~/Documents/projects/secrets-intake/intake.sh 'UOB login' 'bank scrape')"
```

The value is substituted at execution time. The script's stdout is the raw
value; the double quotes keep it as one argument.

## What the script does (for reference)

1. Reads `API_KEY` and `BASE_URL` from `~/.pi/agent/secrets-intake.json`
2. Health-checks `$BASE_URL/healthz`
3. `POST $BASE_URL/intake` with `Authorization: Bearer $API_KEY`
4. Server sends Telegram notification to the user's phone (automatic)
5. Polls `GET $BASE_URL/status/<token>` every 5s until `state=fulfilled`
6. `GET $BASE_URL/d/<token>` exactly once (one-shot, destroys the value)
7. Prints the value to stdout

## Prerequisites

- `~/.pi/agent/secrets-intake.json` exists (git-ignored, 600):
  ```json
  {
    "apiKey": "<128-bit hex>",
    "baseUrl": "https://<SECRETS_INTAKE_HOST>"
  }
  ```
- `~/Documents/projects/secrets-intake/intake.sh` exists (the script)
- Server running on the CI runner box (the script health-checks it)
- If the config file is missing, tell the user to register with the
  secrets-intake admin

## Security model

| Mechanism | Protection |
|-----------|------------|
| Intake API key | 128-bit static key, per-agent. Unauthorised → 401. |
| 128-bit deliver token | Unguessable — nobody can find the `/d/` URL without it |
| Single-use delivery | One GET, then destroyed. No replay. |
| 10-min TTL | Narrow window even if the token leaks |
| Value in RAM only | Never written to disk, logs, or the audit log |
| Server-side notification | Agent never handles the bot token |

**Multi-agent note (future):** each PI agent gets its own API key. A
`/register` endpoint and per-agent key management will be added later.

## Server details

- **Host:** the CI runner box (<SEARXNG_HOST>)
- **Docker Compose:** `~/projects/secrets-intake/` (container: `secrets-intake`)
- **Port:** 4870
- **Tunnel:** `https://<SECRETS_INTAKE_HOST>` → `http://<SEARXNG_HOST>:4870`
- **Health:** `curl -sS https://<SECRETS_INTAKE_HOST>/healthz` → `ok`
- **Audit log:** `~/projects/secrets-intake/audit.jsonl` (append-only, never contains the value)
- **API key (server):** `.env` on the CI runner box (git-ignored, 600)
- **API key (agent):** `~/.pi/agent/secrets-intake.json` (git-ignored, 600)
- **Telegram bot:** @MarklauyqBot (server-side, in `.env`). NOT the PI agent's bot.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "server is not healthy" | Container down | `ssh the CI runner box "cd ~/projects/secrets-intake && docker compose up -d"` |
| "record is expired" | User didn't deliver in 10 min | Re-run the script |
| "record is rejected" | User tapped Reject | Re-run the script, ask user to deliver |
| "timed out waiting" | 3 min poll window passed | Re-run the script |
| 401 from intake | Wrong API key | Check `~/.pi/agent/secrets-intake.json` |
| No Telegram notification | Bot token missing in server `.env` | Check `~/projects/secrets-intake/.env` on the CI runner box |

## Notes

- The deliver token appears in the agent's transcript (on disk). Acceptable:
  128-bit random, single-use, TTL-bounded.
- The script exits 1 on any failure. Check stderr for the reason.
- The script is at `~/Documents/projects/secrets-intake/intake.sh` (also on
  the CI runner box at `~/projects/secrets-intake/intake.sh`).
