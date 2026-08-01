#!/usr/bin/env node
// dex-data MCP server — live multi-chain DEX market data as MCP tools.
//
// Distribution, not payment. The ledger showed zero genuine third-party queries
// across 20,392 paywall challenges: we were being indexed by crawlers, not used
// by agents. Bazaar rank cannot fix that, because the demand is not there yet.
// MCP puts the same data where agents already are today — Claude Desktop, Claude
// Code, Cursor — with no payment step for the free routes, removing the one
// barrier a browsing agent cannot cross unattended.
//
// Speaks MCP over stdio with zero dependencies: the protocol is newline-delimited
// JSON-RPC 2.0, and adding an SDK here would mean an install step between a user
// and trying it. Fewer barriers, more usage.

import { createInterface } from 'node:readline';
import { fetchMaybePaid, payEnabled, budget } from './pay.mjs';

const BASE = (process.env.X402_BASE || 'https://x402.donnyautomation.com').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.DEX_MCP_TIMEOUT_MS || 45000);
const CHAINS = ['bsc', 'polygon', 'arbitrum', 'base', 'avalanche', 'optimism'];

const chainProp = {
  type: 'string', enum: CHAINS,
  description: 'Chain to query. Defaults to bsc.',
};

const TOOLS = [
  {
    name: 'get_token_price',
    description:
      'Live USD price of any ERC-20 token, read from DEX pools at call time. Accepts a ticker '
      + '(CAKE, WETH, ARB) or any contract address. Returns the price, the pair it was priced '
      + 'through, the USD liquidity backing that quote and a confidence rating. Refuses to return '
      + 'a price backed by a dust pool rather than reporting an unreliable number.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Ticker (e.g. CAKE) or 0x contract address.' },
        chain: chainProp,
      },
      required: ['token'],
    },
    route: (a) => `/price?symbol=${encodeURIComponent(a.token)}`,
    // an address goes in the token= param instead of symbol=
    fix: (a, url) => (/^0x[0-9a-fA-F]{40}$/.test(a.token) ? url.replace('symbol=', 'token=') : url),
  },
  {
    name: 'get_liquidity',
    description:
      'Market depth and TVL for a trading pair, broken down per venue: how deep the pools are, '
      + 'which venue holds the most liquidity, and each venue share of total depth.',
    inputSchema: {
      type: 'object',
      properties: {
        pair: { type: 'string', description: 'Pair as SYM/SYM, e.g. WETH/USDC. Either side may be a 0x address.' },
        chain: chainProp,
      },
      required: ['pair'],
    },
    route: (a) => `/liquidity?pair=${encodeURIComponent(a.pair)}`,
  },
  {
    name: 'get_best_venue',
    description:
      'Which DEX is cheapest to buy on and which pays most to sell into, with the cross-venue '
      + 'spread in bps and a fee-adjusted arbitrage spread. Smart order routing data.',
    inputSchema: {
      type: 'object',
      properties: { pair: { type: 'string', description: 'Pair as SYM/SYM.' }, chain: chainProp },
      required: ['pair'],
    },
    route: (a) => `/route?pair=${encodeURIComponent(a.pair)}`,
  },
  {
    name: 'get_slippage',
    description:
      'Price impact for a SPECIFIC trade size — what a trade will actually get, which a spot price '
      + 'cannot tell you. Simulates the swap against live reserves on every venue. Price impact and '
      + 'the pool fee are reported separately. Pool-level only: excludes gas, MEV and multi-hop routing.',
    inputSchema: {
      type: 'object',
      properties: {
        pair: { type: 'string', description: 'Pair as SYM/SYM.' },
        amountUsd: { type: 'number', description: 'Trade size in USD.' },
        amountIn: { type: 'number', description: 'Alternatively, size in units of the first token.' },
        chain: chainProp,
      },
      required: ['pair'],
    },
    route: (a) => `/slippage?pair=${encodeURIComponent(a.pair)}`
      + (a.amountUsd != null ? `&amountUsd=${encodeURIComponent(a.amountUsd)}` : '')
      + (a.amountIn != null ? `&amountIn=${encodeURIComponent(a.amountIn)}` : ''),
  },
  {
    name: 'get_liquidity_risk',
    description:
      'Pre-trade depth check for a pair: classifies the market DEEP, MODERATE, SHALLOW or VERY_THIN '
      + 'from live pool TVL, counts routable venues, and flags single-venue markets and wide spreads. '
      + 'Liquidity depth analysis only — NOT a contract audit and NOT a honeypot check.',
    inputSchema: {
      type: 'object',
      properties: { pair: { type: 'string', description: 'Pair as SYM/SYM.' }, chain: chainProp },
      required: ['pair'],
    },
    route: (a) => `/risk?pair=${encodeURIComponent(a.pair)}`,
  },
  {
    name: 'get_spend_budget',
    description: 'How much this session has spent on paid calls, and the caps in force. '
      + 'Free, local, and makes the cost of continuing visible before it is incurred.',
    inputSchema: { type: 'object', properties: {} },
    local: () => budget(),
  },
  {
    name: 'list_chains',
    description: 'Supported chains, their indexed tokens and venues. Free, and the right first call '
      + 'if you are unsure which chain or ticker to use.',
    inputSchema: { type: 'object', properties: {} },
    route: () => '/chains',
    free: true,
  },
];

// The paid routes sit behind an x402 paywall. Without a wallet an MCP client gets
// a 402, so say exactly that and what it costs, rather than surfacing a bare HTTP
// error the model has to guess at.
function paywallMessage(tool, url, reason) {
  const b = budget();
  const lines = [
    'Daily free allowance used up for this caller, so this call needs payment.',
    '',
    `  ${url}`,
    '',
    'The allowance resets every 24h. Still free: the "list_chains" tool.',
    '',
  ];
  if (payEnabled()) {
    lines.push(`A wallet IS configured, but this call was not paid: ${reason || 'unknown'}.`,
      `Budget so far: $${b.spentUsd} of $${b.maxSpendUsd} across ${b.calls} paid call(s).`,
      'Raise DEX_MAX_SPEND_USD / DEX_MAX_PRICE_USD / DEX_MAX_CALLS to allow more.');
  } else {
    lines.push('To keep going, set DEX_WALLET_KEY to a funded wallet private key and',
      'calls will pay themselves with x402 (USDC on Base, ~$0.01 each).',
      'Spend is capped: DEX_MAX_SPEND_USD (default $1), DEX_MAX_PRICE_USD (default',
      '$0.05/call) and DEX_MAX_CALLS (default 200). Use a burner wallet, not a main one.');
  }
  return lines.join('\n');
}

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  const a = args || {};
  if (a.chain && !CHAINS.includes(a.chain)) {
    throw new Error(`unknown chain "${a.chain}". Supported: ${CHAINS.join(', ')}`);
  }
  if (tool.local) return { text: JSON.stringify(tool.local(), null, 2), isError: false };
  let route = tool.route(a);
  if (tool.fix) route = tool.fix(a, route);
  // chain is a path prefix, not a query param — that is how each chain gets its
  // own resource URL upstream.
  const prefix = a.chain && a.chain !== 'bsc' ? `/${a.chain}` : '';
  const url = `${BASE}${prefix}${route}`;

  // Identify the client so free-tier usage is attributable to MCP rather than
  // lost among anonymous traffic - this is how we learn which channel works.
  const headers = { accept: 'application/json', 'user-agent': 'dex-data-mcp/1.1 (+https://github.com/donnywin85/dex-data-mcp)' };

  // Pays automatically only if a wallet is configured AND every budget cap allows
  // it; otherwise this is an ordinary fetch and the 402 is explained.
  const { res, paid, reason, price } = await fetchMaybePaid(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();

  if (res.status === 402) return { text: paywallMessage(tool, url, reason), isError: true };
  void paid; void price;
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 2000) }; }
  if (!res.ok) {
    // 404 here is usually a real answer ("no reliable price"), not a failure, so
    // pass the payload through instead of flattening it to an error string.
    return { text: JSON.stringify({ status: res.status, ...body }, null, 2), isError: res.status >= 500 };
  }
  return { text: JSON.stringify(body, null, 2), isError: false };
}

// ---- JSON-RPC over stdio -------------------------------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'dex-data', version: '1.1.0' },
    };
  }
  if (method === 'tools/list') {
    return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  }
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    try {
      const r = await callTool(name, args);
      return { content: [{ type: 'text', text: r.text }], isError: !!r.isError };
    } catch (e) {
      return { content: [{ type: 'text', text: String(e && e.message || e) }], isError: true };
    }
  }
  if (method === 'ping') return {};
  const err = new Error(`method not found: ${method}`);
  err.code = -32601;
  throw err;
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let req;
  try { req = JSON.parse(t); } catch { return; }
  // Notifications have no id and must never get a response.
  const isNotification = req.id === undefined || req.id === null;
  try {
    const result = await handle(req);
    if (!isNotification) send({ jsonrpc: '2.0', id: req.id, result });
  } catch (e) {
    if (!isNotification) {
      send({ jsonrpc: '2.0', id: req.id, error: { code: e.code || -32603, message: String(e && e.message || e) } });
    }
  }
});
