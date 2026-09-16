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
import { fetchMaybePaid, payEnabled, budget, WALLET_ENV_NAMES } from './pay.mjs';

// ★ ONE PLACE. The version was hardcoded in three: the user-agent said 1.1 while
//   package.json said 1.5.1 and serverInfo said 1.5.1. The UA is not cosmetic -
//   the gateway resolves attribution from it, and a stale one made "which build
//   is actually calling us" unanswerable from the ledger.
const VERSION = '1.7.0';

const BASE = (process.env.X402_BASE || 'https://x402.donnyautomation.com').replace(/\/$/, '');

// ══ ATTRIBUTION ════════════════════════════════════════════════════════════
//
// WHY THIS HEADER EXISTS. The 2026-08-04 -> 08-25 cycle closed with 4 settled
// external calls from 3 wallets and NO WAY TO SAY WHERE ANY OF THEM CAME FROM.
// The gateway now records a `src` bucket on every ledger row; this is the client
// half of that sensor. Without it, a payer arriving through this npm package is
// indistinguishable from one who found the origin by other means, and the cycle
// cannot answer the only question it exists to ask.
//
// `npm-client` is a member of the gateway's CLOSED enum (SRC_BUCKETS in
// server.js). Do not invent a new value here: an unrecognised tag is recorded as
// `unknown` with `srcRejected` set, so a typo reads as silence, not as an error.
//
// The user-agent is the FALLBACK for the same question and must keep matching
// the gateway's CLIENT_PATTERNS entry /^dex-data-mcp\//i - so the package name
// and the trailing slash are load-bearing, not decoration.
const SRC_TAG = 'npm-client';
const USER_AGENT = `dex-data-mcp/${VERSION} (+https://github.com/donnywin85/dex-data-mcp)`;
const TIMEOUT_MS = Number(process.env.DEX_MCP_TIMEOUT_MS || 45000);
// ══ THE TOOL LIST IS THE CATALOGUE ═════════════════════════════════════════
//
// Every tool below targets ONE route that the gateway actually lists at
// /.well-known/x402, and there is a tool for every one of them. Nothing else.
//
// WHY IT SHRANK FROM 23 TO 13. Until 1.7.0 this server offered a tool per
// product family across six chains — geocoding, weather, search, holidays, RSS,
// IP lookup — because the gateway sold 62 priced routes and the coverage gate
// asked for all of them. Then the demand was measured. Over the whole recorded
// history, 12 of those 62 routes have either organic buyers or no substitute
// anywhere in the catalogue; the other 50 have between zero and two calls each,
// and every one of those calls came from a single wallet.
// (`x402-gateway/artifacts/x402-catalogue-focus-001/KEEP.md`, the keep rule
// computed before any file was edited.) On 2026-09-16 the storefront was cut to
// those 12. This file follows it, because a tool list that advertises a shelf
// the storefront no longer stocks is a menu with the kitchen closed: the agent
// spends a turn discovering the gap, and every extra tool costs context in every
// session whether or not it is ever called.
//
// The 50 dropped routes ARE STILL SERVED and still payable at list price by
// anyone holding the URL. Removing a tool withdrew a recommendation; it did not
// withdraw a product.
//
// RETIRING ROUTES. `geocode`, `reverse_geocode` and `get_weather` are gone for a
// second, independent reason: the upstreams behind them retire 2026-09-27. A
// tool that will 404 in eleven days should not ship in a release today.
//
// PRICES ARE IN THE DESCRIPTIONS ON PURPOSE. An agent choosing between tools is
// choosing how to spend its principal's money, and it cannot weigh a cost it has
// to make a call to discover. Each price below is the route's `x-payment-info`
// from the gateway's own openapi.json, read 2026-09-16 — not a constant kept in
// step by hand.
//
// FREE FIRST, THEN PAID. Every route here grants 25 free calls per day with no
// wallet, no signup and no key. After that it answers 402, and this server pays
// it ONLY if a wallet is configured and every spend cap allows it. See pay.mjs.

const FREE_TIER_NOTE = 'First 25 calls/day are free — no wallet, no signup, no key.';

const TOOLS = [
  // ── DEX market data ──────────────────────────────────────────────────────
  {
    name: 'get_base_liquidity',
    description:
      'DEX liquidity, market depth and TVL for a trading pair on BASE, broken down by venue. '
      + 'Returns per-venue USD liquidity, the pools backing it and the total, so you can tell a '
      + 'quote backed by a deep pool from one backed by dust. '
      + `$0.01 USDC per call after the free tier. ${FREE_TIER_NOTE} `
      + 'Example: pair="WETH/USDC".',
    inputSchema: {
      type: 'object',
      properties: {
        pair: { type: 'string', description: 'Token pair as SYM/SYM on Base, e.g. WETH/USDC.' },
      },
      required: ['pair'],
    },
    route: (a) => `/base/liquidity?pair=${encodeURIComponent(a.pair)}`,
    priceUsd: 0.01,
  },
  {
    name: 'get_polygon_token_price',
    description:
      'Live USD price of a token on POLYGON PoS, read from DEX pools at call time rather than '
      + 'from a cached feed. Returns the price, the pair it was priced through, the USD liquidity '
      + 'backing that quote and a confidence rating; refuses to return a price backed by a dust '
      + 'pool instead of reporting an unreliable number. '
      + `$0.01 USDC per call after the free tier. ${FREE_TIER_NOTE} `
      + 'Example: symbol="WMATIC".',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Token symbol on Polygon PoS, e.g. WMATIC, WETH, WBTC, USDC, USDT, DAI, LINK.',
        },
      },
      required: ['symbol'],
    },
    route: (a) => `/polygon/price?symbol=${encodeURIComponent(a.symbol)}`,
    priceUsd: 0.01,
  },
  {
    name: 'get_avalanche_pool_reserves',
    description:
      'Raw AMM pool reserves and live pool state for a pair on AVALANCHE C-Chain: both token '
      + 'balances, the pool fee in bps, the implied price from those reserves and the pool TVL, '
      + 'all read at one block height which is returned with the answer. This is the underlying '
      + 'data the price and depth tools are derived from — use it when you need to compute your '
      + 'own, or to audit a quote against the chain. '
      + `$0.01 USDC per call after the free tier. ${FREE_TIER_NOTE} `
      + 'Example: pair="WAVAX/USDC".',
    inputSchema: {
      type: 'object',
      properties: {
        pair: { type: 'string', description: 'Token pair as SYM/SYM on Avalanche C-Chain, e.g. WAVAX/USDC.' },
      },
      required: ['pair'],
    },
    route: (a) => `/avalanche/reserves?pair=${encodeURIComponent(a.pair)}`,
    priceUsd: 0.01,
  },
  {
    name: 'find_polygon_arbitrage',
    description:
      'Scan POLYGON PoS for cross-venue arbitrage right now: pairs whose price differs enough '
      + 'between DEX venues to be worth acting on, ranked by gross spread. Returns the pair, the '
      + 'cheap and expensive venue, the spread in bps and the liquidity on each side. Gross, not '
      + 'net — gas and slippage are yours to subtract. '
      + `$0.01 USDC per call after the free tier. ${FREE_TIER_NOTE} `
      + 'Example: minSpreadBps=25.',
    inputSchema: {
      type: 'object',
      properties: {
        minSpreadBps: { type: 'number', description: 'Minimum gross spread to report, in basis points. Default 10.' },
        minVenueTvlUsd: { type: 'number', description: 'Ignore venues thinner than this, in USD. Default 1000.' },
        limit: { type: 'number', description: 'Maximum opportunities returned.' },
      },
    },
    route: (a) => `/polygon/scan?${scanQuery(a)}`,
    priceUsd: 0.01,
  },
  {
    name: 'find_avalanche_arbitrage',
    description:
      'Scan AVALANCHE C-Chain for cross-venue arbitrage right now: pairs whose price differs '
      + 'enough between DEX venues to be worth acting on, ranked by gross spread. Returns the '
      + 'pair, the cheap and expensive venue, the spread in bps and the liquidity on each side. '
      + 'Gross, not net — gas and slippage are yours to subtract. '
      + `$0.01 USDC per call after the free tier. ${FREE_TIER_NOTE} `
      + 'Example: minSpreadBps=25.',
    inputSchema: {
      type: 'object',
      properties: {
        minSpreadBps: { type: 'number', description: 'Minimum gross spread to report, in basis points. Default 10.' },
        minVenueTvlUsd: { type: 'number', description: 'Ignore venues thinner than this, in USD. Default 1000.' },
        limit: { type: 'number', description: 'Maximum opportunities returned.' },
      },
    },
    route: (a) => `/avalanche/scan?${scanQuery(a)}`,
    priceUsd: 0.01,
  },
  {
    name: 'get_v4_hook_risk',
    description:
      'Uniswap v4 HOOK SECURITY SCAN on Base: decode a hook contract before routing a trade '
      + 'through it. Decodes all 14 hook permission bits from the address (v4-core Hooks.sol), '
      + 'flags swap custody, fee-taking and EIP-1967 upgradeable hooks, and verifies source via '
      + 'Basescan/Sourcify/Blockscout consensus. Returns a custody class '
      + '(PASSIVE | FLOW_CONTROL | FEE_TAKING | SWAP_CUSTODY | OPAQUE), risk flags and the '
      + 'verification state. It is capability analysis and NEVER outputs SAFE: it tells you what '
      + 'the hook is able to do to your trade, not whether its author intends to. '
      + `$0.01 USDC per call after the free tier. ${FREE_TIER_NOTE} `
      + 'Example: address="0x0000000000000000000000000000000000000080".',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Uniswap v4 hook contract address on Base mainnet, 0x + 40 hex characters.',
        },
      },
      required: ['address'],
    },
    route: (a) => `/v4hooks?address=${encodeURIComponent(a.address)}`,
    priceUsd: 0.01,
  },

  // ── Counterparty and reference data ──────────────────────────────────────
  {
    name: 'lookup_lei',
    description:
      'Look up a company in the GLEIF Legal Entity Identifier golden copy BY NAME, not just by '
      + 'identifier — knowing the LEI already is the hard part. Returns the LEI, registered legal '
      + 'name, previous names, legal form, jurisdiction, legal and headquarters addresses and the '
      + 'registration record. Lapsed, retired and annulled entities come back FLAGGED rather than '
      + 'filtered out: a hidden record and no record are indistinguishable to the caller. '
      + `$0.03 USDC per call after the free tier. ${FREE_TIER_NOTE} `
      + 'Example: q="Apple Inc.".',
    inputSchema: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          description: 'Legal entity name, max 200 chars. A bare brand name works — "Apple" finds Apple Inc. Results are ranked across the legal name and any alternative names.',
        },
        lei: { type: 'string', description: 'Exact 20-character LEI, for a single record instead of a name search.' },
        limit: { type: 'number', description: 'Maximum name-search results, 1..50. Default 10.' },
      },
    },
    // A name OR an identifier — an AND-only `required` list cannot say that.
    requireOneOf: ['q', 'lei'],
    route: (a) => (a.lei
      ? `/lei?lei=${encodeURIComponent(a.lei)}`
      : `/lei?q=${encodeURIComponent(a.q || '')}${a.limit != null ? `&limit=${encodeURIComponent(a.limit)}` : ''}`),
    priceUsd: 0.03,
  },
  {
    name: 'get_company_dossier',
    description:
      'COUNTERPARTY DOSSIER for one legal entity in a single call: who it is (GLEIF), whether it '
      + 'is sanctioned (OFAC name screening) and whether it is an SEC registrant, joined and '
      + 'returned together. Use this instead of calling lookup_lei and screening separately when '
      + 'the question is "can we deal with this party". A name match is a REVIEW ITEM, never a '
      + 'determination — the score and the matched alias come back with it. '
      + `$0.05 USDC per call after the free tier. ${FREE_TIER_NOTE} `
      + 'Example: q="Apple Inc." or ticker="AAPL".',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Legal entity name, max 200 chars. Include the suffix for a precise match, e.g. "Apple Inc." rather than "Apple".' },
        lei: { type: 'string', description: 'Exact 20-character LEI, for an unambiguous subject. Use instead of q.' },
        ticker: { type: 'string', description: 'Exchange ticker, e.g. AAPL. Resolves the SEC block directly and supplies the registered name to search GLEIF with.' },
        cik: { type: 'string', description: 'SEC Central Index Key, 1 to 10 digits. Alternative to ticker; cik wins if both are sent.' },
        minScore: { type: 'number', description: 'OFAC name-match threshold 0.1..1, default 0.85. 1.0 is an exact name-token match. Lower it to WIDEN the review set, never to narrow it.' },
      },
    },
    requireOneOf: ['q', 'lei', 'ticker', 'cik'],
    route: (a) => `/company?${companyQuery(a)}`,
    priceUsd: 0.05,
  },
  {
    name: 'get_treasury_yield_curve',
    description:
      'US Treasury par yield curve: the full set of constant-maturity rates for one business day, '
      + 'from 1 month to 30 years, as published by the Treasury. The risk-free curve behind any '
      + 'discounting, spread or carry calculation. A non-publication date returns 404 with the '
      + 'available range rather than the nearest guess. '
      + `$0.03 USDC per call after the free tier. ${FREE_TIER_NOTE} `
      + 'Example: no arguments for the latest curve, or date="2026-09-02".',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD business day, for a specific past day. Omit for the most recent published curve.' },
      },
    },
    route: (a) => (a.date ? `/treasury?date=${encodeURIComponent(a.date)}` : '/treasury?latest=1'),
    priceUsd: 0.03,
  },

  // ── SEC EDGAR change oracles ─────────────────────────────────────────────
  //
  // All three are DELTAS, not dumps. `since` is a required, INCLUSIVE cursor:
  // pass the date you last read and you get what has landed since. That is the
  // whole product — polling EDGAR yourself means fetching the same index over
  // and over to find the one line that changed.
  {
    name: 'get_sec_filings',
    description:
      'SEC EDGAR FILING CHANGE ORACLE for one issuer: everything this company has filed with the '
      + 'SEC since your cursor, as a delta rather than a dump. Returns accession number, form '
      + 'type, filing and period dates, and the document URL. Amendments are matched with their '
      + 'original (10-K also matches 10-K/A). Reports `matched` and `truncated` so a cut-off delta '
      + 'is never mistaken for a complete one. '
      + `$0.05 USDC per call after the free tier. ${FREE_TIER_NOTE} `
      + 'Example: ticker="AAPL", since="2026-09-01", forms="8-K".',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Exchange ticker, e.g. AAPL. Send cik instead when you have it: cik is EDGAR identity, ticker is a convenience. If both are sent, cik wins.' },
        since: { type: 'string', description: 'ISO date YYYY-MM-DD. INCLUSIVE cursor: filings on this date are returned. Required — this route returns a delta, not a dump.' },
        cik: { type: 'string', description: 'SEC Central Index Key, 1 to 10 digits, zero padding optional (e.g. 320193 or 0000320193). Alternative to ticker.' },
        forms: { type: 'string', description: 'Comma separated form filter, e.g. "10-K,10-Q,8-K". A form also matches its /A amendment; "8-K/A" alone matches only amendments.' },
        limit: { type: 'number', description: 'Maximum filings returned, 1 to 200. Default 50.' },
      },
      required: ['since'],
    },
    requireOneOf: ['ticker', 'cik'],
    route: (a) => `/edgar/filings?${edgarQuery(a, 'forms')}`,
    priceUsd: 0.05,
  },
  {
    name: 'get_sec_events',
    description:
      'SEC EDGAR MATERIAL EVENT ORACLE for one issuer: which material events this company has '
      + 'reported since your cursor, decoded from its 8-K item codes rather than left as raw '
      + 'filings. Returns the item code, what it means, and the filing it came from. Filter to the '
      + 'events you care about — 1.01 material agreement, 5.02 officer departure, 2.06 impairment. '
      + 'A malformed code returns 400 bad_items rather than being silently ignored. '
      + `$0.05 USDC per call after the free tier. ${FREE_TIER_NOTE} `
      + 'Example: ticker="TSLA", since="2026-09-01", items="5.02".',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Exchange ticker, e.g. TSLA. Send cik instead when you have it. If both are sent, cik wins.' },
        since: { type: 'string', description: 'ISO date YYYY-MM-DD. INCLUSIVE cursor: events filed on this date are returned. Required — this route returns a delta, not a dump.' },
        cik: { type: 'string', description: 'SEC Central Index Key, 1 to 10 digits (e.g. 1318605). Alternative to ticker.' },
        items: { type: 'string', description: 'Comma separated 8-K item codes to filter on, e.g. "1.01,5.02,2.06". A filing matches if it carries ANY of them.' },
        limit: { type: 'number', description: 'Maximum events returned, 1 to 200. Default 50.' },
      },
      required: ['since'],
    },
    requireOneOf: ['ticker', 'cik'],
    route: (a) => `/edgar/events?${edgarQuery(a, 'items')}`,
    priceUsd: 0.05,
  },
  {
    name: 'get_sec_insiders',
    description:
      'SEC EDGAR OWNERSHIP CHANGE ORACLE for one issuer: who has reported a change in their '
      + 'position since your cursor. Covers Forms 3, 4, 5, SC 13D and SC 13G and nothing outside '
      + 'that set. Returns the reporting owner, their relationship to the issuer, the form and the '
      + 'filing. An amendment is matched with its original and is NOT a second transaction. Active '
      + 'issuers file many Form 4s, so `matched` and `truncated` tell you when you hit the cap. '
      + `$0.05 USDC per call after the free tier. ${FREE_TIER_NOTE} `
      + 'Example: ticker="NVDA", since="2026-09-01", forms="4".',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Exchange ticker, e.g. NVDA. Send cik instead when you have it. If both are sent, cik wins.' },
        since: { type: 'string', description: 'ISO date YYYY-MM-DD. INCLUSIVE cursor: ownership filings on this date are returned. Required — this route returns a delta, not a dump.' },
        cik: { type: 'string', description: 'SEC Central Index Key, 1 to 10 digits (e.g. 1045810). Alternative to ticker.' },
        forms: { type: 'string', description: 'Comma separated filter within the ownership set, e.g. "4" or "SC 13D". A form also matches its /A amendment.' },
        limit: { type: 'number', description: 'Maximum filings returned, 1 to 200. Default 50.' },
      },
      required: ['since'],
    },
    requireOneOf: ['ticker', 'cik'],
    route: (a) => `/edgar/insiders?${edgarQuery(a, 'forms')}`,
    priceUsd: 0.05,
  },

  // ── Local, free, no network ──────────────────────────────────────────────
  {
    name: 'get_spend_budget',
    description:
      'How much this session has spent on paid calls, and the caps in force. Free, local, no '
      + 'network: it makes the cost of continuing visible BEFORE it is incurred. Call it first if '
      + 'you are about to run a loop over paid tools.',
    inputSchema: { type: 'object', properties: {} },
    local: () => budget(),
  },
];

// ── Query builders ─────────────────────────────────────────────────────────
//
// Kept out of the tool objects so each `route` stays one readable line, and so
// the "omit what the caller omitted" rule is written once. An `undefined`
// interpolated into a query string becomes the literal text "undefined", which
// the gateway then answers — and charges for. [derive-or-delete]
function put(qs, key, value) {
  if (value === undefined || value === null || value === '') return;
  qs.set(key, String(value));
}

function scanQuery(a) {
  const qs = new URLSearchParams();
  // minSpreadBps is required upstream and must always be present: a scan URL with
  // no query at all also loses the free tier, which the gateway grants only to
  // requests carrying a parameter.
  qs.set('minSpreadBps', String(a.minSpreadBps ?? 10));
  put(qs, 'minVenueTvlUsd', a.minVenueTvlUsd);
  put(qs, 'limit', a.limit);
  return qs.toString();
}

function companyQuery(a) {
  const qs = new URLSearchParams();
  // cik wins over ticker upstream; send exactly what the caller gave and let the
  // gateway apply its own precedence rather than second-guessing it here.
  for (const k of ['q', 'lei', 'ticker', 'cik', 'minScore']) put(qs, k, a[k]);
  return qs.toString();
}

function edgarQuery(a, filterKey) {
  const qs = new URLSearchParams();
  for (const k of ['ticker', 'cik', 'since', filterKey, 'limit']) put(qs, k, a[k]);
  return qs.toString();
}

// The paid routes sit behind an x402 paywall. Without a wallet an MCP client gets
// a 402, so say exactly that and what it costs, rather than surfacing a bare HTTP
// error the model has to guess at.
function paywallMessage(tool, url, reason) {
  const b = budget();
  // ★ SAY WHAT IT COSTS AND WHEN IT COMES BACK. Every tool in 1.7.0 has a free
  //   tier, so a 402 here always means TODAY's allowance is spent and always
  //   resets — there is no longer a paid-only tool whose 402 is permanent, and
  //   promising a reset that never comes is the failure this text avoids.
  //   The price is the tool's own declared price, not a constant: quoting $0.01
  //   at an /edgar route would understate it fivefold. [derive-or-delete]
  const lines = [
    `Daily free allowance used up for this caller, so this call needs payment: `
    + `$${tool.priceUsd.toFixed(2)} USDC on Base.`,
    '',
    `  ${url}`,
    '',
    'The allowance resets every 24h. Always free, and never a network call:',
    '  get_spend_budget - what this session has spent and the caps in force',
    '',
  ];
  if (payEnabled()) {
    lines.push(`A wallet IS configured, but this call was not paid: ${reason || 'unknown'}.`,
      `Budget so far: $${b.spentUsd} of $${b.maxSpendUsd} across ${b.calls} paid call(s).`,
      'Raise DEX_MAX_SPEND_USD / DEX_MAX_PRICE_USD / DEX_MAX_CALLS to allow more.');
  } else {
    // NAME THE VARIABLE. "Configure a wallet" is not actionable; a variable name
    // and a shape are. Both accepted names are printed because a user arriving
    // from bsc-dex-spread-mcp already has the second one set.
    lines.push('To enable payment, set ONE of these to a funded wallet private key:',
      ...WALLET_ENV_NAMES.map((n) => `  ${n}=0x<64 hex chars>`),
      '',
      'Set it in your MCP client\'s server config for this package (the "env" block),',
      'then calls pay themselves with x402 - USDC on Base, no ETH needed.',
      'Fund it with a few dollars of USDC on Base and NOTHING else: the key sits in',
      'that config in plaintext, so use a burner wallet, never a main one.',
      '',
      'Spend is capped and fails closed: DEX_MAX_SPEND_USD (default $1 total),',
      'DEX_MAX_PRICE_USD (default $0.05/call) and DEX_MAX_CALLS (default 200).');
  }
  return lines.join('\n');
}

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  const a = args || {};
  // ★ NO `chain` ARGUMENT, AND NO CHAIN PREFIXING, SINCE 1.7.0.
  //
  //   Until 1.6.1 a tool named a product family (/price) and took a `chain`
  //   argument that the handler turned into a path prefix (/polygon/price). That
  //   made one tool stand for six URLs, of which the gateway now lists one — so
  //   five of the six choices an agent could make led somewhere unlisted, and
  //   the tool could not state a price because each chain was a separate
  //   resource. Every tool now targets exactly ONE listed route and writes the
  //   whole path itself. `chain` is gone from every schema; a client still
  //   sending one is told so rather than having it silently ignored.
  if (a.chain !== undefined) {
    throw new Error(
      `${name} takes no "chain" argument: each tool targets one chain's route. `
      + 'Pick the tool for the chain you want. Nothing was requested and nothing was spent.',
    );
  }
  if (tool.local) return { text: JSON.stringify(tool.local(), null, 2), isError: false };

  // ★ REQUIRED ARGUMENTS ARE ENFORCED HERE, NOT MERELY DECLARED.
  //
  //   Every tool publishes inputSchema.required and nothing ever checked it. A
  //   call omitting one interpolated `undefined` straight into the route:
  //   get_token_price with no token produced
  //
  //       https://x402.donnyautomation.com/price?symbol=undefined
  //
  //   and then FETCHED it. That spends a free-tier call, and with DEX_WALLET_KEY
  //   configured it spends real USDC — on a query that cannot return an answer.
  //   The spec expects clients to validate against the schema, but a model-driven
  //   client dropping an argument is the ordinary case, not the exotic one, and
  //   the cost of trusting it lands here.
  //
  //   Empty string counts as missing: `?symbol=` is exactly as unanswerable as
  //   `?symbol=undefined`, and would be paid for just the same.
  const given = (k) => !(a[k] === undefined || a[k] === null || a[k] === '');
  const required = tool.inputSchema?.required || [];
  const missing = required.filter((k) => !given(k));
  if (missing.length) {
    const describe = (k) => `${k}: ${tool.inputSchema?.properties?.[k]?.description || 'required'}`;
    throw new Error(
      `${name} needs ${missing.map((m) => `"${m}"`).join(', ')}, `
      + `which ${missing.length > 1 ? 'were' : 'was'} not provided. Nothing was requested and nothing was spent.\n  `
      + missing.map(describe).join('\n  '),
    );
  }
  // ★ "One of these" cannot be said with inputSchema.required, which is an AND.
  //   lookup_lei takes a name OR an identifier, so it declares neither as
  //   required — and a bare call sailed through the check above and requested
  //   /lei?q=, which the gateway answers 400 missing_query. A paid-for 400.
  //   requireOneOf closes the gap that expressing the constraint in the schema
  //   cannot.
  if (tool.requireOneOf && !tool.requireOneOf.some(given)) {
    throw new Error(
      `${name} needs one of ${tool.requireOneOf.map((k) => `"${k}"`).join(' or ')}. `
      + 'Nothing was requested and nothing was spent.\n  '
      + tool.requireOneOf.map((k) => `${k}: ${tool.inputSchema?.properties?.[k]?.description || ''}`).join('\n  '),
    );
  }

  // The route template writes the whole path, prefix included. There is nothing
  // left for the handler to rewrite, which is the point: the URL a tool requests
  // is the URL its description names and the URL the gateway lists.
  const url = `${BASE}${tool.route(a)}`;

  // Identify the client so usage is attributable to this npm package rather than
  // lost among anonymous traffic - this is how we learn which channel works.
  // Both surfaces are sent: the header is authoritative, the user-agent is the
  // gateway's fallback if a proxy ever strips it. See SRC_TAG above.
  const headers = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
    'x-402-source': SRC_TAG,
  };

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
      serverInfo: { name: 'dex-data', version: VERSION },
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

// ★ WHICH GATEWAY ROUTES DOES THIS BUILD ACTUALLY TARGET?
//
//   The coverage gate has to answer that, and it used to answer it by running a
//   regex over this file's source. A regex reads what the source LOOKS like; a
//   route is what the function RETURNS. Those diverged the moment routes stopped
//   being one template literal each — a path assembled from a helper is
//   invisible to the regex, so a tool could target an unlisted route and the
//   gate would report it as covered. So ask the route functions themselves.
//
//   Runs and exits BEFORE readline is attached, so it cannot interfere with a
//   real MCP session, and it makes no network call.
if (process.env.DEX_MCP_DUMP_ROUTES) {
  for (const t of TOOLS) {
    // Local tools have no route at all; say so rather than omitting them, or a
    // reconciliation cannot tell "no route" from "tool missing".
    if (!t.route) { process.stdout.write(`${t.name}\t(local)\n`); continue; }
    // Arguments are irrelevant to the PATH: every tool puts its arguments in the
    // query string, so the path is fixed. Call with an empty object and cut at
    // the '?'.
    process.stdout.write(`${t.name}\t${t.route({}).split('?')[0]}\n`);
  }
  process.exit(0);
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
