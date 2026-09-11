// Revoke x402-budget-first-publish, with a dialog handler installed BEFORE the click.
// The previous attempt hung because npm's delete uses a native confirm(), which blocks
// every page.evaluate until something answers it. [silent-failure]
const path = require('path');
const PE = 'C:/Users/donny/Documents/passive-empire';
const puppeteer = require(path.join(PE, 'node_modules', 'puppeteer-core'));
const mutex = require(path.join(PE, 'shared', 'chrome-mutex.js'));
const NAME = 'x402-budget-first-publish';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const lockId = await mutex.acquireLock('x402-budget-npm-publish-002', { port: 9222 });
  let browser, page; const rep = { at: new Date().toISOString(), dialogs: [] };
  try {
    browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });

    // 1. close the orphan tab the killed run left behind (mine: it is the tokens page)
    for (const p of await browser.pages()) {
      let u = ''; try { u = p.url(); } catch {}
      if (u.includes('/settings/donnywin85/tokens')) { try { await p.close(); rep.closedOrphan = u; } catch (e) { rep.closedOrphan = 'close failed: ' + e.message; } }
    }
    await sleep(1500);

    page = await browser.newPage();
    page.on('dialog', async (d) => {
      rep.dialogs.push({ type: d.type(), message: d.message().slice(0, 200) });
      try { await d.accept(); } catch {}
    });
    await page.bringToFront();
    await page.goto('https://www.npmjs.com/settings/donnywin85/tokens/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4500);

    rep.listedBefore = await page.evaluate((n) => (document.body.innerText || '').includes(n), NAME);
    if (!rep.listedBefore) {
      rep.result = 'token already absent from the list — nothing to revoke';
      console.log(JSON.stringify(rep, null, 2)); return;
    }

    rep.click = await page.evaluate((n) => {
      const rows = [...document.querySelectorAll('tr')].filter((tr) => (tr.innerText || '').includes(n));
      if (!rows.length) return 'NO ROW';
      const row = rows[rows.length - 1];
      const btn = [...row.querySelectorAll('button')].find((b) => {
        const t = (b.innerText || '').trim(); const al = b.getAttribute('aria-label') || '';
        return t === '\u00d7' || /delete|revoke|remove/i.test(t + ' ' + al);
      });
      if (!btn) return 'no delete control';
      btn.click(); return 'clicked row delete control';
    }, NAME);

    await sleep(6000);
    await page.screenshot({ path: path.join(__dirname, 'revoke-step1.png') }).catch(() => {});
    rep.midText = await page.evaluate(() => (document.body.innerText || '').slice(0, 500).replace(/\s+/g, ' '));

    // an in-page confirm modal, if npm used one instead of a native dialog
    rep.confirm = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^(delete token|delete|revoke|confirm|yes, delete|remove)$/i.test((x.innerText || '').trim()));
      if (!b) return 'no in-page confirm button';
      b.click(); return 'confirmed via "' + b.innerText.trim() + '"';
    });
    await sleep(6000);

    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(4000);
    rep.afterUrl = page.url();
    rep.title = await page.title();
    rep.escalated = /Security Key|Two-Factor|escalate/i.test(rep.afterUrl + ' ' + rep.title);
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
