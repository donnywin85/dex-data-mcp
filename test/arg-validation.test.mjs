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

check('a missing required argument is blocked, not sent as undefined',
  BLOCKED.test(await callText('get_token_price', {})));
check('an EMPTY required argument is blocked too',
  BLOCKED.test(await callText('get_token_price', { token: '' })));
check('a partially-supplied requirement names the missing one',
  /"lon"/.test(await callText('get_weather', { lat: 40.7 })));

// "one of these" is not expressible with inputSchema.required, which is an AND.
check('lookup_lei with neither q nor lei is blocked',
  BLOCKED.test(await callText('lookup_lei', {})));
check('lookup_lei with an empty q is blocked',
  BLOCKED.test(await callText('lookup_lei', { q: '' })));
check('lookup_lei WITH a name passes validation',
  !BLOCKED.test(await callText('lookup_lei', { q: 'Apple' })));

// Tools whose arguments are genuinely optional must not be caught by any of the
// above — a false positive here would break working calls.
for (const [name, args] of [['get_random', {}], ['find_arbitrage', {}], ['get_gas', {}], ['get_treasury_yield_curve', {}]]) {
  check(`${name} with no arguments still passes validation`, !BLOCKED.test(await callText(name, args)));
}

// Local tools answer without any network at all.
check('list_chains answers locally', /"chains"/.test(await callText('list_chains', {})));
check('an unknown tool is rejected', /unknown tool/i.test(await callText('nope_not_a_tool', {})));

child.kill('SIGTERM');
console.log(failures ? `\n${failures} argument-validation check(s) FAILED` : '\nall argument-validation checks pass');
process.exit(failures ? 1 : 0);
