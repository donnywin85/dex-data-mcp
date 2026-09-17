// Read-only: find the custom (non-<select>) dropdowns for Expiration and package scope.
const path = require('path');
const PE = 'C:/Users/donny/Documents/passive-empire';
const puppeteer = require(path.join(PE, 'node_modules', 'puppeteer-core'));
const mutex = require(path.join(PE, 'shared', 'chrome-mutex.js'));

(async () => {
  const lockId = await mutex.acquireLock('x402-budget-npm-publish-002', { port: 9222 });
  let browser, page;
  try {
    browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
    page = await browser.newPage();
    await page.bringToFront();
    await page.goto('https://www.npmjs.com/settings/donnywin85/tokens/granular-access-tokens/new', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 4000));
    const out = await page.evaluate(() => {
      const desc = (el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: (el.className && String(el.className).slice(0, 80)) || null,
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        ariaHasPopup: el.getAttribute('aria-haspopup'),
        ariaExpanded: el.getAttribute('aria-expanded'),
        text: (el.innerText || '').trim().slice(0, 60),
      });
      const widgets = [...document.querySelectorAll('[role=combobox],[role=listbox],[aria-haspopup],[role=button]')].map(desc);
      // everything textual near the Expiration heading
      const heads = [...document.querySelectorAll('h1,h2,h3,h4,legend,label,p,span,div')]
        .filter((e) => /^(Expiration|Expiration Date|Packages and scopes|Organizations)$/i.test((e.innerText || '').trim()))
        .map((e) => ({ head: e.innerText.trim(), parentHTML: (e.parentElement ? e.parentElement.outerHTML : '').slice(0, 700) }));
      return { widgets, heads };
    });
    console.log(JSON.stringify(out, null, 2).slice(0, 8000));
  } catch (e) { console.log(JSON.stringify({ error: String(e && e.message || e) })); }
  finally {
    if (page) { try { await page.close(); } catch {} }
    if (browser) { try { await browser.disconnect(); } catch {} }
    mutex.releaseLock(lockId, { port: 9222 });
  }
})();
