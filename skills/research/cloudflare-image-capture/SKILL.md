---
name: cloudflare-image-capture
description: Download images/assets from CDNs that block plain HTTP (Cloudflare 403 even with cf_clearance, FlareSolverr returning HTML wrappers, in-page fetch() failing) by capturing response bodies from a headless Playwright browser. Covers the pic2.99.co floor-plan case, macOS setup, and the CF-UA trick.
compatibility: Node.js + playwright-core (npm, no browser download needed — reuses the local Chrome for Testing). macOS path documented; Linux uses agent-browser/Playwright's usual layout.
---

# cloudflare-image-capture

Some image CDNs (e.g. `pic2.99.co`) serve real bytes ONLY to genuine `<img>`
requests (they check `Sec-Fetch-Dest: image` / bot signals). Everything else
fails, even after the Cloudflare gate:

| Method | Result |
|---|---|
| `curl` with `cf_clearance` + matching UA | CF 403 challenge HTML (cookie is zone-bound; CDN zone ≠ page zone) |
| curl + `Sec-Fetch-Dest: image` headers | 403 (TLS/JA3 fingerprint) |
| FlareSolverr `request.get` on the image URL | 200, but a ~640-byte HTML **wrapper page** containing the same URL as an `<img>` — not the bytes |
| In-page `fetch()` from the site | `Failed to fetch` (network error, no `Sec-Fetch-Dest: image`) |
| `<a download>` click via agent-browser | times out, no file |
| **Headless Playwright: load via `<img>`, capture `response.body()`** | ✅ **Works** |

The browser's `<img>` request is exactly what the CDN wants; Playwright's CDP
lets you grab those response bodies.

## Setup (one-time per box)

```bash
mkdir -p /tmp/pwcap && cd /tmp/pwcap
npm init -y && npm i playwright-core --no-fund --no-audit   # no browser download

# macOS: reuse the local Chrome for Testing (already present if agent-browser/
# playwright has ever run here):
EXE=$(ls -d ~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google\ Chrome\ for\ Testing.app/Contents/MacOS/Google\ Chrome\ for\ Testing | sort -r | head -1)
```

## The capture script (proven pattern)

```js
const { chromium } = require('playwright-core');
const fs = require('fs');
const EXE = process.env.PW_EXE;            // path from setup
const urls = JSON.parse(fs.readFileSync('/tmp/img_urls.json', 'utf8')); // {tag: url}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] });
  // CRITICAL: pass FlareSolverr's exact UA string (e.g. "Mozilla/5.0 (X11; Linux
  // x86_64) ... Chrome/148..."). The default headless UA gets stuck on the CF
  // "Just a moment..." challenge on propertyguru.com.sg / 99.co; the FS UA passes.
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  const bodies = new Map();
  page.on('response', (res) => {
    const m = res.url().match(/pic2\.99\.co\/v3\/([A-Za-z0-9]+)/);   // tune the matcher
    if (!m) return;
    (async () => {                                                  // IIFE, NOT an async handler
      try {
        const b = await res.body();
        if (!bodies.has(m[1]) || b.length > bodies.get(m[1]).length) bodies.set(m[1], b);
      } catch (e) { console.log('BODYERR', e.message); }
    })();
  });

  await page.goto('https://www.99.co/singapore/condos-apartments/{project}', { waitUntil: 'domcontentloaded', timeout: 90000 });
  for (let i = 0; i < 30; i++) {                                   // wait out CF challenge
    const t = await page.title().catch(() => '');
    if (!/just a moment/i.test(t)) break;
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(2000);

  for (const [tag, url] of Object.entries(urls)) {
    // force-load the image exactly like the site does (Sec-Fetch-Dest: image)
    await page.evaluate((u) => new Promise((res) => {
      const im = new Image();
      const t = setTimeout(() => res('timeout'), 30000);
      im.onload = () => { clearTimeout(t); res('ok'); };
      im.onerror = () => { clearTimeout(t); res('err'); };
      im.src = u;
    }), url);
    await page.waitForTimeout(1000);
    const buf = bodies.get(url.match(/pic2\.99\.co\/v3\/([A-Za-z0-9]+)/)[1]);
    if (buf && buf.length > 2000) fs.writeFileSync(`/tmp/${tag}.bin`, buf);
    else console.log(tag, 'MISSING');
  }
  await browser.close();
})();
```

Traps learned the hard way:
- **Handler pattern**: `page.on('response', async (res) => { … await res.body() })`
  silently captured nothing in our test run; the IIFE wrapper inside a sync
  handler worked. Use the IIFE.
- **Verify the bytes**: `file /tmp/{tag}.bin` — 99.co serves **WebP**
  (`RIFF ... Web/P image`) with `.jpg`-ish URLs. Rename to `.webp`.
  JPEG = `FF D8`. First bytes `3c` (`<`) = HTML wrapper/403 page.
- **Lazy images**: floor plans on 99.co are in SSR'd `img[data-src]` tags with
  `alt` text — you can grab all URLs from the FlareSolverr-solved HTML without
  a browser; the browser is only needed for the bytes.
- **Signed URLs expire**: the `signature=` param is time-boxed (hours–days).
  Re-solve the project page if downloads start failing with 403.
- 600px-tall signed variants exist; the `width=2048` URL returns up to
  ~1920px wide. Good enough for floor plans.

## Generalization

Any CDN with the same symptom set (CF 403 on curl / HTML wrapper on
FlareSolverr / failed in-page fetch) can likely be captured the same way:
navigate to the referring page (for cookies + referer), then force-load each
asset URL via `new Image()` / `new Worker` fetch is NOT possible — use
`new Image()` for images, and for other asset types, intercept the page's own
requests by scrolling/opening the UI that loads them.

Also remember: a Playwright context can be seeded with cookies from
`agent-browser --session X cookies get --json` when the CF gate is the hard
part (`ctx.addCookies([...])`).
