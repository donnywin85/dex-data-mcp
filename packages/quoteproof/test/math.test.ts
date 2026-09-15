// Quote maths against HAND-COMPUTED fixtures written before any code existed:
// quoteproof-spec-001 SPEC-QUOTE-MATHS.md §5 (60-digit decimal arithmetic), and the raw words of
// this job's own P2 live probe (empire-command/artifacts/quoteproof-001/p2-live.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Q96, amountsBetween, buyScaled, fmt, midScaled, roundTripBps, sellScaled, sqrtAfterMove, sqrtAtTick, tickAtSqrt, v4SwapFee, walk,
} from '../src/math.ts';

const SCALE_DIGITS = 30;
/** Parse a decimal string into the 1e30 scale midScaled uses. */
function dec(s: string): bigint {
  const [i, f = ''] = s.split('.');
  return BigInt(i + f.padEnd(SCALE_DIGITS, '0').slice(0, SCALE_DIGITS));
}
function close(actual: bigint, expected: string, rel: number, what: string) {
  const e = dec(expected);
  const diff = actual > e ? actual - e : e - actual;
  assert.ok(Number(diff) / Number(e) <= rel, `${what}: got ${fmt(actual, 24)}, expected ${expected} (rel tol ${rel})`);
}
function closeNum(actual: number, expected: number, rel: number, what: string) {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * rel, `${what}: got ${actual}, expected ${expected}`);
}

// F1A — NVDA/USDG v3: token0 USDG (6), token1 NVDA (18), fee 500 ppm.
const F1A_SQRT = 5361151266145250930969173996756815n;
const F1A_L = 10107437917503339213n;

test('F1A mid, buy and sell reproduce the spec to 1e-12', () => {
  const mid = midScaled(F1A_SQRT, 6, 18, 'token1');
  close(mid, '218.3951780001718961834764613658936237', 1e-12, 'F1A MID');
  close(buyScaled(mid, 500), '218.5044302152795359514521874596234354', 1e-12, 'F1A BUY');
  close(sellScaled(mid, 500), '218.2859804111718102353847231352106769', 1e-12, 'F1A SELL');
});

test('F1B (block-pinned re-read) reproduces the spec to 1e-12', () => {
  const mid = midScaled(5361185331678258514170650565487207n, 6, 18, 'token1');
  close(mid, '218.3924025973278898374453906270637460', 1e-12, 'F1B MID');
  close(buyScaled(mid, 500), '218.5016534240399097923415614077676298', 1e-12, 'F1B BUY');
  close(sellScaled(mid, 500), '218.2832063960292258925266679317502141', 1e-12, 'F1B SELL');
});

test('the buy side is MID/(1-f): the symmetric MID*(1+f) on disk would fail F1A', () => {
  const mid = midScaled(F1A_SQRT, 6, 18, 'token1');
  const symmetric = (mid * 10005n) / 10000n;
  const e = dec('218.5044302152795359514521874596234354');
  assert.ok(Number(e - symmetric) / Number(e) > 1e-7, 'MID*(1+f) must be distinguishable from MID/(1-f) at the fixture tolerance');
});

test('round trip is 1/(1-f)^2 - 1, not 2f/(1-f)', () => {
  closeNum(roundTripBps(500, 500), 10.00750500312687609, 1e-12, 'round trip f=500');
  closeNum(roundTripBps(3000, 3000), 60.27108406463120555, 1e-12, 'round trip f=3000');
  assert.ok(Math.abs(roundTripBps(500, 500) - 10.00500250) > 1e-3);
});

test('F1A depth: 10 bps adverse inside the current tick equals the spec amounts to 1e-9', () => {
  const target = (F1A_SQRT * 9995n) / 10000n;
  const r = walk(F1A_SQRT, target, F1A_L, tickAtSqrt(F1A_SQRT), []);
  closeNum(Number(r.amount1) / 1e18, 341.9712250624994574694, 1e-9, 'NVDA out');
  closeNum(Number(r.amount0) / 1e6, 74722.2276823025649699, 1e-9, 'USDG in');
  // §4's identity: average execution inside one tick for a 2d mid move equals MID/(1-d).
  closeNum((Number(r.amount0) / 1e6) / (Number(r.amount1) / 1e18), 218.5044302152795359515, 1e-9, 'average execution');
  assert.deepEqual(r.ticksCrossed, []);
});

test('v4 swap fee: protocol + lp - protocol*lp/1e6 (3000 lp + 500 protocol = 3499)', () => {
  assert.equal(v4SwapFee(0, 3000), 3000);
  assert.equal(v4SwapFee(500, 3000), 3499);
  assert.equal(v4SwapFee(125, 500), 625);
});

test('walk crosses an initialised tick and applies its liquidityNet (hand-computed in floats)', () => {
  const L = 10n ** 18n;
  const start = Q96; // price 1, tick 0
  const target = sqrtAtTick(200);
  const r = walk(start, target, L, 0, [{ tick: 100, liquidityNet: 10n ** 18n }]);
  const s = (t: number) => Math.pow(1.0001, t / 2);
  const expected1 = 1e18 * (s(100) - 1) + 2e18 * (s(200) - s(100));
  const expected0 = 1e18 * (1 / 1 - 1 / s(100)) + 2e18 * (1 / s(100) - 1 / s(200));
  closeNum(Number(r.amount1), expected1, 1e-9, 'token1 across the crossing');
  closeNum(Number(r.amount0), expected0, 1e-9, 'token0 across the crossing');
  assert.deepEqual(r.ticksCrossed, [100]);
  assert.equal(r.liquidityEnd, 2n * L);
  // Downward from tick 200 across tick 100 subtracts the same liquidityNet.
  const d = walk(target, start, 2n * L, 200, [{ tick: 100, liquidityNet: 10n ** 18n }]);
  closeNum(Number(d.amount1), expected1, 1e-9, 'symmetric downward walk');
  assert.equal(d.liquidityEnd, L);
});

test('walk refuses tick data that drives active liquidity negative', () => {
  assert.throws(() => walk(sqrtAtTick(200), Q96, 10n, 200, [{ tick: 100, liquidityNet: 11n }]), /negative/);
});

test('amountsBetween is order-independent', () => {
  assert.deepEqual(amountsBetween(Q96, sqrtAtTick(50), 10n ** 20n), amountsBetween(sqrtAtTick(50), Q96, 10n ** 20n));
});

test('sqrtAfterMove makes the STOCK dearer by +bps whichever side it is on', () => {
  const sq = F1A_SQRT;
  const m0 = Number(fmt(midScaled(sq, 6, 18, 'token1'), 20));
  const up = Number(fmt(midScaled(sqrtAfterMove(sq, 50, 'token1'), 6, 18, 'token1'), 20));
  closeNum(up / m0 - 1, 0.005, 1e-9, 'stock token1 +50');
  const s2 = 4357752557623340190402210291920610n;
  const n0 = Number(fmt(midScaled(s2, 18, 6, 'token0'), 20));
  const dn = Number(fmt(midScaled(sqrtAfterMove(s2, -50, 'token0'), 18, 6, 'token0'), 20));
  closeNum(dn / n0 - 1, -0.005, 1e-9, 'stock token0 -50');
});

test('P2 live probe words decode: NVDA v3 slot0 and AAPL v4 extsload at block 63,924,857', () => {
  // p2-live.json, probed 2026-09-15T20:07Z with every call at block tag 0x3cf6a79.
  const nvda = midScaled(5437027948217435729998751801424748n, 6, 18, 'token1');
  closeNum(Number(fmt(nvda, 20)), 212.34206505794592, 1e-12, 'NVDA mid from P2');
  const word = BigInt('0x000000000bb81f41f40354c9000000000000d6da91edf82a7066c4b452162ee2');
  const sqrt = word & ((1n << 160n) - 1n);
  const tick = Number(((word >> 160n) & 0xffffffn));
  const protocolFee = Number((word >> 184n) & 0xffffffn);
  const lpFee = Number((word >> 208n) & 0xffffffn);
  assert.equal(sqrt, 4357752557623340190402210291920610n);
  assert.equal(tick, 218313);
  assert.equal(lpFee, 3000);
  // The protocol fee the recon never read: 500 ppm each direction, so a swap pays 3499 ppm.
  assert.equal(protocolFee & 0xfff, 500);
  assert.equal(protocolFee >> 12, 500);
  assert.equal(v4SwapFee(protocolFee & 0xfff, lpFee), 3499);
  assert.ok(Math.abs(tickAtSqrt(sqrt) - tick) <= 1, 'tick self-check');
  closeNum(Number(fmt(midScaled(sqrt, 6, 18, 'token1'), 20)), 330.54762004811795, 1e-12, 'AAPL mid from P2');
});
