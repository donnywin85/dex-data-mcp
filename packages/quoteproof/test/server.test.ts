// The MCP server and the CLI as a client sees them: a child process over stdio. No test here
// makes a network request: tools/list and argument refusal happen before any read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { quoteHash } from '../src/reader.ts';

const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function session(lines: object[], expect: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, QUOTEPROOF_RPC: 'http://127.0.0.1:9/unreachable' } });
    const out: any[] = [];
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout; got ${out.length}/${expect}`)); }, 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) out.push(JSON.parse(line));
        if (out.length === expect) { clearTimeout(timer); child.kill(); resolve(out); }
      }
    });
    for (const l of lines) child.stdin.write(JSON.stringify(l) + '\n');
  });
}

test('initialize, tools/list, refusal, unknown method; notifications get no reply', async () => {
  const res = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'quote_stock_token', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'nope' },
  ], 4);
  const byId = Object.fromEntries(res.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['1', '2', '3', '4']);
  assert.equal(byId[1].result.serverInfo.name, 'quoteproof');
  assert.deepEqual(byId[2].result.tools.map((t: any) => t.name), ['list_stock_pools', 'quote_stock_token', 'prove_pool_hook', 'nav_context']);
  for (const t of byId[2].result.tools) assert.equal(t.inputSchema.type, 'object');
  assert.equal(byId[3].result.isError, true);
  assert.match(byId[3].result.content[0].text, /needs "ticker"/);
  assert.equal(byId[4].error.code, -32601);
});

test('a tool call against an unreachable RPC is an error result, not a crash or a made-up number', async () => {
  const [r] = await session([{ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'quote_stock_token', arguments: { ticker: 'NVDA' } } }], 1);
  assert.equal(r.result.isError, true);
  assert.doesNotMatch(r.result.content[0].text, /"mid"/);
});

test('CLI: usage exit 2, and `hash` prints keccak256 of the canonical JSON', () => {
  const u = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(u.status, 2);
  assert.match(u.stderr, /usage: quoteproof/);
  const payload = { b: 2, a: { d: 1, c: [3, { f: 1, e: 0 }] } };
  const h = spawnSync(process.execPath, [CLI, 'hash'], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(h.status, 0, h.stderr);
  assert.equal(h.stdout.trim(), quoteHash(payload));
  assert.equal(quoteHash(payload), quoteHash({ a: { c: [3, { e: 0, f: 1 }], d: 1 }, b: 2 }), 'key order does not change the hash');
});
