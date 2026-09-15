// Quote maths. Pure functions, no I/O. Formulas and fixtures: quoteproof-spec-001
// SPEC-QUOTE-MATHS.md, which test/math.test.ts checks against to the spec's tolerances.

export const Q96 = 1n << 96n;
const Q192 = Q96 * Q96;
const PPM = 1_000_000n;
/** Fixed-point scale for prices carried as bigint. */
export const SCALE_DIGITS = 30;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

export type Side = 'token0' | 'token1';

const pow10 = (n: number) => 10n ** BigInt(n);

/** Human price of the STOCK in units of the OTHER token, scaled by 1e30.
 *  sqrtPriceX96 encodes sqrt(token1_raw / token0_raw). */
export function midScaled(sqrtPriceX96: bigint, dec0: number, dec1: number, stockIs: Side): bigint {
  if (sqrtPriceX96 <= 0n) throw new Error('sqrtPriceX96 must be positive');
  const sq = sqrtPriceX96 * sqrtPriceX96;
  const e = dec0 - dec1;
  if (stockIs === 'token0') {
    // token1 per token0 = sq/Q192 * 10^(dec0-dec1)
    return e >= 0 ? (sq * pow10(e) * SCALE) / Q192 : (sq * SCALE) / (Q192 * pow10(-e));
  }
  // token0 per token1 = Q192/sq * 10^(dec1-dec0)
  return -e >= 0 ? (Q192 * pow10(-e) * SCALE) / sq : (Q192 * SCALE) / (sq * pow10(e));
}

/** Render a 1e30-scaled bigint as a decimal string with `digits` fractional digits (floored). */
export function fmt(scaled: bigint, digits = 18): string {
  const neg = scaled < 0n;
  const v = neg ? -scaled : scaled;
  const int = v / SCALE;
  const frac = (v % SCALE).toString().padStart(SCALE_DIGITS, '0').slice(0, digits);
  return `${neg ? '-' : ''}${int}${digits > 0 ? '.' + frac : ''}`;
}

export const toNum = (scaled: bigint): number => Number(fmt(scaled, 24));

/** Uniswap takes the fee off the INPUT (SwapMath.computeSwapStep:
 *  amountRemainingLessFee = amountRemaining * (1e6 - fee) / 1e6). So a buyer pays MID/(1-f) and
 *  a seller receives MID*(1-f). MID*(1+f) is the symmetric approximation and is WRONG on the buy
 *  side (playbook lesson 61). */
export function buyScaled(mid: bigint, feePpm: number): bigint {
  if (!Number.isInteger(feePpm) || feePpm < 0 || feePpm >= 1_000_000) throw new Error(`bad fee ppm ${feePpm}`);
  return (mid * PPM) / (PPM - BigInt(feePpm));
}

export function sellScaled(mid: bigint, feePpm: number): bigint {
  if (!Number.isInteger(feePpm) || feePpm < 0 || feePpm >= 1_000_000) throw new Error(`bad fee ppm ${feePpm}`);
  return (mid * (PPM - BigInt(feePpm))) / PPM;
}

/** Round trip in the same pool, in bps: 1/((1-fBuy)(1-fSell)) - 1. Not 2f/(1-f). */
export function roundTripBps(feeBuyPpm: number, feeSellPpm: number): number {
  return (1 / ((1 - feeBuyPpm / 1e6) * (1 - feeSellPpm / 1e6)) - 1) * 1e4;
}

/** Uniswap v4 ProtocolFeeLibrary.calculateSwapFee: protocol + lp - protocol*lp/1e6. */
export function v4SwapFee(protocolFeePpm: number, lpFeePpm: number): number {
  return protocolFeePpm + lpFeePpm - Math.floor((protocolFeePpm * lpFeePpm) / 1e6);
}

// ---- depth ----------------------------------------------------------------------------------

export interface TickLiquidity { tick: number; liquidityNet: bigint }

/** sqrt(1.0001^tick) * 2^96. Float TickMath: relative error ~1e-16, far inside the spec's 1e-9
 *  depth tolerance, and only ever used for segment BOUNDARIES. */
export function sqrtAtTick(tick: number): bigint {
  return BigInt(Math.round(Math.pow(1.0001, tick / 2) * 2 ** 96));
}

export function tickAtSqrt(sqrtPriceX96: bigint): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return Math.floor(Math.log(ratio * ratio) / Math.log(1.0001));
}

/** Exact within-segment amounts (raw units, floored). Requires a < b. */
export function amountsBetween(sqrtA: bigint, sqrtB: bigint, L: bigint): { amount0: bigint; amount1: bigint } {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return {
    amount0: (L * (sqrtB - sqrtA) * Q96) / (sqrtA * sqrtB),
    amount1: (L * (sqrtB - sqrtA)) / Q96,
  };
}

export interface WalkResult {
  amount0: bigint;
  amount1: bigint;
  ticksCrossed: number[];
  /** True if any part of the path had zero active liquidity: depth is then all there is. */
  hitZeroLiquidity: boolean;
  liquidityEnd: bigint;
}

/** Walk the curve from sqrtStart to sqrtTarget across initialised ticks, as a swap would,
 *  fee excluded. Moving DOWN crosses the largest initialised tick <= current and subtracts its
 *  liquidityNet; moving UP crosses the smallest initialised tick > current and adds it. */
export function walk(sqrtStart: bigint, sqrtTarget: bigint, L: bigint, currentTick: number, ticks: TickLiquidity[]): WalkResult {
  const down = sqrtTarget < sqrtStart;
  const sorted = [...ticks].sort((a, b) => (down ? b.tick - a.tick : a.tick - b.tick));
  const targetTick = tickAtSqrt(sqrtTarget);
  const path = sorted.filter((t) => (down ? t.tick <= currentTick && t.tick > targetTick - 1 : t.tick > currentTick && t.tick <= targetTick + 1));
  let sqrt = sqrtStart;
  let liq = L;
  let a0 = 0n;
  let a1 = 0n;
  let zero = false;
  const crossed: number[] = [];
  for (const t of path) {
    const boundary = sqrtAtTick(t.tick);
    const reached = down ? boundary <= sqrtTarget : boundary >= sqrtTarget;
    if (reached) break;
    if (liq === 0n) zero = true;
    const seg = amountsBetween(sqrt, boundary, liq);
    a0 += seg.amount0;
    a1 += seg.amount1;
    sqrt = boundary;
    liq = down ? liq - t.liquidityNet : liq + t.liquidityNet;
    if (liq < 0n) throw new Error(`active liquidity went negative crossing tick ${t.tick}: tick data is inconsistent with the pool`);
    crossed.push(t.tick);
  }
  if (liq === 0n) zero = true;
  const seg = amountsBetween(sqrt, sqrtTarget, liq);
  return { amount0: a0 + seg.amount0, amount1: a1 + seg.amount1, ticksCrossed: crossed, hitZeroLiquidity: zero, liquidityEnd: liq };
}

/** sqrtPriceX96 after the STOCK's human price moves by `bps` (positive = stock dearer). */
export function sqrtAfterMove(sqrtPriceX96: bigint, bps: number, stockIs: Side): bigint {
  const f = BigInt(Math.round(Math.sqrt(1 + bps / 1e4) * 1e18));
  const up = stockIs === 'token0'; // stock dearer <=> token1-per-token0 up when stock is token0
  return up ? (sqrtPriceX96 * f) / 10n ** 18n : (sqrtPriceX96 * 10n ** 18n) / f;
}

/** Human decimal string for a raw token amount. */
export function units(raw: bigint, decimals: number, digits = decimals): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const d = pow10(decimals);
  const frac = (v % d).toString().padStart(decimals, '0').slice(0, digits);
  return `${neg ? '-' : ''}${v / d}${digits > 0 && decimals > 0 ? '.' + frac : ''}`;
}
