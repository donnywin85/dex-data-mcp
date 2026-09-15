// Tool definitions shared by the MCP server and the CLI. One table, so the two cannot drift.
import { hookProof, listStockPools, navContext, quote, type Ctx } from './reader.ts';
import { POOLS } from './pools.ts';

const tickerProp = {
  type: 'string',
  enum: POOLS.map((p) => p.ticker),
  description: 'Stock ticker. One of the nine measured Robinhood Chain stock-token pools.',
};
const blockProp = {
  type: 'integer',
  description: 'Optional Robinhood Chain block number to read at. Defaults to the latest block, pinned once for every read in the call.',
};

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run: (ctx: Ctx, args: Record<string, unknown>) => Promise<unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_stock_pools',
    description:
      'Lists the measured Uniswap v3 and v4 pools for tokenized stocks on Robinhood Chain (4663), read live at one pinned block: '
      + 'pool address or PoolManager plus poolId, both tokens with decimals read from the chain, the fee tier read from the pool, '
      + 'tick spacing, active liquidity and mid price. A pool that cannot be read is returned with its error, not dropped.',
    inputSchema: { type: 'object', properties: { block: blockProp } },
    run: (ctx, a) => listStockPools(ctx, { block: a.block as number | undefined }),
  },
  {
    name: 'quote_stock_token',
    description:
      'Fee-aware quote for one Robinhood Chain stock token from its pool at one pinned block: mid price, the swap fee actually charged '
      + '(v3 fee(), or v4 lpFee plus protocol fee), buy price mid/(1-fee), sell price mid*(1-fee), round-trip cost, and depth: how much '
      + 'can be bought or sold before the mid moves by depth_bps (default 50), walked across initialised ticks. Read-only data, not advice, '
      + 'and not the only venue: RFQ, Robinhood\'s AMM and Lighter are not readable.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: tickerProp,
        block: blockProp,
        depth_bps: { type: 'number', description: 'Adverse mid move to size depth against, in bps. Default 50, max 500.' },
      },
      required: ['ticker'],
    },
    run: (ctx, a) => quote(ctx, { ticker: String(a.ticker), block: a.block as number | undefined, depth_bps: a.depth_bps as number | undefined }),
  },
  {
    name: 'prove_pool_hook',
    description:
      'Proves whether a stock-token pool can gate swappers. For a v4 pool it reads the PoolManager Initialize log live, decodes the '
      + 'hook address, and checks the logged PoolKey hashes to the poolId. Zero address means no hook, so no beforeSwap gate. A v3 pool '
      + 'has no hook mechanism. Pool-level only; it says nothing about the token contract.',
    inputSchema: { type: 'object', properties: { ticker: tickerProp, block: blockProp }, required: ['ticker'] },
    run: (ctx, a) => hookProof(ctx, { ticker: String(a.ticker), block: a.block as number | undefined }),
  },
  {
    name: 'nav_context',
    description:
      'Reference NAV for a stock token: the underlying\'s Yahoo Finance regular-session price times the issuer\'s on-chain uiMultiplier() '
      + '(dividends are reinvested into it, so the token tracks total return). Marked reference-only: it is NOT a venue price or a token '
      + 'price. Includes the pool mid at the same block and, for USDG-quoted pools, the mid vs NAV in bps.',
    inputSchema: { type: 'object', properties: { ticker: tickerProp, block: blockProp }, required: ['ticker'] },
    run: (ctx, a) => navContext(ctx, { ticker: String(a.ticker), block: a.block as number | undefined }),
  },
];

/** Validate required arguments before any request is made — the same rule dex-data-mcp's server
 *  enforces: a model-driven client dropping an argument is the ordinary case. */
export async function callTool(ctx: Ctx, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool "${name}". Tools: ${TOOLS.map((t) => t.name).join(', ')}`);
  const given = (k: string) => !(args[k] === undefined || args[k] === null || args[k] === '');
  const missing = (tool.inputSchema.required ?? []).filter((k) => !given(k));
  if (missing.length) throw new Error(`${name} needs ${missing.map((m) => `"${m}"`).join(', ')}. Nothing was requested.`);
  return tool.run(ctx, args);
}
