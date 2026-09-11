// Drive the npm CLI web-login approval page inside the :9222 Chrome.
//
// FENCE (brief): nothing is ever TYPED into a sign-in or one-time-code field. This script
// has no keyboard path at all — it can navigate, read and click an allowlisted confirm
// button, nothing else. If the page carries a password or OTP input it REFUSES and reports
// the screen name, per the brief's STOP condition.
//
// Usage: node npm-login-drive.cjs <url> [--click] [--tag <label>]
// Prints JSON. Never prints a cookie, token or field value — only field TYPES and names.

const path = require('path');
const fs = require('fs');

const PE = 'C:/Users/donny/Documents/passive-empire';
const puppeteer = require(path.join(PE, 'node_modules', 'puppeteer-core'));
const mutex = require(path.join(PE, 'shared', 'chrome-mutex.js'));

const ART = __dirname;
const CHROME_URL = 'http://127.0.0.1:9222';

// Buttons we are willing to press: pure consent affordances on an already-authenticated
// session. Anything else is reported, not clicked.
const CONFIRM_RE = /^(sign in|continue|confirm|authorize|authorise|approve|yes|allow|log ?in to cli|connect)$/i;

async function readScreen(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    // Field TYPES and names only. No values, ever. [fingerprints-only]
    const inputs = [...document.querySelectorAll('input')].filter(vis).map((i) => ({
      type: (i.type || '').toLowerCase(),
      name: i.name || null,
      id: i.id || null,
      autocomplete: i.getAttribute('autocomplete') || null,
      placeholder: i.getAttribute('placeholder') || null,
    }));
    const buttons = [...document.querySelectorAll('button, input[type=submit], a[role=button]')]
      .filter(vis)
      .map((b) => ({
        text: ((b.innerText || b.value || '').trim()).slice(0, 80),
        tag: b.tagName.toLowerCase(),
        type: (b.getAttribute('type') || '').toLowerCase() || null,
      }))
      .filter((b) => b.text);
    return {
      url: location.href,
      title: document.title,
      text: (document.body.innerText || '').trim().replace(/\n{3,}/g, '\n\n').slice(0, 2500),
      inputs,
      buttons,
      avatar: document.querySelector('a[href^="/~"]') ? document.querySelector('a[href^="/~"]').getAttribute('href') : null,
    };
  });
}

// A screen is UNSAFE to touch if it wants a credential or a code from a keyboard.
function credentialScreen(screen) {
  const hits = [];
  for (const i of screen.inputs) {
    if (i.type === 'password') hits.push(`password input (name=${i.name})`);
    const hay = `${i.name || ''} ${i.id || ''} ${i.autocomplete || ''} ${i.placeholder || ''}`.toLowerCase();
    if (/otp|one.?time|2fa|two.?factor|totp|auth.?code|security code|verification/.test(hay)) {
      hits.push(`one-time-code input (name=${i.name || i.id})`);
    }
  }
  if (/one-time password|one time password|two-factor|authenticator app|enter the code|verification code/i.test(screen.text)) {
    hits.push('page text asks for a one-time code');
  }
  return hits;
}

(async () => {
  const args = process.argv.slice(2);
  const url = args[0];
  const doClick = args.includes('--click');
  const tagIdx = args.indexOf('--tag');
  const tag = tagIdx >= 0 ? args[tagIdx + 1] : 'screen';
  if (!url || !/^https:\/\/(www\.)?npmjs\.com\//.test(url)) {
    console.log(JSON.stringify({ ok: false, why: 'refusing: url must be an https npmjs.com url' }));
    process.exit(2);
  }

  const lockId = await mutex.acquireLock('x402-budget-npm-publish-002', { port: 9222 });
  let browser, page;
  const report = { at: new Date().toISOString(), requested: url, clicked: null, stop: null };
  try {
    browser = await puppeteer.connect({ browserURL: CHROME_URL, defaultViewport: null });
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    await page.bringToFront();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3500));

    let screen = await readScreen(page);
    await page.screenshot({ path: path.join(ART, `${tag}-before.png`), fullPage: false }).catch(() => {});
    report.before = screen;

    const unsafe = credentialScreen(screen);
    if (unsafe.length) {
      // STOP condition from the brief: name the screen, type nothing.
      report.stop = `credential screen — ${unsafe.join('; ')}`;
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (doClick) {
      const target = screen.buttons.find((b) => CONFIRM_RE.test(b.text));
      if (!target) {
        report.clicked = false;
        report.stop = `no allowlisted confirm button on screen; buttons = ${JSON.stringify(screen.buttons.map((b) => b.text))}`;
      } else {
        const done = await page.evaluate((wanted) => {
          const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const els = [...document.querySelectorAll('button, input[type=submit], a[role=button]')].filter(vis);
          const el = els.find((b) => ((b.innerText || b.value || '').trim()) === wanted);
          if (!el) return false;
          el.click();
          return true;
        }, target.text);
        report.clicked = done ? target.text : false;
        await new Promise((r) => setTimeout(r, 5000));
        screen = await readScreen(page);
        await page.screenshot({ path: path.join(ART, `${tag}-after.png`), fullPage: false }).catch(() => {});
        report.after = screen;
        const unsafe2 = credentialScreen(screen);
        if (unsafe2.length) report.stop = `credential screen AFTER click — ${unsafe2.join('; ')}`;
      }
    }
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    report.error = String((e && e.message) || e);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 3;
  } finally {
    if (page) { try { await page.close(); } catch {} }
    if (browser) { try { await browser.disconnect(); } catch {} }
    // arg order: releaseLock(lockId, {port}) — port-first silently no-ops.
    mutex.releaseLock(lockId, { port: 9222 });
  }
})();
