// ONE live read against the public Robinhood Chain RPC. SKIPPED — reported as skipped, never as a
// pass — when the RPC cannot be reached, so an offline run cannot turn this into a green lie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { callTool } from '../src/tools.ts';
import { DEFAULT_RPC, USER_AGENT, httpTransport } from '../src/rpc.ts';

async function reachable(): Promise<string | null> {
  try {
    const r = await fetch(process.env.QUOTEPROOF_RPC ?? DEFAULT_RPC, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(8000),
    });
    const j = (await r.json()) as { result?: string };
    return j.result === '0x1237' ? null : `eth_chainId returned ${JSON.stringify(j).slice(0, 80)}`;
  } catch (e) {
    return `unreachable: ${(e as Error).message}`;
  }
}

const why = await reachable();

test('live: NVDA quote at the current block', { skip: why ?? false }, async () => {
  const rec = JSON.parse(fs.readFileSync(new URL('./fixtures/live-recording.json', import.meta.url), 'utf8'));
  const recorded = rec.cases.find((c: any) => c.tool === 'quote_stock_token' && c.args.ticker === 'NVDA').output;
  const o = (await callTool({ rpc: httpTransport() }, 'quote_stock_token', { ticker: 'NVDA' })) as any;
  assert.ok(o.block.number >= recorded.block.number, 'chain head is not behind the recording');
  assert.equal(o.fee_tier_ppm, 500);
  const mid = Number(o.price.mid);
  // Wrong-pool guard, not a price expectation: a different ticker's pool is off by a multiple.
  assert.ok(mid > Number(recorded.price.mid) * 0.5 && mid < Number(recorded.price.mid) * 2, `mid ${mid}`);
  assert.ok(Number(o.price.buy_after_fee) > mid && Number(o.price.sell_after_fee) < mid);
  console.log(`    live NVDA block=${o.block.number} mid=${o.price.mid} buy=${o.price.buy_after_fee} sell=${o.price.sell_after_fee}`);
});
