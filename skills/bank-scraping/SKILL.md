---
name: bank-scraping
description: Shared ground rules and gotchas for ALL bank/financial-site scraping (UOB, AMEX, Revolut, Citi, ...). Read BEFORE any bank statement/transaction-fetching task — the per-bank skills assume you know these. Covers bot-detection, browser choice, CDP hygiene, downloads, captcha/2FA policy, dedupe rules, and app-side API quirks.
---

# Bank scraping — central gotchas (read before any bank task)

These were each learned the expensive way. The per-bank skills (uob-statements,
amex-statements, revolut-statements) link back here.

## 1. Bot detection decides the browser — not your preference
- **Real Chrome profile or trusted fingerprint is the baseline.** Automation
  Chromium gets silently blocked: the symptom is *no error* — submit buttons do
  nothing, zero network requests, or 2FA says "try again later".
- Per-bank verdicts (retest if stale):
  - UOB: agent-browser's headed Chromium is fine.
  - AMEX: blocks ALL automation browsers (even real-Chrome-binary with fresh
    profile + stealth flags). Needs the user's real Chrome (AppleScript on Mac)
    or the bank-browser container's persistent real Chrome (CDP).
  - Revolut: works with the bank-browser container Chrome; shows hCaptcha on
    first login from a "new device" and Cloudflare interstitials after restarts.
- **Never fight the risk engine.** If a challenge persists after one retry, hand
  the user the web desktop URL (or their own browser) to complete it, then continue.

## 2. CDP hygiene (bank-browser container)
- Infra: `docker compose up -d bank-browser` → real Chrome, persistent profile
  volume (`/config/chrome-profile`), CDP `:3081`, web desktop `:3080`.
- **Always verify which browser you're driving**: `eval 'navigator.userAgent'` —
  `X11; Linux... Chrome` = container ✅; `Macintosh... HeadlessChrome` = you
  silently fell back to local Chromium ❌ (agent-browser does this without
  erroring when the CDP connection dies, e.g. after a container restart).
  Re-`connect` to CDP after every container restart.
- Chrome 136+ refuses CDP on the DEFAULT profile dir → the container passes an
  explicit `--user-data-dir` (baked into `docker/bank-browser/autostart`).
  Recreating a container leaves a stale `SingletonLock` → autostart clears it.
- Verify free ports before mapping anything (`lsof -nP -iTCP -sTCP:LISTEN`).

## 3. Downloads in the container
- Container Chrome downloads land in **`/config/Downloads`** (dir must exist +
  `download.default_directory` set in Preferences — already patched into the
  image config; if downloads say "Failed - Download error" in chrome://downloads,
  that's the cause: create the dir, set the pref, restart).
- `agent-browser download <ref> <hostpath>` does NOT stream remote files — with
  a CDP-attached browser, click normally and fetch the file with `docker cp`.
- Fixed-name exports (AMEX `activity.xlsx`) overwrite each other — move the file
  immediately after it appears.

## 4. Captchas & 2FA — human in the loop, always
- Never auto-solve hCaptcha/Turnstile/puzzles. Route to the user: phone push
  (UOB/AMEX/Revolut) or web desktop click (Revolut hCaptcha, Cloudflare).
- Push notifications expire in ~1 min — tell the user BEFORE you trigger one.
- Passwords/passcodes: `{{secret:...}}` placeholders or `/run/secrets/*` only;
  never in argv, files, or echoed output.

## 5. SPA clicking discipline
- **Re-`snapshot -i` before EVERY click** — refs go stale after any re-render,
  and on banking SPAs the wrong button can be a money-mover (Revolut's
  "Statement" vs "Move money" share layout). If you click anything in a
  transfer/payment dialog: press Escape immediately, do NOT confirm anything.
- Dialogs RESET their settings when closed (Revolut statement dates) — drive
  the whole dialog flow in one continuous pass.
- AppleScript `execute javascript` is synchronous: Promises resolve to
  `undefined`; split click + inspect into separate calls with sleeps between.

## 6. Dedupe rules (applies to every bank)
- Query the app FIRST; never hardcode dates:
  - `GET /api/budgets` (bare ARRAY) → `POST /api/budgets/:id/switch`
  - `GET /api/sources` (bare array), `GET /api/files` ({files:[]})
  - newest date: `GET /api/line-items?sourceFileId=..&sortBy=date&sortOrder=desc&limit=1`
    (note the **hyphen**: `/api/line-items`, not lineItems)
- LineItems have NO unique constraint → overlapping imports create duplicates.
  Pull `from = maxDate + 1 day` (AMEX/Revolut) or only months with no file yet
  (UOB/Revolut month granularity).
- Upload `POST /api/files` (multipart `file` + `sourceName`): **302 = accepted**;
  processing is queued; LLM categorization trails and is non-fatal.
- Session cookies expire (401/`Unauthorized`) → re-login (`admin/admin` dev) and
  re-switch budget before any API burst.

## 7. Report honestly
- State months/windows pulled vs skipped (already had), transaction counts, and
  any step a human had to complete.
