// Records live RPC and HTTP traffic for a fixed set of tool calls into test/fixtures/, so the
// fixture tests replay REAL chain responses. Read-only; no key. Each case is recorded with its
// own call log because every tool call pins its own block (eth_blockNumber is not idempotent).
//
//   node scripts/record-fixtures.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callTool } from '../src/tools.ts';
import { httpGetJson, httpTransport, recordingGet, recordingTransport, type RecordedCall, type RecordedGet } from '../src/rpc.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'list_stock_pools', args: {} },
  { tool: 'quote_stock_token', args: { ticker: 'NVDA' } },
  { tool: 'quote_stock_token', args: { ticker: 'AAPL' } },
  { tool: 'quote_stock_token', args: { ticker: 'QQQ' } },
  { tool: 'prove_pool_hook', args: { ticker: 'AAPL' } },
  { tool: 'prove_pool_hook', args: { ticker: 'NVDA' } },
  { tool: 'nav_context', args: { ticker: 'NVDA' } },
  { tool: 'nav_context', args: { ticker: 'SPY' } },
];

const rpc = httpTransport();
const get = httpGetJson();
const recorded = [];
for (const c of CASES) {
  const calls: RecordedCall[] = [];
  const gets: RecordedGet[] = [];
  const now = Date.now();
  const output = await callTool({ rpc: recordingTransport(rpc, calls), get: recordingGet(get, gets), now: () => now }, c.tool, c.args);
  recorded.push({ ...c, now, calls, gets, output });
  console.log(`${c.tool} ${JSON.stringify(c.args)}: ${calls.length} rpc calls, ${gets.length} http gets`);
}
const out = { recordedAt: new Date().toISOString(), rpc: 'https://rpc.mainnet.chain.robinhood.com', cases: recorded };
const file = path.join(HERE, '..', 'test', 'fixtures', 'live-recording.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)`);
