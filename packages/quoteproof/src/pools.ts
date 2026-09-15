// The stock-token pools this reader knows about on Robinhood Chain (4663).
//
// PROVENANCE. Every address below was read from the chain or from the venue's own public
// data by rwa-venue-recon-001 (2026-09-10) and re-verified by market-capture-001 (2026-09-11):
// token addresses from Robinhood's asset registry, pool addresses and v4 PoolKeys from
// `41-v4-hooks.txt` (the Initialize log decode) and `edge-lab/capture/venues.json`.
//
// WHAT IS PINNED AND WHAT IS NOT.
//  - v3: only the pool ADDRESS. token0/token1, decimals, fee and tickSpacing are read from the
//    pool on every call, because token order and fee tier are on-chain facts with an owner.
//    Fee tiers are NOT uniform across this chain (NVDA v3 charges 500 ppm, the AAPL v4 pool
//    3000) — playbook lesson 5 — so no default tier exists anywhere in this package.
//  - v4: a PoolManager pool has no getters, so its PoolKey is pinned. It is not trusted: the
//    reader recomputes keccak256(abi.encode(PoolKey)) and refuses the pool unless it equals
//    the pinned poolId, and `prove_pool_hook` re-reads the Initialize log live.
//
// WHAT THIS LIST IS NOT. It is not every venue. Robinhood's docs say stock tokens trade via
// RFQ at launch; the chain's Uniswap deployment is one venue beside RFQ, a proprietary AMM and
// a Lighter orderbook, none of which is publicly readable. Nor is it every token: 194 stock
// tokens exist and these are the nine whose deepest Uniswap pool was measured.
//
// Canonical Uniswap addresses are NOT the deployment here (playbook lesson 12): the canonical
// v4 PoolManager has no code on 4663; this chain's PoolManager is below.

export const POOL_MANAGER_V4 = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const V4_POOLS_SLOT = 6n;

export interface V3Pool {
  ticker: string;
  version: 'v3';
  stockToken: string;
  pool: string;
}

export interface V4Pool {
  ticker: string;
  version: 'v4';
  stockToken: string;
  poolManager: string;
  poolId: string;
  currency0: string;
  currency1: string;
  /** From the Initialize log. 0x800000 would mean a dynamic fee; none of these is. */
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export type StockPool = V3Pool | V4Pool;

export const TOKENS: Record<string, string> = {
  AAPL: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  MSFT: '0xe93237C50D904957Cf27E7B1133b510C669c2e74',
  NVDA: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  TSLA: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
  AMZN: '0x12f190a9F9d7D37a250758b26824B97CE941bF54',
  GOOGL: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3',
  SPY: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
  QQQ: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68',
  COIN: '0x6330D8C3178a418788dF01a47479c0ce7CCF450b',
};

export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

export const POOLS: StockPool[] = [
  { ticker: 'NVDA', version: 'v3', stockToken: TOKENS.NVDA, pool: '0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3' },
  { ticker: 'MSFT', version: 'v3', stockToken: TOKENS.MSFT, pool: '0xeb60bCD1D920ad6E102690CCFC6fB488899E1510' },
  { ticker: 'TSLA', version: 'v3', stockToken: TOKENS.TSLA, pool: '0xf4ACdAEEB7022862A763C9B1B885e11191c889E3' },
  { ticker: 'AMZN', version: 'v3', stockToken: TOKENS.AMZN, pool: '0x8AC92DA74AB5F3b1d024Dc1943Ad7e15Dc4179Ef' },
  { ticker: 'COIN', version: 'v3', stockToken: TOKENS.COIN, pool: '0x6707aeAc7D0e519B083219d27BB427364363183A' },
  {
    ticker: 'AAPL', version: 'v4', stockToken: TOKENS.AAPL, poolManager: POOL_MANAGER_V4,
    poolId: '0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb',
    currency0: USDG, currency1: '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9',
    fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000',
  },
  {
    ticker: 'GOOGL', version: 'v4', stockToken: TOKENS.GOOGL, poolManager: POOL_MANAGER_V4,
    poolId: '0xd4ecb79fdc521d7725d22b33ed43cb4e47aa96bfad76aa29577e3151f723ac5e',
    currency0: '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3', currency1: USDG,
    fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000',
  },
  {
    ticker: 'SPY', version: 'v4', stockToken: TOKENS.SPY, poolManager: POOL_MANAGER_V4,
    poolId: '0xfe2a80bb5618fd14984b92ca6d45bf5ba67443ddb1435e28b2e48df2fc1526cd',
    currency0: '0x117cc2133c37b721f49de2a7a74833232b3b4c0c', currency1: USDG,
    fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000',
  },
  {
    // Quoted in the SPY TOKEN, not in USDG: its mid is QQQ per SPY-token and is reported as such.
    ticker: 'QQQ', version: 'v4', stockToken: TOKENS.QQQ, poolManager: POOL_MANAGER_V4,
    poolId: '0xf38009b348295f907c1f2e22aba84d731de3b7360d312881df1c206e85ea3b0b',
    currency0: '0x117cc2133c37b721f49de2a7a74833232b3b4c0c', currency1: '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68',
    fee: 500, tickSpacing: 5, hooks: '0x0000000000000000000000000000000000000000',
  },
];

export function findPool(ticker: string): StockPool {
  const t = String(ticker || '').trim().toUpperCase();
  const p = POOLS.find((x) => x.ticker === t);
  if (!p) throw new Error(`unknown ticker "${ticker}". Known: ${POOLS.map((x) => x.ticker).join(', ')}. HOOD is not tokenized by Robinhood.`);
  return p;
}
