---
name: uob-statements
description: Download UOB Singapore personal bank statement PDFs (eStatements, up to ~5 years back) and ingest them into the money-planner dev server. Use for ANY "get my UOB statements / transactions / history" task. Idempotent — only pulls months not already ingested. Drives a headed browser via agent-browser; user approves the 2FA push on their phone.
compatibility: Requires agent-browser CLI (headed Chrome), a `uob-pw` secret (bank password), and the money-planner app running (default http://localhost:5173).
---

# UOB statements → money-planner

> **First:** read the `bank-scraping` skill (central gotchas: CDP hygiene,
> downloads, captcha policy, dedupe rules, app API quirks).

Pull monthly eStatement PDFs for a UOB SG account and load them into money-planner.
Two phases: **browser (download)** and **app (ingest)**. Both are idempotent —
re-running only fetches months that are missing.

## Never do these
- Never type the bank password from chat/context — fill it with the secret
  placeholder: `agent-browser fill @eN "{{secret:uob-pw}}"` (substituted at exec
  time only). Never `echo`/`get value` the password field.
- Never call the bank's JSON API directly — every request/response body is an
  `encData` encrypted envelope. All data must come from UI clicks + file downloads.
- Never use the account-detail page's "Download as Excel" — its date picker is
  capped at ~2 months. eStatements (below) is the long-history path.
- Never navigate back/forward or re-open the entry URL while logged in — this
  SPA logs the session out. If lost, click "Log in again" and redo login.

## Phase 0 — dedupe check (do this FIRST)
Determine which months are already ingested, and only download the rest.

```bash
# canonical: what the app already has (filename convention uob_<acct>_<mon><year>.pdf)
curl -s -b /tmp/mp-cookies.txt http://localhost:5173/api/files \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{(JSON.parse(d).files||[]).forEach(f=>console.log(f.filename,f.status))})'
# fallback: local spool dir
ls uploads/uob/
```

Month key format: `oct2025`, `nov2025`, ... (lowercase 3-letter mon + 4-digit year).
If the app DB and the spool dir disagree, trust the app DB (a file may have been
deleted locally after ingest).

## Phase 1 — login (headed browser)
Session name: `pi-uob` (pass `--session pi-uob` on EVERY command).

```bash
agent-browser --session pi-uob open \
  "https://pib.uob.com.sg/PIBLogin/Public/processPreCapture.do?keyId=lpc" --headed
```

1. `snapshot -i` → find `textbox "USERNAME"` / `textbox "PASSWORD"` / `button "Log in"`.
2. `fill @<user> "<UOB_USERNAME>"` (ask the user for the username once; don't hardcode it anywhere),
   `fill @<pw> "{{secret:uob-pw}}"`, then `click @<login>`.
3. A push goes to the user's phone ("We have sent a notification to your UOB
   digital token-enabled device"). **Tell the user to approve immediately** — it
   expires in ~30–60 s. Poll until the URL contains `accountsDashboard`:
   ```bash
   for i in $(seq 1 20); do sleep 4; url=$(agent-browser --session pi-uob get url); [[ "$url" == *accountsDashboard* ]] && break; done
   ```
4. If instead a **Token OTP** page appears, ask the user to type it in the
   browser window themselves (6-digit codes go stale too fast to route via chat).
   If login lands on "You have been logged out", click "Log in again" and redo.

## Phase 2 — navigate to eStatements
Route: **Apply & Services** tab → **View eStatements** → account button.

```bash
agent-browser --session pi-uob snapshot -i   # tab "Apply & Services" → click it
agent-browser --session pi-uob snapshot -i   # generic "View eStatements" → click it
agent-browser --session pi-uob snapshot -i   # buttons like "One Account 773 364 964 3"
```

Click the button matching the target account (match on the account number the
user gave, e.g. `773`). The page shows a `Date range` textbox and one
`Download` button per statement month, **newest first**.

## Phase 3 — widen the date range (the tricky part)
The picker defaults to the last ~3 months but **exposes years back to ~2021**.
It is a two-step month-range picker; the commit semantics are fussy:

1. Click the range textbox to open the picker.
2. Click the **start-month chip** in the picker header (e.g. `generic "Jul 2026"`)
   to (re)select the start side.
3. Click the year button (e.g. `button "2026"`) → a year grid appears
   (`generic "2025"` etc., one chip per year). Click the target year chip.
4. The month listbox updates to that year → click `option "Choose October 2025"`.
5. The picker switches to the END side. **Click the end month option even if it
   shows `[selected]`** — the range only commits on that click.
6. Verify: `eval 'document.querySelector("input")?.value'` must show e.g.
   `"Oct 2025 - Oct 2026"`. If it still shows the old range, repeat step 5.

## Phase 4 — download only the missing months
Map buttons to months: rows are newest-first, so with 12 statements
`@e3`=Sep 2026 … `@e14`=Oct 2025 (refs shift after re-render — always re-`snapshot -i`
and count rows, don't assume). Cross-check labels with
`snapshot | grep StaticText` (one `"Mon YYYY"` per row).

```bash
mkdir -p uploads/uob
agent-browser --session pi-uob download @eN uploads/uob/uob_<acct>_<mon><year>.pdf
```

- SKIP any month already present per Phase 0.
- If a download fails with `Resource temporarily unavailable` or times out:
  `scrollintoview @eN` first, then retry the `download` once. (Known daemon quirk.)
- The current month's statement usually doesn't exist yet — expect N-1 months
  for an N-month range ending this month.

## Phase 5 — ingest into money-planner
```bash
B=http://localhost:5173
curl -s -c /tmp/mp-cookies.txt -d 'username=admin&password=<dev admin pw>' -o /dev/null $B/auth/login
BID=$(curl -s -b /tmp/mp-cookies.txt $B/api/budgets | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log((JSON.parse(d).budgets||[])[0].id))')
curl -s -b /tmp/mp-cookies.txt -X POST $B/api/budgets/$BID/switch   # session needs an active budget
for f in <only-missing-files>; do
  curl -s -b /tmp/mp-cookies.txt -o /dev/null -w "%{http_code} $f\n" \
    -F "file=@$f" -F "sourceName=UOB <AccountType> <digits>" $B/api/files
done
```

- `302` = accepted (redirect to file page); processing is queued automatically.
- The app has a built-in deterministic parser for these PDFs
  (`src/parsers/pdf-uob-bank.js`) — no LLM parser generation needed.
- Poll `GET /api/files` until each file is `completed`. LLM *categorization* is
  slow (~8 s/item, 30 s timeouts are non-fatal — items just stay `new` for
  human review). Don't block on it; report counts and move on.

## Phase 6 — wrap up
- `agent-browser --session pi-uob close` (never `--all`) when done.
- Report: months pulled this run, months skipped (already had), total line items.
