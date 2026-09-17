// Read-only: what 2FA methods does npm's escalation screen actually offer?
// Captures every link and button. Clicks nothing, types nothing.
const path = require('path');
const PE = 'C:/Users/donny/Documents/passive-empire';
const puppeteer = require(path.join(PE, 'node_modules', 'puppeteer-core'));
const mutex = require(path.join(PE, 'shared', 'chrome-mutex.js'));

(async () => {
  const url = process.argv[2];
  const lockId = await mutex.acquireLock('x402-budget-npm-publish-002', { port: 9222 });
  let browser, page;
  try {
    browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
    page = await browser.newPage();
    await page.bringToFront();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3500));
    const out = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body.innerText || '').trim().slice(0, 3000),
      links: [...document.querySelectorAll('a')].map((a) => ({
        text: (a.innerText || '').trim().slice(0, 90), href: a.getAttribute('href'),
      })).filter((l) => l.text || l.href),
      buttons: [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean),
      // does the browser even have a platform authenticator available?
      forms: [...document.querySelectorAll('form')].map((f) => f.getAttribute('action')),
    }));
    out.platformAuthenticator = await page.evaluate(async () => {
      try {
        if (!window.PublicKeyCredential) return 'no PublicKeyCredential';
        const ok = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        return ok ? 'platform authenticator AVAILABLE (Windows Hello)' : 'no platform authenticator';
      } catch (e) { return 'probe failed: ' + String(e.message || e); }
    });
    await page.screenshot({ path: path.join(__dirname, 'escalate-screen.png') }).catch(() => {});
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ error: String(e && e.message || e) }, null, 2));
  } finally {
    if (page) { try { await page.close(); } catch {} }
    if (browser) { try { await browser.disconnect(); } catch {} }
    mutex.releaseLock(lockId, { port: 9222 });
  }
})();
