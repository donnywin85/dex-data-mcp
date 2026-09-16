// spend-cap.test.mjs — the per-call ceiling refuses the NEW price points, and
// refuses them through the real tool path, over stdio, against the recorded 402.
//
// WHY A THIRD SUITE RATHER THAN MORE CASES IN budget.test.mjs. That suite calls
// fetchMaybePaid directly and proves the accounting. It cannot see a tool, a
// route or a price, so it could not notice that 1.7.0 moved the catalogue's top
// price from $0.01 to $0.05 — which is exactly the default DEX_MAX_PRICE_USD
// ceiling, meaning the four dearest tools now sit ON the limit rather than well
// under it. A user who tightens the ceiling by one cent loses a third of the
// catalogue, and the refusal must say so in a way they can act on.
//
// NO FUNDS CAN MOVE HERE, and it does not rest on remembering to check:
//   - DEX_WALLET_KEY is a visibly fake literal, not a key.
//   - The per-call ceiling is enforced BEFORE getPayFetch() is ever called, so
//     the payment libraries are never loaded on the refusal paths.
//   - The optional @x402/* packages are not installed in this checkout, so the
//     one path that does reach getPayFetch throws "payment unavailable".
//   - The replay server is loopback and asserts that no request ever arrived
//     carrying a payment signature.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/challenge-402.json'), 'utf8'));

let failures = 0;
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!pass) failures += 1;
};

const seen = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  seen.push({ path: url.pathname, headers: req.headers });
  const rec = fixture.routes[url.pathname];
  if (!rec) { res.writeHead(404); res.end('{}'); return; }
  res.writeHead(rec.status, rec.headers);
  res.end(rec.body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// A cheap tool ($0.01), a mid tool ($0.03) and a dear tool ($0.05).
const CHEAP = ['get_base_liquidity', { pair: 'WETH/USDC' }];
const MID = ['lookup_lei', { q: 'Apple Inc.' }];
const DEAR = ['get_sec_filings', { ticker: 'AAPL', since: '2026-09-01' }];

async function withEnv(extra, fn) {
  const env = {
    ...process.env,
    X402_BASE: BASE,
    // Not a key. It never signs anything: every assertion below is about a
    // refusal that happens before the signer is constructed, and the payment
    // packages are optionalDependencies that this checkout does not install.
    DEX_WALLET_KEY: 'not-a-real-key-this-test-never-signs',
    ...extra,
  };
  delete env.EVM_PRIVATE_KEY;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env });
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* not ours */ }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 30000);
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const callText = async (name, args) => String(
    (await rpc('tools/call', { name, arguments: args })).result?.content?.[0]?.text || '',
  );
  try { await fn(callText); } finally { child.kill('SIGTERM'); }
}

// ── 1. a ceiling under every price refuses every tool ──────────────────────
console.log('\nDEX_MAX_PRICE_USD=0.005 — under the cheapest route:');
await withEnv({ DEX_MAX_PRICE_USD: '0.005' }, async (call) => {
  for (const [name, args, price] of [[...CHEAP, '0.01'], [...MID, '0.03'], [...DEAR, '0.05']]) {
    const text = await call(name, args);
    check(`${name} ($${price}) is refused by the per-call ceiling`, /exceeds DEX_MAX_PRICE_USD/.test(text), text.split('\n').find((l) => /exceeds|unavailable|wallet/.test(l)) || text.slice(0, 90));
    check(`${name} names the cap the user must raise`, /DEX_MAX_PRICE_USD/.test(text));
    check(`${name} still reports the price it refused`, text.includes(`$${price}`), '');
  }
});

// ── 2. the ceiling DISCRIMINATES; it does not just refuse everything ───────
//
// A cap that refuses every call would pass part 1 while being useless. At
// $0.02 the $0.01 tool must get PAST the ceiling — and then stop at the missing
// payment libraries, which is a different refusal with different text.
console.log('\nDEX_MAX_PRICE_USD=0.02 — above the cheap route, below the rest:');
await withEnv({ DEX_MAX_PRICE_USD: '0.02' }, async (call) => {
  const cheap = await call(...CHEAP);
  check('the $0.01 tool passes the ceiling', !/exceeds DEX_MAX_PRICE_USD/.test(cheap),
    cheap.split('\n').find((l) => /not paid|unavailable/.test(l)) || cheap.slice(0, 90));
  for (const [name, args, price] of [[...MID, '0.03'], [...DEAR, '0.05']]) {
    const text = await call(name, args);
    check(`the $${price} tool is still refused`, /exceeds DEX_MAX_PRICE_USD/.test(text));
  }
});

// ── 3. the DEFAULT ceiling admits the whole catalogue, $0.05 included ──────
//
// $0.05 is the default DEX_MAX_PRICE_USD exactly. `>` not `>=` is what makes the
// dearest four tools usable out of the box, and that is a one-character property
// worth pinning: flipping it would silently retire /company and all three EDGAR
// routes for every user who never sets the variable.
console.log('\nno DEX_MAX_PRICE_USD — the shipped default of $0.05:');
await withEnv({}, async (call) => {
  const text = await call(...DEAR);
  check('the $0.05 tool is NOT refused by the default ceiling', !/exceeds DEX_MAX_PRICE_USD/.test(text),
    text.split('\n').find((l) => /not paid|unavailable/.test(l)) || text.slice(0, 90));
});

// ── 4. nothing was ever paid ───────────────────────────────────────────────
check('no request carried a payment signature', !seen.some((r) => r.headers['payment-signature']),
  `${seen.length} request(s) inspected`);
check('no request carried an MPP authorization', !seen.some((r) => /^Payment\b/i.test(String(r.headers.authorization || ''))));

server.close();
console.log(failures ? `\n${failures} spend-cap check(s) FAILED` : '\nall spend-cap checks pass');
process.exit(failures ? 1 : 0);
