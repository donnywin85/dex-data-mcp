// The reader: four read-only operations over public chain state on Robinhood Chain (4663).
//
// EVERY OUTPUT carries the block it was read at (number, timestamp, pinned), the source pool
// (a v3 pool address, or the v4 PoolManager plus poolId), and the fee tier read at that block.
// A value that could not be measured is null with a reason — never a default, never the last
// good value, never an indexer price substituted for a chain read (SPEC-QUOTE-MATHS.md §7).
//
// NEVER a token price from Robinhood's REST `/rhj/prices/{symbol}`: it passes through the
// UNDERLYING equity's bid/ask, so "token vs underlying" computed from it compares the
// underlying to itself (playbook lesson 3). Nothing in this package calls it.

import { SEL, TOPIC_V4_INITIALIZE, ZERO_ADDRESS, addressAt, addressWord, eqAddr, intAt, mappingSlot, signed, stringAt, uintAt, word } from './abi.ts';
import { keccak256 } from './keccak.ts';
import {
  buyScaled, fmt, midScaled, roundTripBps, sellScaled, sqrtAfterMove, tickAtSqrt, toNum, units,
  v4SwapFee, walk, SCALE_DIGITS, type Side, type TickLiquidity,
} from './math.ts';
import { POOLS, USDG, V4_POOLS_SLOT, findPool, type StockPool, type V4Pool } from './pools.ts';
import { CHAIN_ID, RpcError, type HttpGetJson, type Transport } from './rpc.ts';

export interface Ctx {
  rpc: Transport;
  get?: HttpGetJson;
  /** Injectable clock, so a replayed fixture is deterministic. */
  now?: () => number;
}

export interface BlockRef { number: number; tag: string; timestamp: string; pinned: true }

const NOT_ADVICE = 'Read-only market data from one readable venue. Not routing, execution, custody or advice. '
  + 'Robinhood stock tokens also trade via RFQ, a proprietary AMM and a Lighter orderbook, none of which is publicly readable or included.';

// ---- chain access ---------------------------------------------------------------------------

const asHex = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new RpcError(what, `unexpected result ${JSON.stringify(v).slice(0, 80)}`);
  return v;
};

export async function pinBlock(ctx: Ctx, block?: number | string): Promise<BlockRef> {
  const chainId = Number(BigInt(asHex(await ctx.rpc('eth_chainId', []), 'eth_chainId')));
  if (chainId !== CHAIN_ID) throw new Error(`RPC reports chain ${chainId}, not Robinhood Chain ${CHAIN_ID} — refusing to read`);
  let tag: string;
  if (block === undefined || block === null || block === '' || block === 'latest') {
    tag = asHex(await ctx.rpc('eth_blockNumber', []), 'eth_blockNumber');
  } else {
    const n = typeof block === 'number' ? block : Number(block);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`block must be a positive integer, got ${block}`);
    tag = '0x' + n.toString(16);
  }
  const b = (await ctx.rpc('eth_getBlockByNumber', [tag, false])) as { number?: string; timestamp?: string } | null;
  if (!b || !b.timestamp) throw new RpcError('eth_getBlockByNumber', `block ${tag} not returned (pruned, or beyond head)`);
  return { number: Number(BigInt(tag)), tag, timestamp: new Date(Number(BigInt(b.timestamp)) * 1000).toISOString(), pinned: true };
}

async function call(ctx: Ctx, to: string, data: string, tag: string): Promise<string> {
  const r = asHex(await ctx.rpc('eth_call', [{ to, data }, tag]), 'eth_call');
  if (r === '0x') throw new RpcError('eth_call', `empty return from ${to} for ${data.slice(0, 10)} (no code, or not this interface)`);
  return r;
}

interface TokenMeta { address: string; symbol: string | null; decimals: number }

async function tokenMeta(ctx: Ctx, addr: string, tag: string, cache: Map<string, TokenMeta>): Promise<TokenMeta> {
  const k = addr.toLowerCase();
  const hit = cache.get(k);
  if (hit) return hit;
  const d = Number(uintAt(await call(ctx, addr, SEL.decimals, tag), 0));
  if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error(`decimals() on ${addr} returned ${d}`);
  let symbol: string | null = null;
  try { symbol = stringAt(await call(ctx, addr, SEL.symbol, tag)); } catch { symbol = null; }
  const m = { address: addr, symbol, decimals: d };
  cache.set(k, m);
  return m;
}

// ---- pool state -----------------------------------------------------------------------------

export interface PoolState {
  pool: StockPool;
  source: { venue: 'uniswap-v3' | 'uniswap-v4'; pool: string | null; pool_manager: string | null; pool_id: string | null };
  token0: TokenMeta;
  token1: TokenMeta;
  stockIs: Side;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  tickSpacing: number;
  lpFeePpm: number;
  protocolFeePpm: { zeroForOne: number; oneForZero: number } | null;
  feeBuyPpm: number;
  feeSellPpm: number;
  feeSource: string;
  stateSlot: bigint | null;
  checks: string[];
}

export function v4PoolId(p: Pick<V4Pool, 'currency0' | 'currency1' | 'fee' | 'tickSpacing' | 'hooks'>): string {
  return keccak256('0x' + addressWord(p.currency0) + addressWord(p.currency1) + word(p.fee) + word(p.tickSpacing) + addressWord(p.hooks), 'hex');
}

export async function readPoolState(ctx: Ctx, pool: StockPool, tag: string, cache = new Map<string, TokenMeta>()): Promise<PoolState> {
  const checks: string[] = [];
  if (pool.version === 'v3') {
    const s0 = await call(ctx, pool.pool, SEL.slot0, tag);
    const sqrt = uintAt(s0, 0);
    const tick = Number(signed(intAt(s0, 1), 24));
    if (sqrt === 0n) throw new Error(`${pool.ticker}: sqrtPriceX96 is zero — uninitialised pool or wrong address`);
    const t0 = addressAt(await call(ctx, pool.pool, SEL.token0, tag), 0);
    const t1 = addressAt(await call(ctx, pool.pool, SEL.token1, tag), 0);
    let stockIs: Side;
    if (eqAddr(t0, pool.stockToken)) stockIs = 'token0';
    else if (eqAddr(t1, pool.stockToken)) stockIs = 'token1';
    else throw new Error(`${pool.ticker}: wrong-pool guard — neither token0 nor token1 of ${pool.pool} is the ${pool.ticker} token`);
    checks.push(`${pool.ticker} token is ${stockIs} of the pool, read from token0()/token1() at this block`);
    const fee = Number(uintAt(await call(ctx, pool.pool, SEL.fee, tag), 0));
    const spacing = Number(signed(intAt(await call(ctx, pool.pool, SEL.tickSpacing, tag), 0), 24));
    const liquidity = uintAt(await call(ctx, pool.pool, SEL.liquidity, tag), 0);
    const fromPrice = tickAtSqrt(sqrt);
    if (Math.abs(fromPrice - tick) > 1) throw new Error(`${pool.ticker}: slot0 tick ${tick} disagrees with sqrtPriceX96 (tick ${fromPrice})`);
    checks.push('slot0 tick agrees with sqrtPriceX96 to within 1');
    const token0 = await tokenMeta(ctx, t0, tag, cache);
    const token1 = await tokenMeta(ctx, t1, tag, cache);
    return {
      pool, source: { venue: 'uniswap-v3', pool: pool.pool, pool_manager: null, pool_id: null },
      token0, token1, stockIs, sqrtPriceX96: sqrt, tick, liquidity, tickSpacing: spacing,
      // v3's protocol fee is carved out of the LP fee; the trader pays fee() either way.
      lpFeePpm: fee, protocolFeePpm: null, feeBuyPpm: fee, feeSellPpm: fee,
      feeSource: 'fee() on the pool at this block', stateSlot: null, checks,
    };
  }

  const id = v4PoolId(pool);
  if (id !== pool.poolId.toLowerCase()) throw new Error(`${pool.ticker}: pinned PoolKey hashes to ${id}, not the pinned poolId — refusing`);
  checks.push('pinned PoolKey hashes to the pinned poolId');
  const stateSlot = BigInt(mappingSlot(pool.poolId.slice(2), V4_POOLS_SLOT));
  const w = uintAt(await call(ctx, pool.poolManager, SEL.extsload + word(stateSlot), tag), 0);
  if (w === 0n) throw new Error(`${pool.ticker}: extsload returned a zero slot0 word — uninitialised pool or storage layout changed`);
  const sqrt = w & ((1n << 160n) - 1n);
  const tick = Number(signed(w >> 160n, 24));
  const protocolFee = Number((w >> 184n) & 0xffffffn);
  const lpFee = Number((w >> 208n) & 0xffffffn);
  const fromPrice = tickAtSqrt(sqrt);
  if (Math.abs(fromPrice - tick) > 1) throw new Error(`${pool.ticker}: slot0 tick ${tick} disagrees with sqrtPriceX96 (tick ${fromPrice}) — wrong slot`);
  checks.push('slot0 tick agrees with sqrtPriceX96 to within 1');
  if (lpFee !== pool.fee) throw new Error(`${pool.ticker}: slot0 lpFee ${lpFee} is not the static fee ${pool.fee} this pool was initialised with — wrong slot`);
  checks.push(`slot0 lpFee equals the Initialize-log fee ${pool.fee}`);
  const liquidity = uintAt(await call(ctx, pool.poolManager, SEL.extsload + word(stateSlot + 3n), tag), 0) & ((1n << 128n) - 1n);
  let stockIs: Side;
  if (eqAddr(pool.currency0, pool.stockToken)) stockIs = 'token0';
  else if (eqAddr(pool.currency1, pool.stockToken)) stockIs = 'token1';
  else throw new Error(`${pool.ticker}: wrong-pool guard — the PoolKey does not contain the ${pool.ticker} token`);
  const token0 = await tokenMeta(ctx, pool.currency0, tag, cache);
  const token1 = await tokenMeta(ctx, pool.currency1, tag, cache);
  const zeroForOne = protocolFee & 0xfff;
  const oneForZero = protocolFee >> 12;
  const fee01 = v4SwapFee(zeroForOne, lpFee);
  const fee10 = v4SwapFee(oneForZero, lpFee);
  // Buying the stock means paying the OTHER token in: stock token1 => zeroForOne.
  const feeBuy = stockIs === 'token1' ? fee01 : fee10;
  const feeSell = stockIs === 'token1' ? fee10 : fee01;
  return {
    pool, source: { venue: 'uniswap-v4', pool: null, pool_manager: pool.poolManager, pool_id: pool.poolId },
    token0, token1, stockIs, sqrtPriceX96: sqrt, tick, liquidity, tickSpacing: pool.tickSpacing,
    lpFeePpm: lpFee, protocolFeePpm: { zeroForOne, oneForZero }, feeBuyPpm: feeBuy, feeSellPpm: feeSell,
    feeSource: 'lpFee and protocolFee from PoolManager slot0 (extsload) at this block', stateSlot, checks,
  };
}

async function initializedTicks(ctx: Ctx, st: PoolState, tickLo: number, tickHi: number, tag: string): Promise<TickLiquidity[]> {
  const sp = st.tickSpacing;
  const cLo = Math.floor(tickLo / sp);
  const cHi = Math.floor(tickHi / sp);
  const wLo = cLo >> 8;
  const wHi = cHi >> 8;
  if (wHi - wLo > 8) throw new Error(`depth range spans ${wHi - wLo + 1} bitmap words; refusing an unbounded scan`);
  const out: TickLiquidity[] = [];
  for (let wp = wLo; wp <= wHi; wp++) {
    let bits: bigint;
    if (st.pool.version === 'v3') bits = uintAt(await call(ctx, st.pool.pool, SEL.tickBitmap + word(wp), tag), 0);
    else bits = uintAt(await call(ctx, st.pool.poolManager, SEL.extsload + mappingSlot(word(wp), st.stateSlot! + 5n).slice(2), tag), 0);
    if (bits === 0n) continue;
    for (let b = 0; b < 256; b++) {
      if (((bits >> BigInt(b)) & 1n) === 0n) continue;
      const compressed = wp * 256 + b;
      if (compressed < cLo || compressed > cHi) continue;
      const t = compressed * sp;
      let gross: bigint;
      let net: bigint;
      if (st.pool.version === 'v3') {
        const r = await call(ctx, st.pool.pool, SEL.ticks + word(t), tag);
        gross = uintAt(r, 0);
        net = intAt(r, 1);
      } else {
        const v = uintAt(await call(ctx, st.pool.poolManager, SEL.extsload + mappingSlot(word(t), st.stateSlot! + 4n).slice(2), tag), 0);
        gross = v & ((1n << 128n) - 1n);
        net = signed(v >> 128n, 128);
      }
      if (gross === 0n) throw new Error(`tick ${t} is set in the bitmap but has zero liquidityGross — tick storage read is wrong`);
      out.push({ tick: t, liquidityNet: net });
    }
  }
  return out;
}

// ---- output helpers -------------------------------------------------------------------------

const bps = (ppm: number) => ppm / 100;
const tokenOut = (m: TokenMeta) => ({ address: m.address, symbol: m.symbol, decimals: m.decimals });

function sides(st: PoolState) {
  const stock = st.stockIs === 'token0' ? st.token0 : st.token1;
  const quote = st.stockIs === 'token0' ? st.token1 : st.token0;
  return { stock, quote };
}

function envelope(st: PoolState, blk: BlockRef) {
  return {
    chain_id: CHAIN_ID,
    block: { number: blk.number, timestamp: blk.timestamp, pinned: true },
    source: st.source,
    fee_tier_ppm: st.lpFeePpm,
    fee_tier_bps: bps(st.lpFeePpm),
  };
}

/** Price of `stockRaw` stock for `quoteRaw` quote, as a 1e30-scaled human price. */
function avgScaled(quoteRaw: bigint, qDec: number, stockRaw: bigint, sDec: number): bigint | null {
  if (stockRaw <= 0n) return null;
  return (quoteRaw * 10n ** BigInt(sDec) * 10n ** BigInt(SCALE_DIGITS)) / (stockRaw * 10n ** BigInt(qDec));
}

// ---- tool 1: list_stock_pools ---------------------------------------------------------------

export async function listStockPools(ctx: Ctx, args: { block?: number | string } = {}) {
  const blk = await pinBlock(ctx, args.block);
  const cache = new Map<string, TokenMeta>();
  const pools = [];
  for (const p of POOLS) {
    try {
      const st = await readPoolState(ctx, p, blk.tag, cache);
      const { stock, quote } = sides(st);
      const mid = midScaled(st.sqrtPriceX96, st.token0.decimals, st.token1.decimals, st.stockIs);
      pools.push({
        ticker: p.ticker, version: p.version, ...envelope(st, blk),
        stock: tokenOut(stock), quote: tokenOut(quote),
        tick_spacing: st.tickSpacing, liquidity: st.liquidity.toString(),
        mid: fmt(mid, 8), mid_units: `${quote.symbol ?? 'quote'} per ${stock.symbol ?? p.ticker}`,
        error: null,
      });
    } catch (e) {
      pools.push({
        ticker: p.ticker, version: p.version, chain_id: CHAIN_ID,
        block: { number: blk.number, timestamp: blk.timestamp, pinned: true },
        source: p.version === 'v3'
          ? { venue: 'uniswap-v3', pool: p.pool, pool_manager: null, pool_id: null }
          : { venue: 'uniswap-v4', pool: null, pool_manager: p.poolManager, pool_id: p.poolId },
        fee_tier_ppm: null, fee_tier_bps: null, error: String((e as Error).message ?? e),
      });
    }
  }
  return {
    kind: 'stock_pools', chain_id: CHAIN_ID, block: { number: blk.number, timestamp: blk.timestamp, pinned: true },
    count: pools.length, readable: pools.filter((p) => !p.error).length,
    coverage: 'The nine measured Uniswap pools for nine of the 194 Robinhood stock tokens. Not every token, not every venue.',
    pools, not: NOT_ADVICE,
  };
}

// ---- tool 2: quote_stock_token --------------------------------------------------------------

export async function quote(ctx: Ctx, args: { ticker: string; block?: number | string; depth_bps?: number }) {
  const pool = findPool(args.ticker);
  const moveBps = args.depth_bps ?? 50;
  if (!(Number.isFinite(moveBps) && moveBps > 0 && moveBps <= 500)) throw new Error(`depth_bps must be in (0, 500], got ${args.depth_bps}`);
  const blk = await pinBlock(ctx, args.block);
  const st = await readPoolState(ctx, pool, blk.tag);
  const { stock, quote: q } = sides(st);
  const mid = midScaled(st.sqrtPriceX96, st.token0.decimals, st.token1.decimals, st.stockIs);
  const buy = buyScaled(mid, st.feeBuyPpm);
  const sell = sellScaled(mid, st.feeSellPpm);
  const unitsLabel = `${q.symbol ?? 'quote'} per ${stock.symbol ?? pool.ticker}`;

  const up = sqrtAfterMove(st.sqrtPriceX96, moveBps, st.stockIs);
  const down = sqrtAfterMove(st.sqrtPriceX96, -moveBps, st.stockIs);
  const tA = tickAtSqrt(up);
  const tB = tickAtSqrt(down);
  const ticks = await initializedTicks(ctx, st, Math.min(tA, tB, st.tick) - st.tickSpacing, Math.max(tA, tB, st.tick) + st.tickSpacing, blk.tag);
  const wUp = walk(st.sqrtPriceX96, up, st.liquidity, st.tick, ticks);
  const wDown = walk(st.sqrtPriceX96, down, st.liquidity, st.tick, ticks);
  const pick = (w: { amount0: bigint; amount1: bigint }) =>
    st.stockIs === 'token0' ? { stockRaw: w.amount0, quoteRaw: w.amount1 } : { stockRaw: w.amount1, quoteRaw: w.amount0 };
  const PPM = 1_000_000n;

  const b = pick(wUp);
  const quoteInGross = (b.quoteRaw * PPM + (PPM - BigInt(st.feeBuyPpm)) - 1n) / (PPM - BigInt(st.feeBuyPpm));
  const buyAvg = avgScaled(quoteInGross, q.decimals, b.stockRaw, stock.decimals);
  const s = pick(wDown);
  const stockInGross = (s.stockRaw * PPM + (PPM - BigInt(st.feeSellPpm)) - 1n) / (PPM - BigInt(st.feeSellPpm));
  const sellAvg = avgScaled(s.quoteRaw, q.decimals, stockInGross, stock.decimals);

  return {
    kind: 'quote', ticker: pool.ticker, version: pool.version, ...envelope(st, blk),
    pair: { stock: tokenOut(stock), quote: tokenOut(q), stock_is: st.stockIs },
    fee: {
      buy_ppm: st.feeBuyPpm, sell_ppm: st.feeSellPpm, lp_fee_ppm: st.lpFeePpm,
      protocol_fee_ppm: st.protocolFeePpm, source: st.feeSource,
    },
    price: {
      units: unitsLabel,
      mid: fmt(mid, 12),
      buy_after_fee: fmt(buy, 12),
      sell_after_fee: fmt(sell, 12),
      round_trip_cost_bps: Number(roundTripBps(st.feeBuyPpm, st.feeSellPpm).toFixed(6)),
      formula: 'buy = mid / (1 - fee); sell = mid * (1 - fee); fee is taken off the swap input',
    },
    depth: {
      move_bps: moveBps,
      basis: 'curve walk across initialised ticks read at this block; amounts are exact per segment, tick boundaries use float TickMath',
      buy_side: {
        description: `buy ${pool.ticker} until the pool mid is ${moveBps} bps higher`,
        stock_out: units(b.stockRaw, stock.decimals, Math.min(stock.decimals, 8)),
        quote_in_before_fee: units(b.quoteRaw, q.decimals, Math.min(q.decimals, 8)),
        quote_in_with_fee: units(quoteInGross, q.decimals, Math.min(q.decimals, 8)),
        average_price_with_fee: buyAvg === null ? null : fmt(buyAvg, 8),
        ticks_crossed: wUp.ticksCrossed.length, hit_zero_liquidity: wUp.hitZeroLiquidity,
      },
      sell_side: {
        description: `sell ${pool.ticker} until the pool mid is ${moveBps} bps lower`,
        stock_in_before_fee: units(s.stockRaw, stock.decimals, Math.min(stock.decimals, 8)),
        stock_in_with_fee: units(stockInGross, stock.decimals, Math.min(stock.decimals, 8)),
        quote_out: units(s.quoteRaw, q.decimals, Math.min(q.decimals, 8)),
        average_price_with_fee: sellAvg === null ? null : fmt(sellAvg, 8),
        ticks_crossed: wDown.ticksCrossed.length, hit_zero_liquidity: wDown.hitZeroLiquidity,
      },
    },
    pool_state: {
      sqrtPriceX96: st.sqrtPriceX96.toString(), tick: st.tick, liquidity: st.liquidity.toString(),
      tick_spacing: st.tickSpacing, initialised_ticks_in_range: ticks.length,
    },
    checks: st.checks,
    not: NOT_ADVICE,
  };
}

// ---- tool 3: prove_pool_hook ----------------------------------------------------------------

export async function hookProof(ctx: Ctx, args: { ticker: string; block?: number | string }) {
  const pool = findPool(args.ticker);
  const blk = await pinBlock(ctx, args.block);
  const st = await readPoolState(ctx, pool, blk.tag);
  if (pool.version === 'v3') {
    return {
      kind: 'hook_proof', ticker: pool.ticker, version: 'v3', ...envelope(st, blk),
      hooks_applicable: false, hook: null, gated_by_hook: false,
      basis: 'Uniswap v3 pools have no hook mechanism; nothing in the pool contract can reject a swapper.',
      scope: 'Pool-level only. Says nothing about the stock token contract itself.',
      not: NOT_ADVICE,
    };
  }
  const logs = (await ctx.rpc('eth_getLogs', [{ address: pool.poolManager, topics: [TOPIC_V4_INITIALIZE, pool.poolId], fromBlock: '0x0', toBlock: blk.tag }])) as Array<{
    topics: string[]; data: string; blockNumber: string; transactionHash: string;
  }>;
  if (!Array.isArray(logs)) throw new RpcError('eth_getLogs', 'result is not an array');
  if (logs.length !== 1) throw new Error(`${pool.ticker}: expected exactly one Initialize log for this poolId, got ${logs.length}`);
  const log = logs[0];
  const key = {
    currency0: '0x' + log.topics[2].slice(26),
    currency1: '0x' + log.topics[3].slice(26),
    fee: Number(uintAt(log.data, 0)),
    tickSpacing: Number(signed(intAt(log.data, 1), 24)),
    hooks: addressAt(log.data, 2),
  };
  const recomputed = v4PoolId(key);
  const idMatches = recomputed === log.topics[1].toLowerCase() && recomputed === pool.poolId.toLowerCase();
  if (!idMatches) throw new Error(`${pool.ticker}: the Initialize log's PoolKey hashes to ${recomputed}, not to the poolId it was indexed under`);
  const gated = !eqAddr(key.hooks, ZERO_ADDRESS);
  return {
    kind: 'hook_proof', ticker: pool.ticker, version: 'v4', ...envelope(st, blk),
    hooks_applicable: true,
    hook: key.hooks,
    gated_by_hook: gated,
    basis: gated
      ? 'Non-zero hook address. It MAY reject swappers; its permission bits are not interpreted here, because a selector match is a guess, not a fact.'
      : 'Zero hook address in the Initialize log: the PoolManager calls no hook for this pool, so no beforeSwap gate exists.',
    initialize_log: {
      block_number: Number(BigInt(log.blockNumber)),
      transaction_hash: log.transactionHash,
      pool_key: key,
      pool_key_hashes_to_pool_id: idMatches,
      dynamic_fee: key.fee === 0x800000,
    },
    scope: 'Pool-level only. Says nothing about the stock token contract itself.',
    not: NOT_ADVICE,
  };
}

// ---- tool 4: nav_context --------------------------------------------------------------------

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';

export async function navContext(ctx: Ctx, args: { ticker: string; block?: number | string }) {
  const pool = findPool(args.ticker);
  const blk = await pinBlock(ctx, args.block);
  const st = await readPoolState(ctx, pool, blk.tag);
  const { stock, quote: q } = sides(st);
  const now = ctx.now ? ctx.now() : Date.now();

  let multiplier: { value: string | null; error: string | null } = { value: null, error: null };
  try {
    const raw = uintAt(await call(ctx, pool.stockToken, SEL.uiMultiplier, blk.tag), 0);
    multiplier = { value: fmt(raw * 10n ** 12n, 18), error: null };
  } catch (e) {
    multiplier = { value: null, error: String((e as Error).message ?? e) };
  }

  let underlying: { price: number | null; price_time: string | null; session_open: boolean | null; price_kind: string | null; error: string | null } =
    { price: null, price_time: null, session_open: null, price_kind: null, error: null };
  if (!ctx.get) {
    underlying.error = 'no HTTP client configured';
  } else {
    try {
      const j = (await ctx.get(`${YAHOO}${encodeURIComponent(pool.ticker)}?range=1d&interval=1d`)) as {
        chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; regularMarketTime?: number; currentTradingPeriod?: { regular?: { start?: number; end?: number } } } }> };
      };
      const m = j?.chart?.result?.[0]?.meta;
      if (!m || typeof m.regularMarketPrice !== 'number') throw new Error('no meta.regularMarketPrice');
      const reg = m.currentTradingPeriod?.regular;
      const sec = Math.floor(now / 1000);
      const open = reg && typeof reg.start === 'number' && typeof reg.end === 'number' ? sec >= reg.start && sec < reg.end : null;
      underlying = {
        price: m.regularMarketPrice,
        price_time: typeof m.regularMarketTime === 'number' ? new Date(m.regularMarketTime * 1000).toISOString() : null,
        session_open: open,
        price_kind: open === null ? 'UNKNOWN (session window unreadable)' : open ? 'last regular-session trade (session open)' : 'regular-session close',
        error: null,
      };
    } catch (e) {
      underlying.error = String((e as Error).message ?? e);
    }
  }

  let nav: string | null = null;
  let navBasis: 'multiplier' | 'UNKNOWN' = 'UNKNOWN';
  if (underlying.price !== null && multiplier.value !== null) {
    nav = (underlying.price * Number(multiplier.value)).toFixed(6);
    navBasis = 'multiplier';
  }
  const mid = midScaled(st.sqrtPriceX96, st.token0.decimals, st.token1.decimals, st.stockIs);
  const usdQuoted = eqAddr(q.address, USDG);
  const premium = nav !== null && usdQuoted ? Number((((toNum(mid) / Number(nav)) - 1) * 1e4).toFixed(4)) : null;

  return {
    kind: 'nav_context', ticker: pool.ticker, version: pool.version, ...envelope(st, blk),
    reference_only: true,
    label: 'REFERENCE, NOT A VENUE PRICE. NAV = underlying close x the issuer uiMultiplier. It is not a token price and nobody quotes it.',
    underlying: { symbol: pool.ticker, ...underlying, source: 'Yahoo Finance chart v8 meta.regularMarketPrice (keyless)' },
    ui_multiplier: { ...multiplier, read_at_block: blk.number, source: `uiMultiplier() on the ${pool.ticker} token` },
    nav, nav_basis: navBasis,
    pool_mid: { value: fmt(mid, 8), units: `${q.symbol ?? 'quote'} per ${stock.symbol ?? pool.ticker}` },
    pool_mid_vs_nav_bps: premium,
    pool_mid_vs_nav_note: usdQuoted
      ? 'USDG treated as 1 USD. A few bps either side is normal: fees, the multiplier and session timing all move it.'
      : `Not computed: this pool is quoted in ${q.symbol ?? q.address}, not USDG.`,
    not: NOT_ADVICE,
  };
}

// ---- anchoring helper -----------------------------------------------------------------------

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = canonical((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

/** JSON with keys sorted at every depth and no whitespace. */
export const canonicalJson = (v: unknown): string => JSON.stringify(canonical(v));

/** The bytes32 to pass to QuoteRegistry.anchor: keccak256 of the canonical JSON of an output. */
export const quoteHash = (output: unknown): string => keccak256(canonicalJson(output));

