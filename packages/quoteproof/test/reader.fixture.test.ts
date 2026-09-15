// The reader replayed against REAL chain responses recorded by scripts/record-fixtures.ts.
// Replay is strict: a request the recording does not contain throws, so nothing here can quietly
// reach the network. Beyond "output equals the recorded output", each case re-derives its headline
// numbers from the RAW recorded RPC words with arithmetic that does not use src/math.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { callTool } from '../src/tools.ts';
import { replayGet, replayTransport, type RecordedCall, type RecordedGet, type Transport } from '../src/rpc.ts';
import { SEL, TOPIC_V4_INITIALIZE } from '../src/abi.ts';

interface Case { tool: string; args: Record<string, unknown>; now: number; calls: RecordedCall[]; gets: RecordedGet[]; output: any }
const REC = JSON.parse(fs.readFileSync(new URL('./fixtures/live-recording.json', import.meta.url), 'utf8')) as { recordedAt: string; cases: Case[] };
const find = (tool: string, ticker?: string) => {
  const c = REC.cases.find((x) => x.tool === tool && x.args.ticker === ticker);
  if (!c) throw new Error(`no recorded case ${tool} ${ticker}`);
  return c;
};
const run = (c: Case, rpc: Transport = replayTransport(c.calls)) => callTool({ rpc, get: replayGet(c.gets), now: () => c.now }, c.tool, c.args);
const rawCall = (c: Case, to: string, data: string) => {
  const hit = c.calls.find((x) => x.method === 'eth_call' && (x.params[0] as any).to.toLowerCase() === to.toLowerCase() && (x.params[0] as any).data === data);
  if (!hit) throw new Error(`no recorded eth_call ${data} on ${to}`);
  return hit.result as string;
};

for (const c of REC.cases) {
  test(`replay ${c.tool} ${JSON.stringify(c.args)} reproduces the recorded output exactly`, async () => {
    assert.deepEqual(await run(c), c.output);
  });
}

test('every output carries block number, timestamp, source pool and fee tier', () => {
  const rows = REC.cases.flatMap((c) => (c.tool === 'list_stock_pools' ? c.output.pools : [c.output]));
  for (const o of rows) {
    assert.ok(Number.isInteger(o.block.number) && o.block.number > 63_000_000, 'block number');
    assert.match(o.block.timestamp, /^2026-\d\d-\d\dT/);
    assert.equal(o.block.pinned, true);
    assert.ok(o.source.pool || (o.source.pool_manager && o.source.pool_id), 'source pool');
    assert.ok(Number.isInteger(o.fee_tier_ppm) && o.fee_tier_ppm > 0, `fee tier for ${o.ticker}`);
  }
});

test('every call inside one tool invocation uses the same explicit block tag', () => {
  for (const c of REC.cases) {
    const tags = new Set(c.calls.filter((x) => x.method === 'eth_call').map((x) => x.params[1]));
    assert.equal(tags.size, 1, `${c.tool} ${c.args.ticker}: ${[...tags].join(',')}`);
    assert.ok(![...tags].includes('latest'));
  }
});

test('list_stock_pools: all nine pools readable, fee tiers read from the chain', () => {
  const o = find('list_stock_pools').output;
  assert.equal(o.readable, 9);
  const fees = Object.fromEntries(o.pools.map((p: any) => [p.ticker, p.fee_tier_ppm]));
  assert.equal(fees.NVDA, 500, 'NVDA v3 is the 5 bps pool (playbook lesson 5)');
  assert.equal(fees.AAPL, 3000);
  assert.equal(fees.QQQ, 500);
});

test('NVDA quote: mid and fee re-derived from the raw slot0 and fee() words', async () => {
  const c = find('quote_stock_token', 'NVDA');
  const pool = c.output.source.pool;
  const sqrt = BigInt('0x' + rawCall(c, pool, SEL.slot0).slice(2, 66));
  const fee = Number(BigInt(rawCall(c, pool, SEL.fee)));
  // Independent float arithmetic: NVDA is token1 (18 dec), USDG token0 (6 dec).
  const mid = 1 / (((Number(sqrt) / 2 ** 96) ** 2) * 1e-12);
  assert.equal(fee, 500);
  assert.equal(c.output.fee.buy_ppm, 500);
  assert.ok(Math.abs(Number(c.output.price.mid) / mid - 1) < 1e-12, `mid ${c.output.price.mid} vs ${mid}`);
  assert.ok(Math.abs(Number(c.output.price.buy_after_fee) / (mid / (1 - fee / 1e6)) - 1) < 1e-12);
  assert.ok(Math.abs(Number(c.output.price.sell_after_fee) / (mid * (1 - fee / 1e6)) - 1) < 1e-12);
  // Depth sanity: the buyer's average price including fee sits between buy_after_fee and +50 bps + fee.
  const avg = Number(c.output.depth.buy_side.average_price_with_fee);
  assert.ok(avg > Number(c.output.price.buy_after_fee) && avg < mid * 1.005 / (1 - fee / 1e6));
});

test('AAPL quote: the protocol fee is charged on top of the 3000 ppm LP fee', () => {
  const o = find('quote_stock_token', 'AAPL').output;
  assert.equal(o.fee.lp_fee_ppm, 3000);
  assert.equal(o.fee.buy_ppm, 3000 + o.fee.protocol_fee_ppm.zeroForOne - Math.floor((o.fee.protocol_fee_ppm.zeroForOne * 3000) / 1e6));
  assert.ok(o.fee.buy_ppm >= 3000);
});

test('AAPL hook proof: hook address decoded from the raw Initialize log is the zero address', () => {
  const c = find('prove_pool_hook', 'AAPL');
  const logCall = c.calls.find((x) => x.method === 'eth_getLogs')!;
  assert.deepEqual((logCall.params[0] as any).topics, [TOPIC_V4_INITIALIZE, c.output.source.pool_id]);
  assert.equal((logCall.params[0] as any).fromBlock, '0x0');
  const logs = logCall.result as Array<{ data: string }>;
  assert.equal(logs.length, 1);
  const hooksWord = logs[0].data.slice(2 + 64 * 2, 2 + 64 * 3);
  assert.equal(hooksWord, '0'.repeat(64));
  assert.equal(c.output.hook, '0x0000000000000000000000000000000000000000');
  assert.equal(c.output.gated_by_hook, false);
  assert.equal(c.output.initialize_log.pool_key_hashes_to_pool_id, true);
});

test('hook proof reads the hook from the log, not an assumption: a tampered non-zero hook is refused', async () => {
  // Every real stock pool's hook is zero, so a decoder that always returned zero would pass every
  // replay above (mutation R6 in artifacts/quoteproof-001 survived until this test existed). A
  // non-zero hook in the log no longer hashes to the poolId, and the proof must refuse it.
  const c = find('prove_pool_hook', 'AAPL');
  const inner = replayTransport(c.calls);
  const tampered: Transport = async (m, p) => {
    const r = await inner(m, p);
    if (m !== 'eth_getLogs') return r;
    return (r as Array<{ data: string }>).map((l) => ({ ...l, data: l.data.slice(0, 2 + 64 * 2) + '00'.repeat(12) + 'ab'.repeat(20) + l.data.slice(2 + 64 * 3) }));
  };
  await assert.rejects(run(c, tampered), /hashes to .* not to the poolId/);
});

test('NVDA hook proof: v3 has no hooks and says so', () => {
  const o = find('prove_pool_hook', 'NVDA').output;
  assert.equal(o.hooks_applicable, false);
  assert.equal(o.hook, null);
});

test('nav_context is marked reference-only and NAV = close x uiMultiplier', () => {
  for (const t of ['NVDA', 'SPY']) {
    const o = find('nav_context', t).output;
    assert.equal(o.reference_only, true);
    assert.match(o.label, /NOT A VENUE PRICE/);
    assert.equal(o.nav_basis, 'multiplier');
    assert.ok(Math.abs(Number(o.nav) - o.underlying.price * Number(o.ui_multiplier.value)) < 1e-6);
  }
  assert.ok(Number(find('nav_context', 'NVDA').output.ui_multiplier.value) > 1, 'NVDA carries a dividend multiplier above 1');
});

test('replay is strict: a request missing from the recording throws instead of reaching the network', async () => {
  const c = find('quote_stock_token', 'NVDA');
  await assert.rejects(callTool({ rpc: replayTransport(c.calls) }, 'quote_stock_token', { ticker: 'NVDA', block: 1 }), /fixture miss/);
});

test('refuses an RPC that is not chain 4663', async () => {
  const c = find('quote_stock_token', 'NVDA');
  const inner = replayTransport(c.calls);
  const wrongChain: Transport = async (m, p) => (m === 'eth_chainId' ? '0xa4b1' : inner(m, p));
  await assert.rejects(run(c, wrongChain), /not Robinhood Chain 4663/);
});

test('wrong-pool guard: a pool whose tokens do not include the stock is refused', async () => {
  const c = find('quote_stock_token', 'NVDA');
  const inner = replayTransport(c.calls);
  const swapped: Transport = async (m, p) => {
    const r = await inner(m, p);
    const d = m === 'eth_call' ? (p[0] as any).data : '';
    return d === SEL.token1 ? '0x' + '00'.repeat(12) + 'ab'.repeat(20) : r;
  };
  await assert.rejects(run(c, swapped), /wrong-pool guard/);
});

test('v4 slot self-check: an lpFee that disagrees with the Initialize fee is refused', async () => {
  const c = find('quote_stock_token', 'AAPL');
  const inner = replayTransport(c.calls);
  let first = true;
  const tampered: Transport = async (m, p) => {
    const r = (await inner(m, p)) as string;
    if (m === 'eth_call' && (p[0] as any).data.startsWith(SEL.extsload) && first) {
      first = false;
      const w = BigInt(r) ^ (1n << 208n); // flip the lowest lpFee bit
      return '0x' + w.toString(16).padStart(64, '0');
    }
    return r;
  };
  await assert.rejects(run(c, tampered), /lpFee/);
});

test('missing required argument is refused before any request', async () => {
  let calls = 0;
  const counting: Transport = async () => { calls++; return '0x'; };
  await assert.rejects(callTool({ rpc: counting }, 'quote_stock_token', {}), /needs "ticker"/);
  assert.equal(calls, 0);
});
