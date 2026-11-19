---
name: amex-statements
description: Download American Express Singapore transaction exports (CSV via Custom Date Range) and ingest them into the money-planner dev server. Use for ANY "get my AMEX transactions / history / statements" task. Idempotent — computes the missing date window from what's already in the app; never hardcodes dates. Requires driving the user's REAL Chrome via AppleScript (AMEX blocks all automation browsers).
compatibility: macOS + user's real Google Chrome with "Allow JavaScript from Apple Events" enabled; `amex-pw` secret; money-planner dev server (default http://localhost:5173); `xlsx` npm pkg in the project.
---

# AMEX transactions → money-planner

> **First:** read the `bank-scraping` skill (central gotchas: CDP hygiene,
> downloads, captcha policy, dedupe rules, app API quirks).

AMEX exposes ONE thing worth having: the Custom Date Range transaction export
(`activity.xlsx`, columns Date/Description/Amount + merchant metadata). Statement
PDFs exist but are strictly worse for ingestion. The export is fetched for an
arbitrary date window, so the job is: **compute the missing window → export it →
convert → upload**.

## Why AppleScript, not agent-browser (do NOT "just try chromium")
AMEX's risk engine blocks every automation browser — Playwright/Chromium, and even
real Chrome launched with a fresh profile or stealth flags (symptoms: login submit
silently does nothing, zero network requests, 2FA says "Please try again later",
or bounces back to login). The user's real Chrome (real profile = trusted device)
passes 2FA with NO OTP prompt. Drive it via AppleScript `execute javascript`.

## Phase 0 — compute the missing window (do this FIRST; never hardcode dates)
```bash
B=http://localhost:5173
# 1. find the AMEX source (match e.g. "AMEX.*51005" against user's card last-4)
curl -s -b /tmp/mp-cookies.txt $B/api/sources
# 2. its files
curl -s -b /tmp/mp-cookies.txt "$B/api/files?limit=100"
# 3. newest transaction date in each file of that source:
curl -s -b /tmp/mp-cookies.txt "$B/api/lineItems?sourceFileId=<id>&sortBy=date&sortOrder=desc&limit=1"
```
- `from` = (max date across those files) **+ 1 day**; no source/files/items yet →
  `from` = today − 365 days. `to` = today.
- If `from` > today: nothing missing → report and STOP.
- LineItems have NO unique constraint — overlapping windows create duplicate
  rows, so never overlap; +1 day is mandatory.
- AMEX only has data back ~7 years; if user asks for more, clamp `from`.

## Phase 1 — prerequisites probe
```bash
osascript -e 'tell application "Google Chrome" to execute front window'"'"'s active tab javascript "1+1"'
```
- `2` → good.
- "Executing JavaScript through AppleScript is turned off" → ask the user to
  enable **View → Developer → Allow JavaScript from Apple Events** (Chrome must
  have a visible window; if they can't see one, `osascript -e 'tell application
  "Google Chrome" to activate' -e 'tell application "Google Chrome" to make new
  window'`). Wait for the user; do not fall back to agent-browser.

## Phase 2 — the JS runner (write once, reuse ALL session)
AppleScript `execute javascript` is **synchronous — Promises return `undefined`**.
Never rely on async JS; split into click-call + sleep + inspect-call.

`/tmp/axjs2.applescript` — targets a tab by URL substring (the user's Chrome has
many tabs; NEVER assume front tab is AMEX):
```applescript
on run argv
	set js to read POSIX file (item 1 of argv) as «class utf8»
	set matchStr to item 2 of argv
	tell application "Google Chrome"
		repeat with w in windows
			repeat with t in tabs of w
				if (URL of t) contains matchStr then return execute t javascript js
			end repeat
		end repeat
		return "NO_TAB"
	end tell
end run
```
Usage: write JS to `/tmp/axjs.js`, then
`osascript /tmp/axjs2.applescript /tmp/axjs.js americanexpress`.

## Phase 3 — login (only if not already signed in)
Open a new tab to `https://www.americanexpress.com/en-sg/account/login/`, wait,
then check URL via the runner (`location.href`):
- contains `global.americanexpress.com/dashboard` → already logged in, skip to Phase 4.
- login page → fields are `#eliloUserID`, `#eliloPassword`, submit `#loginSubmit`.
  React needs native-setter fills:
  ```js
  (()=>{const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  const u=document.getElementById('eliloUserID'),p=document.getElementById('eliloPassword');
  s.call(u,'<AMEX_USER_ID>');u.dispatchEvent(new Event('input',{bubbles:true}));
  s.call(p,'PASSWORD_HERE');p.dispatchEvent(new Event('input',{bubbles:true}));
  document.getElementById('loginSubmit').click();return 'clicked'})()
  ```
  **Password must never appear in a file or in AppleScript source**: put a
  placeholder token in the JS file and build the final JS in a tiny wrapper
  applescript that does `set pw to (system attribute "AMEX_PW")` and string-
  concatenates, invoked as `AMEX_PW={{secret:amex-pw}} osascript wrapper.applescript`.
  Username: ask the user once (or secret `amex-user`) — don't hardcode.
- Poll URL (3 s × 15): `two-step-verification` usually auto-passes to dashboard on
  a trusted device. If it shows "Please try again later" and bounces back →
  retry ONCE. Still failing → the risk engine distrusts the session: ask the user
  to log in manually in that Chrome window, then continue (never fight it).

## Phase 4 — export the missing window
1. Navigate the tab: `location.href='https://global.americanexpress.com/activity/recent'` (via runner), wait 5 s.
2. Click the **Custom Date Range** tab:
   ```js
   (()=>{const a=Array.from(document.querySelectorAll('a,button,[role=tab]')).find(e=>/custom date range/i.test(e.textContent)&&e.textContent.length<30);a.click();return a?'ok':'nf'})()
   ```
3. Set dates. Visible text inputs (in DOM order after the search box):
   [2]=start dd [3]=start mm [4]=start yyyy, hidden input[1] = ISO start
   (`name=undefined-start-date`), hidden input[5] = ISO end. Set BOTH the visible
   dd/mm/yyyy and the hidden ISO start with native setter + `input`/`change`
   events (mm/dd are zero-padded). End date = today is the default — only touch
   it if `to` ≠ today (then also set visible inputs [6][7][8]).
   Verify by reading the hidden field back before searching.
4. Click the LAST button whose text is exactly `Search` (there are two; the
   second is the range-search submit). Wait ~8 s.
5. Verify page text contains `N results found` (sanity: N > 0; if 0 and window
   is recent, pending charges may just not be posted — report).

## Phase 5 — download + capture (fixed filename!)
Click the LAST visible button with text exactly `Download`. The file lands at
**`~/Downloads/activity.xlsx`** — a FIXED name that the next export will
overwrite. Detect completion by mtime (newer than a marker you `touch`ed before
clicking), then MOVE immediately:
```bash
touch /tmp/amex-dl-marker
# ...click Download via runner...
for i in $(seq 1 10); do sleep 2; [ ~/Downloads/activity.xlsx -nt /tmp/amex-dl-marker ] && break; done
mv ~/Downloads/activity.xlsx <project>/uploads/amex/amex_<last4>_<fromYYYYMMDD>-<toYYYYMMDD>.xlsx
```

## Phase 6 — convert + upload
```bash
cd <project> && npm i --no-save xlsx   # once
node -e '
const XLSX=require("xlsx");const wb=XLSX.readFile(process.argv[1]);
const rows=XLSX.utils.sheet_to_json(wb.Sheets["Transaction Details"],{header:1});
const h=rows.findIndex(r=>r[0]==="Date");
const data=rows.slice(h+1).filter(r=>r[0]&&r[1]);
const csv=XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet([["Date","Description","Amount"],...data.map(r=>[r[0],String(r[1]).trim(),r[2]])]));
require("fs").writeFileSync(process.argv[2],csv);console.log("transactions:",data.length)' \
  uploads/amex/<file>.xlsx uploads/amex/<file>.csv
curl -s -b /tmp/mp-cookies.txt -o /dev/null -w "%{http_code}\n" \
  -F "file=@uploads/amex/<file>.csv" -F "sourceName=AMEX <card name> <last4>" $B/api/files
```
- Dates are `MM/DD/YYYY`; `new Date()` parses them US-style — the app's
  normalizer handles AMEX description noise natively.
- `302` = accepted. Poll `GET /api/files` until `completed`; LLM categorization
  trails behind and is non-fatal — report counts, don't block.

## Phase 7 — wrap up
Close the AMEX tab (leave the user's other tabs alone):
```applescript
tell application "Google Chrome"
	repeat with w in windows
		repeat with i from (count of tabs of w) to 1 by -1
			if (URL of tab i of w) contains "americanexpress" then close tab i of w
		end repeat
	end repeat
end tell
```
Report: window pulled, transactions added, window skipped (already had).
