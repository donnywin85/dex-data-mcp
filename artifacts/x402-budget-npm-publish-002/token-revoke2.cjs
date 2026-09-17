// Revoke x402-budget-first-publish. The per-row delete control is a "×" button.
const path = require('path');
const PE = 'C:/Users/donny/Documents/passive-empire';
const puppeteer = require(path.join(PE, 'node_modules', 'puppeteer-core'));
const mutex = require(path.join(PE, 'shared', 'chrome-mutex.js'));
const NAME = 'x402-budget-first-publish';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const lockId = await mutex.acquireLock('x402-budget-npm-publish-002', { port: 9222 });
  let browser, page; const rep = { at: new Date().toISOString() };
  try {
    browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
    page = await browser.newPage();
    await page.bringToFront();
    await page.goto('https://www.npmjs.com/settings/donnywin85/tokens/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);

    rep.click = await page.evaluate((n) => {
      const rows = [...document.querySelectorAll('tr')].filter((tr) => (tr.innerText || '').includes(n));
      if (!rows.length) return 'NO ROW for ' + n;
      const row = rows[rows.length - 1];
      const btn = [...row.querySelectorAll('button')].find((b) => {
        const t = (b.innerText || '').trim();
        const al = (b.getAttribute('aria-label') || '');
        return t === '\u00d7' || t === 'x' || /delete|revoke|remove/i.test(t + ' ' + al);
      });
      if (!btn) return 'no delete control; row buttons=' + JSON.stringify([...row.querySelectorAll('button')].map((b) => (b.innerText || '').trim()));
      btn.click();
      return 'clicked row delete control';
    }, NAME);
    await sleep(3000);
    await page.screenshot({ path: path.join(__dirname, 'revoke-step1.png') }).catch(() => {});
    rep.dialog = await page.evaluate(() => (document.body.innerText || '').slice(0, 600).replace(/\s+/g, ' '));

    rep.confirm = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^(delete token|delete|revoke|confirm|yes, delete|remove)$/i.test((x.innerText || '').trim()));
      if (!b) return 'no confirm button found; buttons=' + JSON.stringify([...document.querySelectorAll('button')].map((x) => (x.innerText || '').trim()).filter(Boolean).slice(0, 15));
      b.click(); return 'confirmed via "' + b.innerText.trim() + '"';
    });
    await sleep(5000);
    rep.afterUrl = await page.evaluate(() => location.href);
    rep.escalated = /escalate|Two-Factor|Security Key/i.test(rep.afterUrl + await page.evaluate(() => document.title));
    rep.stillListed = await page.evaluate((n) => (document.body.innerText || '').includes(n), NAME);
    await page.screenshot({ path: path.join(__dirname, 'revoke-after.png') }).catch(() => {});
    console.log(JSON.stringify(rep, null, 2));
  } catch (e) { rep.error = String(e && e.message || e); console.log(JSON.stringify(rep, null, 2)); }
  finally {
    if (page) { try { await page.close(); } catch {} }
    if (browser) { try { await browser.disconnect(); } catch {} }
    mutex.releaseLock(lockId, { port: 9222 });
  }
})();
