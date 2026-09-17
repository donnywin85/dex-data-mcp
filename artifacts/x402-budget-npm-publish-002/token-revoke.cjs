// Revoke the one-time bootstrap token. Read-only unless --revoke.
const path = require('path');
const PE = 'C:/Users/donny/Documents/passive-empire';
const puppeteer = require(path.join(PE, 'node_modules', 'puppeteer-core'));
const mutex = require(path.join(PE, 'shared', 'chrome-mutex.js'));
const NAME = 'x402-budget-first-publish';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const doRevoke = process.argv.includes('--revoke');
  const lockId = await mutex.acquireLock('x402-budget-npm-publish-002', { port: 9222 });
  let browser, page; const rep = { at: new Date().toISOString(), revoke: doRevoke };
  try {
    browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
    page = await browser.newPage();
    await page.bringToFront();
    await page.goto('https://www.npmjs.com/settings/donnywin85/tokens/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    rep.rows = await page.evaluate((n) => {
      const out = [];
      for (const tr of document.querySelectorAll('tr,li,div')) {
        const t = (tr.innerText || '').trim();
        if (t.includes(n) && t.length < 400) {
          out.push({ text: t.replace(/\s+/g, ' ').slice(0, 200),
            buttons: [...tr.querySelectorAll('button,a')].map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 8) });
        }
      }
      return out.slice(0, 3);
    }, NAME);
    if (doRevoke) {
      const r = await page.evaluate((n) => {
        const rows = [...document.querySelectorAll('tr')].filter((tr) => (tr.innerText || '').includes(n));
        if (!rows.length) return 'no row found';
        const btn = [...rows[0].querySelectorAll('button,a')]
          .find((b) => /delete|revoke|remove/i.test((b.innerText || '') + (b.getAttribute('aria-label') || '')));
        if (!btn) return 'no delete control in row; controls=' + JSON.stringify([...rows[0].querySelectorAll('button,a')].map((b) => (b.innerText || '').trim()));
        btn.click(); return 'clicked ' + (btn.innerText || '').trim();
      }, NAME);
      rep.clickResult = r;
      await sleep(3000);
      await page.screenshot({ path: path.join(__dirname, 'revoke-step1.png') }).catch(() => {});
      // confirmation dialog, if any
      const conf = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /^(delete token|revoke|delete|confirm|yes)$/i.test((x.innerText || '').trim()));
        if (!b) return 'no confirm button';
        b.click(); return 'confirmed via ' + b.innerText.trim();
      });
      rep.confirm = conf;
      await sleep(4000);
      rep.afterUrl = await page.evaluate(() => location.href);
      rep.afterText = await page.evaluate(() => (document.body.innerText || '').slice(0, 400).replace(/\s+/g, ' '));
      await page.screenshot({ path: path.join(__dirname, 'revoke-after.png') }).catch(() => {});
      rep.stillListed = await page.evaluate((n) => (document.body.innerText || '').includes(n), NAME);
    }
    console.log(JSON.stringify(rep, null, 2));
  } catch (e) { rep.error = String(e && e.message || e); console.log(JSON.stringify(rep, null, 2)); }
  finally {
    if (page) { try { await page.close(); } catch {} }
    if (browser) { try { await browser.disconnect(); } catch {} }
    mutex.releaseLock(lockId, { port: 9222 });
  }
})();
