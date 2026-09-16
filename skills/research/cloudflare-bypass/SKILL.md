---
name: cloudflare-bypass
description: Fetch or interactively browse pages that plain HTTP can't because Cloudflare (or similar JS/Turnstile challenges) returns 403 / "Just a moment...". Routes the request through a local, self-hosted FlareSolverr container that drives a real Chromium to solve the challenge and returns the rendered HTML plus a cf_clearance cookie. Also covers handing that solved cookie to agent-browser so you can click/scroll/scrape a Cloudflare-protected site interactively. Use for ANY "site blocks my scraper / returns 403 / bot check" situation.
compatibility: Requires Docker. FlareSolverr's image is multi-arch, so Linux ARM64 (GB10) is fine. Container listens on localhost:8191.
---

# cloudflare-bypass

When a normal `curl`/`requests` fetch returns **HTTP 403** or a **"Just a
moment..." / "Checking your browser"** interstitial, the site is behind a
Cloudflare JS/Turnstile challenge. Route the request through **FlareSolverr**: it
drives a real headless Chromium that passes the challenge, then hands you back
the fully-rendered HTML and the cookies (including `cf_clearance`).

## Getting actual image/asset bytes (CDN blocks curl & fetch)

FlareSolverr solves the *page*, but asset CDNs (e.g. `pic2.99.co` floor plans) may still refuse curl and return an HTML wrapper even to FlareSolverr. See the **cloudflare-image-capture** skill: capture the bytes with headless Playwright (`page.on('response')` + `res.body()` while the page loads the `<img>`).

## Privacy / trust (read once)

FlareSolverr is open-source and **self-hosted on this box**. Traffic flows
`your machine -> FlareSolverr (localhost:8191) -> the target site`, straight out
from your own IP — **no third-party relay** (unlike hosted scraping APIs, which
see all your requests). You are trusting the pinned Docker image and letting the
container's browser run the target site's JS, exactly as any browser does when
you visit the page.

## Step 1 — ensure FlareSolverr is running

```bash
curl -fsS http://localhost:8191/ >/dev/null 2>&1 || \
docker run -d --name flaresolverr --restart unless-stopped \
  -p 127.0.0.1:8191:8191 -e LOG_LEVEL=info \
  ghcr.io/flaresolverr/flaresolverr:latest
```

It's ready when `curl http://localhost:8191/` returns
`{"msg": "FlareSolverr is ready!", ...}` (first start pulls the image; give it
~15s).

## Step 2 — fetch the blocked URL through it

POST to `/v1` with `cmd: request.get`:

```bash
curl -sS -m 90 -X POST http://localhost:8191/v1 \
  -H 'Content-Type: application/json' \
  -d '{
    "cmd": "request.get",
    "url": "https://EXAMPLE.com/the-blocked-page",
    "maxTimeout": 80000
  }'
```

For a POST target, use `"cmd": "request.post"` and add
`"postData": "a=1&b=2"` (form-encoded).

## Step 3 — read the result

The response JSON contains:

| Field | Meaning |
|-------|---------|
| `.status` | `"ok"` on success |
| `.message` | `"Challenge solved!"` (or `"Challenge not detected!"` if the URL wasn't protected) |
| `.solution.status` | the target's HTTP status — expect `200` |
| `.solution.response` | the **full rendered HTML** — parse this |
| `.solution.cookies` | array incl. **`cf_clearance`** (see reuse below) |
| `.solution.userAgent` | the UA the browser used — reuse it with the cookie |

Sanity-check that `.solution.response` does NOT still contain
`"just a moment"` / `"cf-challenge"` / `"turnstile"` — if it does, the challenge
wasn't solved (retry, or the site needs a harder solver).

## Reuse the clearance cookie — do this to avoid rate limits

Solving a challenge is slow (~10-40s) and hammering FlareSolverr triggers
**harder** challenges / bans. After Step 2, extract `cf_clearance` from
`.solution.cookies` and the UA from `.solution.userAgent`, then make follow-up
requests as **plain fast HTTP** (no FlareSolverr) reusing both:

```bash
curl -sS 'https://EXAMPLE.com/next-page' \
  -H "User-Agent: <solution.userAgent>" \
  -H "Cookie: cf_clearance=<value>"
```

Pattern: **FlareSolverr solves the gate once; plain HTTP does the bulk fetching.**
Space requests a few seconds apart. Re-run Step 2 only when you get a 403 again
(cookie expired).

## Interactive browsing: hand the solved cookie to agent-browser

Use this when you need to **click, scroll, page, or scrape a JS-rendered site**
behind Cloudflare — not just one fetch. Two things to know first:

- You **cannot** point `agent-browser --proxy` at FlareSolverr. FlareSolverr is a
  solve-a-URL API, not a forward/HTTP/SOCKS proxy — there is nothing to proxy
  through. (`--proxy` is for a real proxy server; FlareSolverr's own `proxy`
  option is only for an *upstream* proxy it dials out through.)
- **agent-browser alone does NOT pass Cloudflare** — Playwright's Chromium is
  detectable and sits on "Just a moment...".

The working approach: **solve once with FlareSolverr, then transplant its
`cf_clearance` cookie + exact User-Agent into agent-browser.** Verified end to end.

```bash
export PATH="$PATH:$HOME/.nvm/versions/node/v22.22.3/bin"   # agent-browser lives in the nvm bin

# 1) Solve once; capture the cookie AND the exact UA that solved it
curl -sS -m 90 -X POST http://localhost:8191/v1 -H 'Content-Type: application/json' \
  -d '{"cmd":"request.get","url":"https://EXAMPLE.com/","maxTimeout":80000}' > solve.json
UA=$(jq -r .solution.userAgent solve.json)
CF=$(jq -r '.solution.cookies[]|select(.name=="cf_clearance").value' solve.json)

# 2) Launch agent-browser with that SAME UA. (Use your own --session name; on THIS
#    box you must pass Playwright's ARM64 Chromium + --no-sandbox — see agent-browser skill.)
CHROME=$(find ~/.cache/ms-playwright -path '*chrome-linux/chrome' | head -1)
agent-browser --session cf-work close 2>/dev/null   # close first — UA only applies at launch
agent-browser --session cf-work open "https://EXAMPLE.com/" \
  --user-agent "$UA" --executable-path "$CHROME" --args "--no-sandbox"

# 3) Inject the clearance cookie (match the domain from solve.json; cf_clearance is HttpOnly+Secure)
agent-browser --session cf-work cookies set cf_clearance "$CF" \
  --domain ".EXAMPLE.com" --path "/" --httpOnly --secure --sameSite None
#   ── or import ALL of FlareSolverr's cookies in one shot:
#   jq '.solution.cookies' solve.json > cookies.json
#   agent-browser --session cf-work cookies set --curl cookies.json --domain EXAMPLE.com

# 4) Now navigate/click/scrape normally — you're past Cloudflare
agent-browser --session cf-work open "https://EXAMPLE.com/the-page-you-want" \
  --user-agent "$UA" --executable-path "$CHROME" --args "--no-sandbox"
agent-browser --session cf-work get title      # NOT "Just a moment..." if it worked
agent-browser --session cf-work snapshot       # then click/scroll/scrape as usual
```

What makes or breaks it:
- **The User-Agent MUST match exactly** the one that solved the cookie —
  `cf_clearance` is bound to IP **+** UA. A mismatched UA gets the cookie
  rejected and you're back on the challenge. This is why you relaunch
  agent-browser with FlareSolverr's UA.
- **Same machine/IP** for the solve and the browser (both local here — fine).
- **Cookie expires** (~30 min to a few hours) → re-run step 1 and re-inject.
- **Verify** with `get title` / check the body doesn't say "just a moment"
  before you start scraping.

## Gotchas

- **Datacenter IPs get challenged harder.** If solves fail repeatedly on a cloud
  box, the IP is the problem, not the config.
- **Client-side-rendered results.** If a page returns 200 but the data is missing
  from `.solution.response`, the site loads it via a later XHR. Open the site in
  DevTools -> Network -> Fetch/XHR, find the JSON API it calls, and fetch **that**
  endpoint through Step 2 (pass its `cf_clearance` cookie) instead of the HTML page.
- **Long jobs.** Raise `maxTimeout` and the curl `-m` timeout together.
- **Sessions.** For multi-request flows that must share one browser session,
  FlareSolverr also supports `cmd: sessions.create` -> pass the returned
  `session` id on subsequent `request.get` calls.

## Managing the container

```bash
docker logs -f flaresolverr     # watch it solve challenges
docker restart flaresolverr     # if it wedges
docker rm -f flaresolverr       # remove
```
