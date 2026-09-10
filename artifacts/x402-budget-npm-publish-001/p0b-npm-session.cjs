// P0b: corroborate the signed-out read with npm's OWN auth-gated routes.
const { connect, ownTab, mutex } = require('./chrome-lib.cjs');
const fs = require('fs');
(async () => {
  const lockId = await mutex.acquireLock('x402-budget-npm-publish-001/p0b', { port: 9222 });
  let browser, page; const out = { ts: new Date().toISOString(), probes: [] };
  try {
    browser = await connect();
    page = await ownTab(browser, 'https://www.npmjs.com/');
    await new Promise(r => setTimeout(r, 3000));
    out.context = await page.evaluate(() => {
      const s = [...document.querySelectorAll('script')].map(x => x.textContent || '').find(t => /__context__/.test(t));
      if (!s) return { found: false };
      try {
        const m = s.match(/window\.__context__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
        const j = JSON.parse(m[1]);
        return { found: true, hasUser: !!(j.user), userName: j.user ? j.user.name : null };
      } catch (e) { return { found: true, parseError: String(e.message) }; }
    });
    out.cookieNames = (await page.cookies('https://www.npmjs.com/')).map(c => c.name).sort();
    for (const path of ['/settings', '/login', '/org', '/settings/profile']) {
      const p = await page.evaluate(async (pth) => {
        const r = await fetch('https://www.npmjs.com' + pth, { credentials: 'include', redirect: 'follow' });
        const t = await r.text();
        return { path: pth, status: r.status, finalUrl: r.url, isLoginForm: /name="password"/.test(t), len: t.length };
      }, path);
      out.probes.push(p);
    }
  } catch (e) { out.error = String(e && e.message || e); }
  finally {
    try { if (page) await page.close(); } catch {}
    try { if (browser) browser.disconnect(); } catch {}
    mutex.releaseLock(lockId, { port: 9222 });
  }
  fs.writeFileSync('artifacts/x402-budget-npm-publish-001/p0b-npm-session.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();
