---
name: revolut-statements
description: Download Revolut Singapore account transaction exports (Excel/CSV statement, month-granularity range) and ingest into money-planner. Use for ANY "get my Revolut transactions/history" task. Idempotent — computes missing windows from the app; never hardcodes dates. Drives the bank-browser container Chrome via CDP. Read the bank-scraping skill first.
compatibility: money-planner repo with docker compose `bank-browser` service; `revolut-pw` secret (6-digit passcode); phone with Revolut app for push approval; account email inbox as 2FA fallback.
---

# Revolut (SGD account) → money-planner

Revolut's web app exports an arbitrary month-range transaction file in one shot —
no per-month files like UOB. The export labelled "Excel" is actually **CSV**.

## Phase 0 — dedupe (never hardcode dates)
Per bank-scraping §6: find source matching `Revolut.*<ACCT>` (e.g. "Revolut SGD"),
get its newest line-item date.
- `from` = month-start of (maxDate + 1 day); no source yet → today − 12 months.
- Range picker is MONTH-granularity, so windows are whole months — fine, the
  app-side dedupe rule (no unique constraints) is enforced by `from` being the
  first missing month.
- Nothing missing → report and stop.

## Phase 1 — connect & verify the browser
```bash
agent-browser --session pi-rev connect http://localhost:3081
agent-browser --session pi-rev eval 'navigator.userAgent'   # MUST say X11; Linux
```
If it says `Macintosh...HeadlessChrome` you fell back to local Chromium — close
the session, ensure `docker compose up -d bank-browser`, re-`connect`.
(On the Mac dev box instead: drive the user's real Chrome via AppleScript like
the amex-statements skill does.)

## Phase 2 — login (only if not logged in)
`open https://app.revolut.com/home`. Outcomes:
- lands on app.revolut.com/home → skip to Phase 3 (session persisted in profile).
- Cloudflare "Just a quick security check" interstitial → usually auto-passes in
  ~5 s; if a checkbox persists, user clicks it in the web desktop (:3080).
- `sso.revolut.com/signin` phone page → fill the number WITHOUT the +65 (the
  country button already shows +65), click Continue.
- hCaptcha puzzle (new device) → USER solves in web desktop. Never automate.
- `sso.revolut.com/passcode` → 6 boxes: click box 1, `keyboard type
  "{{secret:revolut-pw}}"` (auto-advances; the "password" IS the passcode).
- Then "Confirm with Revolut app": **tell the user to approve NOW** (push
  expires ~1 min). Poll host == app.revolut.com (careful: the sso URL contains
  `app.revolut.com` in its redirect_uri param — match the HOST, not substring).
  Expired? "Try again" to resend. Push failing repeatedly → "Choose another
  method" → Email: the link must be opened in THIS browser — ask the user to
  copy-link from the email and `open` that URL via the container browser.

## Phase 3 — generate the export
One continuous pass (dialog resets when closed; re-snapshot before EVERY click —
the neighboring "Move money" button is a trap):
1. `find text "Statement" click` (or the `button " Statement"` ref).
2. Click the `tab "Excel"`.
3. Click `button "Starting on"` → calendar: click the year heading to toggle
   year/month views; `button "Previous"/"Next"` step years; click the
   `gridcell "<Month> <year>"` for `from`'s month. End month defaults to now.
4. Click `button "Generate"` (if a plain click doesn't register, JS-dispatch:
   `[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Generate").click()`).
5. Poll for `button "Download"` ("Statement is ready" appears; generation takes
   10–60 s server-side). Click it.

## Phase 4 — capture the file (container quirk)
The download saves INSIDE the container, not the host:
```bash
docker exec money-planner-bank-browser-1 ls -t /config/Downloads | head -2
docker cp 'money-planner-bank-browser-1:/config/Downloads/<file>' \
  uploads/revolut/revolut_<acct>_<from>-<to>.csv
```
If chrome://downloads shows "Failed - Download error": the download dir/pref is
missing again (bank-scraping §3) — mkdir /config/Downloads + set
`download.default_directory` in the profile Preferences, restart container.

## Phase 5 — transform + upload
Export columns: `Type,Product,Started Date,Completed Date,Description,Amount,
Fee,Currency,State,Balance`.
- Keep `State=COMPLETED` rows; `Date` = Completed Date (date part); quote
  Description (escape `"`), pass Amount through (already signed).
- Upload `POST /api/files` with `sourceName=Revolut <ACCT>`; 302 = accepted.
- Sanity: row count matches the export; report window + counts.

## Phase 6 — wrap up
Leave the browser session alive (persistent profile = next run skips login).
Report window pulled / skipped, transaction count, any manual steps needed.
