// Argument validation, driven over real stdio JSON-RPC like a client would.
//
// WHY THIS EXISTS. Every tool publishes inputSchema.required and nothing ever
// checked it. Calling get_token_price with no arguments built
//
//     https://x402.donnyautomation.com/price?symbol=undefined
//
// and then FETCHED it. That spends a free-tier call, and with DEX_WALLET_KEY
// configured it spends real USDC — on a query that cannot return an answer.
//
// The MCP spec expects the CLIENT to validate against the schema. Relying on
// that puts the cost of someone else's bug on us, and a model-driven client
// dropping an argument is the ordinary case rather than the exotic one.
//
// No network: every assertion here is about calls that must NOT be made, so a
// blocked call proves itself by never reaching the gateway. The tools that are
// expected to pass validation are checked by their ERROR TEXT, not by a
// successful fetch, so this suite cannot go red because a free tier is spent
// or an upstream is slow.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!pass) failures += 1;
};

const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
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

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
check('initialize returns server info', init.result?.serverInfo?.name === 'dex-data', JSON.stringify(init.result?.serverInfo));
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const list = await rpc('tools/list', {});
const tools = list.result?.tools || [];
check('every tool has a description and an input schema',
  tools.length > 0 && tools.every((t) => t.description?.length > 10 && t.inputSchema),
  `${tools.length} tools`);

const callText = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return String(r.result?.content?.[0]?.text || '');
};
// The marker the validator prints. Its presence proves the call was stopped
// BEFORE any request — which is the whole point, since a blocked call leaves no
// other evidence.
const BLOCKED = /Nothing was requested and nothing was spent/;
// ★ A NEGATIVE ASSERTION NEEDS A POSITIVE PRECONDITION.
//
//   The "passes validation" cases below assert that a call is NOT blocked. That
//   is also true of a tool that does not exist — an unknown name answers
//   "unknown tool", which is not the blocked marker either. Three such cases
//   (get_slippage twice, get_random once) went on passing after 1.7.0 deleted
//   the tools they named, reporting green about a surface that had gone. So
//   every name used below is first proved to be published. [positive-probe]
const published = new Set(tools.map((t) => t.name));
const mustExist = (name) => {
  const ok = published.has(name);
  if (!ok) check(`${name} is published by tools/list`, false, 'not in tools/list');
  return ok;
};

// ── required arguments are enforced, not merely declared ───────────────────
check('a missing required argument is blocked, not sent as undefined',
  mustExist('get_polygon_token_price') && BLOCKED.test(await callText('get_polygon_token_price', {})));
check('an EMPTY required argument is blocked too',
  mustExist('get_polygon_token_price') && BLOCKED.test(await callText('get_polygon_token_price', { symbol: '' })));
check('a partially-supplied requirement names the missing one',
  mustExist('get_sec_filings') && /"since"/.test(await callText('get_sec_filings', { ticker: 'AAPL' })));

// ── "one of these", which inputSchema.required cannot express (it is an AND) ─
check('lookup_lei with neither q nor lei is blocked',
  mustExist('lookup_lei') && BLOCKED.test(await callText('lookup_lei', {})));
check('lookup_lei with an empty q is blocked',
  mustExist('lookup_lei') && BLOCKED.test(await callText('lookup_lei', { q: '' })));
check('lookup_lei WITH a name passes validation',
  mustExist('lookup_lei') && !BLOCKED.test(await callText('lookup_lei', { q: 'Apple' })));

// An EDGAR route needs BOTH a subject (ticker or cik) and a cursor. Supplying
// the cursor alone is not a cheaper answer, it is a paid 400.
check('get_sec_events with a cursor but no subject is blocked',
  mustExist('get_sec_events') && BLOCKED.test(await callText('get_sec_events', { since: '2026-09-01' })));
check('get_sec_events with cik instead of ticker passes validation',
  mustExist('get_sec_events') && !BLOCKED.test(await callText('get_sec_events', { cik: '1318605', since: '2026-09-01' })));
check('get_company_dossier with none of q/lei/ticker/cik is blocked',
  mustExist('get_company_dossier') && BLOCKED.test(await callText('get_company_dossier', {})));

// ── 1.7.0: `chain` is gone, and a client still sending one is told so ───────
//
// Silently ignoring it would send a Polygon question to a Base route and charge
// for the answer.
check('a leftover chain argument is refused, not ignored',
  mustExist('get_base_liquidity')
  && /takes no "chain" argument/.test(await callText('get_base_liquidity', { pair: 'WETH/USDC', chain: 'polygon' })));
check('refusing a chain argument spends nothing',
  mustExist('get_base_liquidity')
  && BLOCKED.test(await callText('get_base_liquidity', { pair: 'WETH/USDC', chain: 'polygon' })));

// ── tools whose arguments are genuinely optional must not be caught ─────────
// A false positive here would break working calls.
for (const [name, args] of [
  ['find_polygon_arbitrage', {}],
  ['find_avalanche_arbitrage', {}],
  ['get_treasury_yield_curve', {}],
]) {
  check(`${name} with no arguments still passes validation`,
    mustExist(name) && !BLOCKED.test(await callText(name, args)));
}

// ── the local tool answers with no network at all ──────────────────────────
check('get_spend_budget answers locally',
  /"maxSpendUsd"/.test(await callText('get_spend_budget', {})));
check('an unknown tool is rejected', /unknown tool/i.test(await callText('nope_not_a_tool', {})));

// ── the tool list IS the catalogue: 12 route tools + 1 local ───────────────
//
// A floor would not catch this. The claim 1.7.0 makes is that the tool list and
// the listed storefront are the same set, and a tool quietly added back breaks
// that claim exactly as badly as one quietly lost. So assert the count and the
// names. scripts/check-coverage.mjs proves the other half — that these names
// are the ones the gateway lists — but it needs the network and runs only at
// release. This runs on every commit.
const EXPECTED = [
  'find_avalanche_arbitrage', 'find_polygon_arbitrage', 'get_avalanche_pool_reserves',
  'get_base_liquidity', 'get_company_dossier', 'get_polygon_token_price',
  'get_sec_events', 'get_sec_filings', 'get_sec_insiders', 'get_spend_budget',
  'get_treasury_yield_curve', 'get_v4_hook_risk', 'lookup_lei',
];
const actual = [...published].sort();
check('the published tool list is exactly the focused set',
  actual.length === EXPECTED.length && actual.every((n, i) => n === EXPECTED[i]),
  `${actual.length} tools: ${actual.join(', ')}`);

// Every priced tool must name its price, or an agent cannot weigh the cost
// before spending its principal's money.
const unpriced = tools.filter((t) => t.name !== 'get_spend_budget' && !/\$\d+\.\d{2} USDC/.test(t.description));
check('every route tool states its price in USDC', unpriced.length === 0,
  unpriced.map((t) => t.name).join(', ') || 'all 12 priced');

child.kill('SIGTERM');
console.log(failures ? `\n${failures} argument-validation check(s) FAILED` : '\nall argument-validation checks pass');
process.exit(failures ? 1 : 0);
