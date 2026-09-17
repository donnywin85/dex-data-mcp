// Read-only: enumerate the granular-token form's controls so the filler is exact.
// Prints control types/names/labels/options only — never a value.
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
    await new Promise((r) => setTimeout(r, 4000));
    const out = await page.evaluate(() => {
      const lab = (el) => {
        if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText.trim(); }
        const p = el.closest('label'); return p ? p.innerText.trim().slice(0, 120) : null;
      };
      return {
        inputs: [...document.querySelectorAll('input')].map((i) => ({
          type: i.type, name: i.name || null, id: i.id || null, label: lab(i),
          checked: i.type === 'checkbox' || i.type === 'radio' ? i.checked : undefined,
        })),
        selects: [...document.querySelectorAll('select')].map((s) => ({
          name: s.name || null, id: s.id || null, label: lab(s),
          options: [...s.options].map((o) => ({ value: o.value, text: o.text.trim() })),
          selected: s.value,
        })),
        textareas: [...document.querySelectorAll('textarea')].map((t) => ({ name: t.name || null, id: t.id || null, label: lab(t) })),
        buttons: [...document.querySelectorAll('button')].map((b) => ({ text: (b.innerText || '').trim(), type: b.getAttribute('type') })).filter((b) => b.text),
      };
    });
    console.log(JSON.stringify(out, null, 2));
  } catch (e) { console.log(JSON.stringify({ error: String(e && e.message || e) })); }
  finally {
    if (page) { try { await page.close(); } catch {} }
    if (browser) { try { await browser.disconnect(); } catch {} }
    mutex.releaseLock(lockId, { port: 9222 });
  }
})();
