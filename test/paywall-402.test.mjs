// paywall-402.test.mjs — one case per route tool, driven over real stdio
// JSON-RPC against a RECORDED 402 challenge. No live payment, no funds, no
// network beyond loopback.
//
// WHY A REPLAY SERVER RATHER THAN A STUBBED fetch(). The thing most likely to
// break in this release is the URL a tool builds: 1.7.0 replaced a `chain`
// argument and a path prefix assembled in the handler with twelve tools that
// each write their own whole path. A stubbed fetch proves the refusal logic and
// says nothing about whether `get_sec_insiders` asks for /edgar/insiders or for
// /insiders. So the server is pointed at a loopback replay of the real gateway's
// challenge, and every case asserts the PATH AND QUERY that actually arrived.
//
// The fixture in test/fixtures/challenge-402.json is a verbatim recording from
// the live gateway: the base64 `payment-required` header, the body and the
// status, for each of the twelve listed routes. It was captured with bare-path
// GETs, which the gateway answers with a challenge rather than a free-tier call.
// Re-record it if the gateway's prices change — and if they do, THIS suite is
// where you find out, because each case asserts the price its tool's own
// description promises. A description that drifts from the challenge is a
// quoted price the buyer does not get. [derive-or-delete]
//
// WHAT THIS SUITE DOES NOT DO: pay. There is no wallet in the environment, so
// fetchMaybePaid stops at "no wallet configured" and the replay server records
// zero requests carrying a payment. That is asserted, not assumed.

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

// name, arguments, the path the tool must request, a query fragment that must be
// present, and the price its description promises.
const CASES = [
  ['get_base_liquidity', { pair: 'WETH/USDC' }, '/base/liquidity', 'pair=WETH%2FUSDC', '0.01'],
  ['get_polygon_token_price', { symbol: 'WMATIC' }, '/polygon/price', 'symbol=WMATIC', '0.01'],
  ['get_avalanche_pool_reserves', { pair: 'WAVAX/USDC' }, '/avalanche/reserves', 'pair=WAVAX%2FUSDC', '0.01'],
  ['find_polygon_arbitrage', { minSpreadBps: 25 }, '/polygon/scan', 'minSpreadBps=25', '0.01'],
  ['find_avalanche_arbitrage', {}, '/avalanche/scan', 'minSpreadBps=10', '0.01'],
  ['get_v4_hook_risk', { address: '0x0000000000000000000000000000000000000080' }, '/v4hooks', 'address=0x0000000000000000000000000000000000000080', '0.01'],
  // %20 rather than '+': lookup_lei keeps its own encodeURIComponent route
  // template from 1.6.x, where the other multi-argument tools build their query
  // with URLSearchParams. Both are valid and the gateway decodes both; the
  // expectation is written to the code that actually runs, not to the shape the
  // neighbouring tools happen to use.
  ['lookup_lei', { q: 'Apple Inc.' }, '/lei', 'q=Apple%20Inc.', '0.03'],
  ['get_company_dossier', { ticker: 'AAPL' }, '/company', 'ticker=AAPL', '0.05'],
  ['get_treasury_yield_curve', {}, '/treasury', 'latest=1', '0.03'],
  ['get_sec_filings', { ticker: 'AAPL', since: '2026-09-01', forms: '8-K' }, '/edgar/filings', 'forms=8-K', '0.05'],
  ['get_sec_events', { ticker: 'TSLA', since: '2026-09-01', items: '5.02' }, '/edgar/events', 'items=5.02', '0.05'],
  ['get_sec_insiders', { ticker: 'NVDA', since: '2026-09-01', forms: '4' }, '/edgar/insiders', 'forms=4', '0.05'],
];

// ── the replay server ──────────────────────────────────────────────────────
const seen = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  seen.push({ path: url.pathname, query: url.search, headers: req.headers });
  const rec = fixture.routes[url.pathname];
  if (!rec) {
    // A tool asking for an unrecorded path is the failure this suite exists to
    // catch, so answer something that can never be mistaken for a challenge.
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no fixture for this path', path: url.pathname }));
    return;
  }
  res.writeHead(rec.status, rec.headers);
  res.end(rec.body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── the server under test, with NO wallet in the environment ───────────────
const env = { ...process.env, X402_BASE: BASE };
delete env.DEX_WALLET_KEY;
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
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const listed = (await rpc('tools/list', {})).result?.tools || [];
const listedNames = new Set(listed.map((t) => t.name));

console.log(`replaying ${Object.keys(fixture.routes).length} recorded challenges, captured ${fixture._recorded}\n`);

for (const [name, args, wantPath, wantQuery, wantPrice] of CASES) {
  // ★ Assert the tool EXISTS before asserting anything about its behaviour. The
  //   suite this replaces checked "does not say blocked" for three tools that
  //   had been deleted, and passed — an unknown tool says "unknown tool", which
  //   is also not the blocked marker. A negative assertion about a name nobody
  //   publishes is true for the wrong reason. [positive-probe]
  if (!listedNames.has(name)) { check(`${name} is published by tools/list`, false, 'not in tools/list'); continue; }

  const before = seen.length;
  const r = await rpc('tools/call', { name, arguments: args });
  const text = String(r.result?.content?.[0]?.text || '');
  const reqs = seen.slice(before);

  check(`${name} requests exactly one URL`, reqs.length === 1, `${reqs.length} request(s)`);
  const req = reqs[0] || { path: '(none)', query: '', headers: {} };

  check(`${name} -> ${wantPath}`, req.path === wantPath, req.path);
  check(`${name} sends ${wantQuery}`, req.query.includes(wantQuery), req.query);

  // Attribution must survive the version bump: the gateway buckets this call as
  // `src: npm-client` from the header, and falls back to the user-agent, which
  // its CLIENT_PATTERNS matches as /^dex-data-mcp\//i.
  check(`${name} tags the call x-402-source: npm-client`, req.headers['x-402-source'] === 'npm-client', req.headers['x-402-source']);
  check(`${name} sends a dex-data-mcp/<version> user-agent`, /^dex-data-mcp\/\d+\.\d+\.\d+/.test(String(req.headers['user-agent'])), req.headers['user-agent']);

  // The 402 is surfaced as an explained paywall, not a bare HTTP error, and it
  // quotes the price this tool's own description promises.
  check(`${name} reports the 402 as a paywall`, r.result?.isError === true && /needs payment/.test(text));
  check(`${name} quotes $${wantPrice}`, text.includes(`$${wantPrice} USDC`), text.split('\n')[0]);
  check(`${name} says no wallet is configured`, /no wallet/i.test(text) || /wallet/i.test(text));
  check(`${name} paid nothing`, !/paid/i.test(text.split('\n')[0]) && !req.headers['payment-signature']);
}

// ── whole-run invariants ───────────────────────────────────────────────────
check('no request carried a payment signature', !seen.some((r) => r.headers['payment-signature']),
  `${seen.length} request(s) inspected`);
check('every request went to loopback only', seen.length === CASES.length, `${seen.length} request(s)`);

const budgetText = String((await rpc('tools/call', { name: 'get_spend_budget', arguments: {} })).result?.content?.[0]?.text || '');
let budget = {};
try { budget = JSON.parse(budgetText); } catch { /* reported below */ }
check('the budget reports zero spent after twelve 402s', budget.spentUsd === '0.0000' || Number(budget.spentUsd) === 0, budgetText.replace(/\s+/g, ' '));
check('the budget reports zero paid calls', budget.calls === 0, String(budget.calls));

child.kill('SIGTERM');
server.close();
console.log(failures ? `\n${failures} paywall check(s) FAILED` : '\nall paywall checks pass');
process.exit(failures ? 1 : 0);
