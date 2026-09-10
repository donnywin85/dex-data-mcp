// P0: is Donny's Chrome signed in to npmjs.com?
// POSITIVE probe only: an auth-gated JSON route answering with an identity.
const { connect, ownTab, mutex } = require('./chrome-lib.cjs');
const fs = require('fs');

(async () => {
  const lockId = await mutex.acquireLock('x402-budget-npm-publish-001/p0', { port: 9222 });
  let browser, page;
  const out = { lockId, ts: new Date().toISOString() };
  try {
    browser = await connect();
    page = await ownTab(browser, 'https://www.npmjs.com/');
    await new Promise(r => setTimeout(r, 4000));

    out.url = page.url();
    out.dom = await page.evaluate(() => {
      const avatar = document.querySelector('a[href^="/~"]');
      const signin = [...document.querySelectorAll('a')].find(a => /^sign in$/i.test((a.innerText||'').trim()));
      return {
        avatarHref: avatar ? avatar.getAttribute('href') : null,
        hasSignInLink: !!signin,
        hasPasswordInput: !!document.querySelector('input[type=password]'),
      };
    });

    // Auth-gated route in the site's own words. Signed out -> 401/redirect to /login.
    out.authGated = await page.evaluate(async () => {
      const r = await fetch('https://www.npmjs.com/settings/profile', {
        credentials: 'include', redirect: 'follow',
      });
      const t = await r.text();
      return {
        status: r.status,
        finalUrl: r.url,
        redirectedToLogin: /\/login/.test(r.url),
        // identity signals only, never a value
        mentionsTwoFactor: /two-factor|2FA/i.test(t),
        hasEmailField: /name="email"/.test(t),
        len: t.length,
      };
    });
    out.verdict = (out.dom.avatarHref && !out.authGated.redirectedToLogin && out.authGated.status === 200)
      ? 'signed-in' : 'signed-out';
    await page.screenshot({ path: 'artifacts/x402-budget-npm-publish-001/p0-npmjs-home.png' });
  } catch (e) {
    out.error = String(e && e.message || e);
    out.verdict = 'UNKNOWN';
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (browser) browser.disconnect(); } catch {}
    mutex.releaseLock(lockId, { port: 9222 });
  }
  fs.writeFileSync('artifacts/x402-budget-npm-publish-001/p0-npm-session.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();
