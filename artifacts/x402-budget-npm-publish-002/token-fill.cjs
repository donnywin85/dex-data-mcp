// Fill the granular-token form and STOP before "Generate token" unless --generate.
// Typed content is a token NAME and description only — never a credential. [no sign-in field]
// The token VALUE, if one is produced, is written straight to a 0600 userconfig outside the
// repo and NEVER printed: stdout gets a sha256/12 fingerprint only. [fingerprints-only]
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const PE = 'C:/Users/donny/Documents/passive-empire';
const puppeteer = require(path.join(PE, 'node_modules', 'puppeteer-core'));
const mutex = require(path.join(PE, 'shared', 'chrome-mutex.js'));

const URL = 'https://www.npmjs.com/settings/donnywin85/tokens/granular-access-tokens/new';
const TOKEN_NAME = 'x402-budget-first-publish';
const NPMRC_OUT = process.env.X402_NPMRC_OUT || 'C:/Users/donny/AppData/Local/Temp/x402-budget-publish.npmrc';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dumpState(page) {
  return page.evaluate(() => {
    const lab = (el) => { if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText.trim(); } const p = el.closest('label'); return p ? p.innerText.trim().slice(0, 100) : null; };
    return {
      inputs: [...document.querySelectorAll('input')].filter((i) => i.type !== 'hidden' && i.type !== 'search')
        .map((i) => ({ type: i.type, name: i.name, id: i.id, label: lab(i), checked: (i.type === 'checkbox' || i.type === 'radio') ? i.checked : undefined, filled: i.type === 'text' ? (i.value ? 'non-empty' : 'empty') : undefined })),
      menus: [...document.querySelectorAll('details > summary')].map((s) => ({ label: s.getAttribute('aria-label'), text: (s.innerText || '').trim().slice(0, 40), controls: s.getAttribute('aria-controls') })),
      summaryText: (() => { const h = [...document.querySelectorAll('h2,h3')].find((e) => /^Summary$/i.test(e.innerText.trim())); return h && h.parentElement ? h.parentElement.innerText.trim().slice(0, 500) : null; })(),
      errors: [...document.querySelectorAll('[role=alert],.error,[aria-invalid=true]')].map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 6),
    };
  });
}

(async () => {
  const doGenerate = process.argv.includes('--generate');
  const lockId = await mutex.acquireLock('x402-budget-npm-publish-002', { port: 9222 });
  let browser, page;
  const rep = { at: new Date().toISOString(), generate: doGenerate, steps: [] };
  try {
    browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    await page.bringToFront();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await sleep(4000);

    // 1. token name — real keystrokes so React's onChange fires
    await page.click('#create-gat_tokenName');
    await page.type('#create-gat_tokenName', TOKEN_NAME, { delay: 25 });
    rep.steps.push('typed token name');

    // 2. bypass 2FA — this is what makes `npm publish` work without an OTP.
    //    (GAT 2FA-bypass for direct publishing is restricted from Jan 2027; this is a
    //     one-time bootstrap, and OIDC takes over for every release after 0.1.0.)
    const b2 = await page.$('#create-gat_bypass2FA');
    if (b2) { await b2.click(); rep.steps.push('checked bypass2FA'); }

    // 3. publish permission
    await page.click('#create-gat_packagesAndScopesPermission_Read-and-write');
    rep.steps.push('selected Read and write (publish and stage)'); await sleep(1200); { const pa = await page.$('#packagesAll'); if (pa) { await pa.click(); rep.steps.push('selected All packages (a name that does not exist yet cannot be in select-packages)'); } else { rep.steps.push('ALL-PACKAGES-RADIO-MISSING'); } }
    await sleep(1500);

    // 4. expiration -> 7 days, via the native <details> menu
    const expSummary = await page.$('summary[aria-controls="expiration-days-menu"]');
    if (expSummary) {
      await expSummary.click();
      await sleep(900);
      rep.expirationOptions = await page.evaluate(() => {
        const m = document.querySelector('#expiration-days-menu');
        return m ? [...m.querySelectorAll('button,a,li,[role=menuitem]')].map((e) => (e.innerText || '').trim()).filter(Boolean) : null;
      });
      const picked = await page.evaluate(() => {
        const m = document.querySelector('#expiration-days-menu');
        if (!m) return null;
        const els = [...m.querySelectorAll('button,a,[role=menuitem]')];
        const seven = els.find((e) => /^7 days$/i.test((e.innerText || '').trim()));
        if (seven) { seven.click(); return '7 days'; }
        return null;
      });
      rep.expirationPicked = picked;
      await sleep(1200);
      if (!picked) { await page.keyboard.press('Escape').catch(() => {}); }
    }

    await sleep(1500);
    rep.state = await dumpState(page);
    await page.screenshot({ path: path.join(__dirname, 'token-form-filled.png') }).catch(() => {});

    if (!doGenerate) {
      rep.note = 'STOPPED before Generate token (dry pass)';
      console.log(JSON.stringify(rep, null, 2));
      return;
    }

    // 5. generate
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === 'Generate token');
      if (!b) return false; b.click(); return true;
    });
    rep.steps.push(clicked ? 'clicked Generate token' : 'Generate token button NOT FOUND');
    await sleep(7000);

    const after = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body.innerText || '').trim().slice(0, 1200),
    }));
    rep.after = after;
    await page.screenshot({ path: path.join(__dirname, 'token-generated.png') }).catch(() => {});

    // Escalation check — if npm asked for a second factor, stop and name the screen.
    if (/escalate|Two-Factor Authentication|Security Key|one-time password/i.test(after.text + after.url)) {
      rep.stop = `npm escalated to a second factor at ${after.url}`;
      console.log(JSON.stringify(rep, null, 2));
      return;
    }

    // 6. harvest the value WITHOUT printing it
    const tok = await page.evaluate(() => {
      const rx = /\bnpm_[A-Za-z0-9]{36,}\b/;
      const m = (document.body.innerText || '').match(rx);
      if (m) return m[0];
      for (const i of document.querySelectorAll('input,textarea,code,pre')) {
        const v = i.value || i.innerText || '';
        const mm = String(v).match(rx);
        if (mm) return mm[0];
      }
      return null;
    });
    if (!tok) { rep.stop = 'no npm_ value found on the page after generate'; console.log(JSON.stringify(rep, null, 2)); return; }

    fs.writeFileSync(NPMRC_OUT, `//registry.npmjs.org/:_authToken=${tok}\n`, { mode: 0o600 });
    rep.tokenFingerprint = crypto.createHash('sha256').update(tok).digest('hex').slice(0, 12);
    rep.tokenLength = tok.length;
    rep.npmrcWritten = NPMRC_OUT;
    rep.valuePrinted = 0;
    console.log(JSON.stringify(rep, null, 2));
  } catch (e) {
    rep.error = String((e && e.message) || e);
    console.log(JSON.stringify(rep, null, 2));
    process.exitCode = 3;
  } finally {
    if (page) { try { await page.close(); } catch {} }
    if (browser) { try { await browser.disconnect(); } catch {} }
    mutex.releaseLock(lockId, { port: 9222 });
  }
})();
