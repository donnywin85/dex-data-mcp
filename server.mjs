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
    name: 'geocode',
    description:
      'Convert a street address, city or place name to latitude/longitude coordinates — worldwide, '
      + 'via OpenStreetMap. Returns coordinates, display name, structured address parts and a '
      + 'confidence score. No match returns a clear 404, never a guessed coordinate.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Address or place name, e.g. "Eiffel Tower, Paris".' } },
      required: ['query'],
    },
    route: (a) => `/geocode?q=${encodeURIComponent(a.query)}`,
  },
  {
    name: 'reverse_geocode',
    description:
      'Convert latitude/longitude coordinates to the nearest street address and place name — '
      + 'worldwide, via OpenStreetMap. Coordinates in the ocean or unmapped return 404, never a '
      + 'fabricated address.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude, -90..90.' },
        lon: { type: 'number', description: 'Longitude, -180..180.' },
      },
      required: ['lat', 'lon'],
    },
    route: (a) => `/reverse-geocode?lat=${encodeURIComponent(a.lat)}&lon=${encodeURIComponent(a.lon)}`,
  },
  {
    name: 'get_random',
    description:
      'Cryptographically secure randomness for agents that are deterministic or sandboxed and cannot '
      + 'generate their own: uniform integers in [min, max] (rejection-sampled, no modulo bias) or raw '
      + 'random bytes as hex and base64. For nonces, IDs, sampling and shuffling.',
    inputSchema: {
      type: 'object',
      properties: {
        bytes: { type: 'number', description: 'Random bytes to return, 1..1024. Default 32 when no integer range is given.' },
        min: { type: 'number', description: 'With max: return uniform integers in [min, max] inclusive.' },
        max: { type: 'number', description: 'Upper bound (inclusive) for integer mode.' },
        count: { type: 'number', description: 'How many integers, 1..1000. Integer mode only.' },
      },
    },
    // Always send at least one parameter: a bare path reads as a catalogue
    // crawler to the gateway and is routed to the paywall instead of free tier.
    route: (a) => {
      const q = ['bytes', 'min', 'max', 'count']
        .filter((k) => a[k] != null)
        .map((k) => `${k}=${encodeURIComponent(a[k])}`);
      return `/random?${q.length ? q.join('&') : 'bytes=32'}`;
    },
  },
  {
    name: 'url_to_markdown',
    description:
      'Fetch a public article or PDF URL and return clean Markdown plus title, byline, site name and '
      + 'word count. HTML is extracted with Firefox reader-mode rules; PDFs return their text layer '
      + 'with page count. Image-only PDFs and client-rendered app shells return typed errors '
      + '(no_text_layer, not_extractable) instead of empty output passed off as the article.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Public http(s) URL of an article or PDF.' } },
      required: ['url'],
    },
    route: (a) => `/markdown?url=${encodeURIComponent(a.url)}`,
  },
  {
    name: 'search',
    description:
      'Web search — a free-text query returns ranked organic results, each with title, real '
      + 'destination URL, display URL and snippet. Sponsored rows are excluded. Up to 25 results; '
      + 'count is a maximum, not a guarantee, because a row whose destination cannot be resolved is '
      + 'dropped rather than guessed at. Results are not fetched or verified — pair with '
      + 'url_to_markdown to read any result.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search terms, max 500 characters.' },
        count: { type: 'number', description: 'Maximum results, 1..25. Default 10.' },
      },
      required: ['q'],
    },
    route: (a) => `/search?q=${encodeURIComponent(a.q)}`
      + (a.count != null ? `&count=${encodeURIComponent(a.count)}` : ''),
  },
  {
    name: 'get_weather',
    description:
      'Current weather and up to a 7-day forecast for any coordinates worldwide: temperature, '
      + 'feels-like, humidity, precipitation, wind speed/gusts/direction now, plus daily highs, lows '
      + 'and precipitation probability. Model forecast, not a station reading — the response says so. '
      + 'Use the geocode tool first if you have a place name rather than coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude, -90..90.' },
        lon: { type: 'number', description: 'Longitude, -180..180.' },
        days: { type: 'number', description: 'Forecast days, 1..7. Default 3.' },
      },
      required: ['lat', 'lon'],
    },
    route: (a) => `/weather?lat=${encodeURIComponent(a.lat)}&lon=${encodeURIComponent(a.lon)}`
      + (a.days != null ? `&days=${encodeURIComponent(a.days)}` : ''),
  },
  // ---- second wave: chosen from seller-level x402 receipts ----------------
  // The category totals the gateway's radar produced turned out to be
  // double-counted — the biggest sellers carry 10-16 of the 16 category tags
  // each, so every category reports nearly the whole market's revenue. Seller
  // rows are clean, and these six are each sold today by a wallet that took
  // real USDC, with a free keyless upstream behind them.
  {
    name: 'get_search_suggestions',
    description:
      'What people actually type into a search box for a topic — live search autocomplete, expanded '
      + 'across question modifiers (how/what/why/is/can/does) and comparison modifiers (vs/or), then '
      + 'split into suggestions, questions and comparisons. Rows where the engine dropped your term '
      + 'and answered something else are filtered out and counted. A demand signal for content and '
      + 'keyword research, not a ranking — search volume is not published upstream and is not invented.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Topic or search terms, max 200 characters.' },
        depth: { type: 'string', enum: ['full', 'basic'], description: '"full" (default) expands across 15 modifiers; "basic" returns completions for the query alone.' },
        country: { type: 'string', description: 'Two-letter market code, default "us".' },
        lang: { type: 'string', description: 'Language code, default "en".' },
      },
      required: ['q'],
    },
    route: (a) => `/suggest?q=${encodeURIComponent(a.q)}`
      + (a.depth ? `&depth=${encodeURIComponent(a.depth)}` : '')
      + (a.country ? `&country=${encodeURIComponent(a.country)}` : '')
      + (a.lang ? `&lang=${encodeURIComponent(a.lang)}` : ''),
  },
  {
    name: 'get_holidays',
    description:
      'Public and bank holidays for 100+ countries, and the business-day question behind them. Pass a '
      + 'date and it answers directly whether that date is a business day and what the next and '
      + 'previous ones are, counting weekends and holidays and walking across year boundaries. Without '
      + 'a date it returns the whole year, including which regions observe a non-national holiday. '
      + 'Regional closures, half-days and market trading calendars are not covered.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'ISO 3166-1 alpha-2 country code, e.g. US, GB, DE, JP.' },
        date: { type: 'string', description: 'YYYY-MM-DD. Adds isBusinessDay plus next/previous business days.' },
        year: { type: 'number', description: 'Calendar year 1975..2100. Default: current year. Ignored when date is given.' },
      },
      required: ['country'],
    },
    route: (a) => `/holidays?country=${encodeURIComponent(a.country)}`
      + (a.date ? `&date=${encodeURIComponent(a.date)}` : '')
      + (a.year != null ? `&year=${encodeURIComponent(a.year)}` : ''),
  },
  {
    name: 'read_feed',
    description:
      'Read any public RSS, Atom or RDF feed as clean JSON: feed title, link and description, then '
      + 'items with title, real destination link, author, categories and the published date both '
      + 'verbatim and normalised to ISO 8601. Each summary is returned twice — the feed HTML as '
      + 'published, and a plain-text rendering safe to put straight into a prompt. An unparseable date '
      + 'is null, never an invented timestamp. Pair with url_to_markdown to read a linked article.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public http(s) URL of an RSS 2.0, Atom or RDF feed.' },
        limit: { type: 'number', description: 'Maximum items, 1..100. Default 20.' },
      },
      required: ['url'],
    },
    route: (a) => `/feed?url=${encodeURIComponent(a.url)}`
      + (a.limit != null ? `&limit=${encodeURIComponent(a.limit)}` : ''),
  },
  {
    name: 'geolocate_ip',
    description:
      'Locate a public IPv4 or IPv6 address: country, region, city, postcode, coordinates, timezone, '
      + 'ASN, org and ISP. Datacentre/VPN/proxy/Tor detection is returned FIRST because it decides '
      + 'whether the location means anything — and when the upstream does not supply that detection '
      + 'the answer says unknown, never clean. An IP locates a network, not a person: the coordinates '
      + 'are a registered-range centroid, so never present them as where someone is.',
    inputSchema: {
      type: 'object',
      properties: { ip: { type: 'string', description: 'Public IPv4 or IPv6 address. Private and reserved ranges are refused.' } },
      required: ['ip'],
    },
    route: (a) => `/ip?ip=${encodeURIComponent(a.ip)}`,
  },
  {
    name: 'lookup_lei',
    description:
      'Look up a company in the GLEIF Legal Entity Identifier golden copy BY NAME, not just by '
      + 'identifier — knowing the LEI already is the hard part. Returns the LEI, registered legal '
      + 'name, previous names, legal form, jurisdiction, legal and headquarters addresses and the '
      + 'registration record. Lapsed, retired and annulled entities come back flagged rather than '
      + 'filtered out: a hidden record and no record are indistinguishable to the caller.',
    inputSchema: {
      type: 'object',
      properties: {
        // The old text here read "include the suffix for precision, e.g. Apple
        // Inc." — advice that only existed because the search ranked a street
        // address above the company. Results are ranked now, so a bare brand
        // name works and the instruction to already know the answer is gone.
        q: { type: 'string', description: 'Legal entity name, max 200 chars. A bare brand name works — "Apple" finds Apple Inc. Results are ranked by name match across the legal name and any alternative names.' },
        lei: { type: 'string', description: 'Exact 20-character LEI, for a single record instead of a name search.' },
        limit: { type: 'number', description: 'Maximum name-search results, 1..50. Default 10.' },
      },
    },
    // A name OR an identifier — an AND-only `required` list cannot say that.
    requireOneOf: ['q', 'lei'],
    route: (a) => (a.lei
      ? `/lei?lei=${encodeURIComponent(a.lei)}`
      : `/lei?q=${encodeURIComponent(a.q || '')}${a.limit != null ? `&limit=${encodeURIComponent(a.limit)}` : ''}`),
  },
  {
    name: 'get_treasury_yield_curve',
    description:
      'The US Treasury par yield curve for any published business day — every constant-maturity rate '
      + 'from 1 month to 30 years — plus the spreads and the inversion flag, because the real question '
      + 'is whether the curve is inverted rather than what fourteen numbers are. 2s10s, 3m10y and '
      + '5s30s are computed for you. A tenor Treasury did not publish that day is null, never zero. '
      + 'Nominal CMT rates: not real yields and not zero-coupon spot rates.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD business day. Default: the latest published curve. A non-publication day returns the available range, not a nearest guess.' },
      },
    },
    // A bare path reads as a catalogue crawler upstream and is routed to the
    // paywall rather than the free tier, so the no-date case still sends a
    // parameter. Same reason as get_random's bytes=32 default.
    route: (a) => (a.date ? `/treasury?date=${encodeURIComponent(a.date)}` : '/treasury?latest=1'),
  },
  {
    name: 'get_spend_budget',
    description: 'How much this session has spent on paid calls, and the caps in force. '
      + 'Free, local, and makes the cost of continuing visible before it is incurred.',
    inputSchema: { type: 'object', properties: {} },
    local: () => budget(),
  },
  {
    name: 'get_pool_reserves',
    description:
      'Raw pool reserves for a pair on every indexed venue: the two token balances, the pool fee in '
      + 'bps, the implied price from those reserves and the pool TVL, all read at one block height '
      + 'which is returned with the answer. This is the underlying data the price, depth and slippage '
      + 'tools are computed from — use it when you want to do your own maths rather than take ours.',
    inputSchema: {
      type: 'object',
      properties: {
        pair: { type: 'string', description: 'Pair as SYM/SYM, e.g. WBNB/USDT. Either side may be a 0x address.' },
        chain: chainProp,
      },
      required: ['pair'],
    },
    route: (a) => `/reserves?pair=${encodeURIComponent(a.pair)}`,
  },
  {
    name: 'find_arbitrage',
    description:
      'Scan a chain for cross-venue arbitrage right now: pairs whose price differs enough between '
      + 'DEXes to be worth trading, ranked by GROSS USD AT THE OPTIMAL TRADE SIZE — not by raw '
      + 'spread, because a wide spread on a tiny pool is not an opportunity. Returns an empty list '
      + 'when there is nothing, which is a real answer. Excludes gas, MEV and execution risk.',
    inputSchema: {
      type: 'object',
      properties: {
        minSpreadBps: { type: 'number', description: 'Minimum cross-venue spread in basis points. Default 20.' },
        chain: chainProp,
      },
    },
    // Always sends minSpreadBps: a parameterless request is routed to the paywall
    // as a catalogue crawler and can never reach the free tier — the defect that
    // left /gas with 3,456 challenges and one free call.
    route: (a) => `/scan?minSpreadBps=${encodeURIComponent(a.minSpreadBps ?? 20)}`,
  },
  {
    name: 'get_gas',
    description:
      'Live gas prices across BNB Chain, Polygon, Arbitrum, Base, Avalanche and Optimism, priced in '
      + 'USD and ranked cheapest-first. Returns gas price in gwei, base fee, and what a transfer, an '
      + 'ERC-20 transfer and a swap actually cost in dollars on each chain. Gwei is NOT comparable '
      + 'across chains because the gas token differs in price, so USD is the only ranking that says '
      + 'where a transaction really costs least. For bridging, routing and execution timing.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: {
          type: 'string',
          enum: ['all', ...CHAINS],
          description: 'One chain, or "all" for every chain ranked cheapest-first. Defaults to all.',
        },
      },
    },
    // Always sends chain=, never a bare /gas. The gateway treats a PARAMETERLESS
    // request as a catalogue crawler and routes it straight to the paywall, so a
    // bare call can never reach the free tier — /gas recorded 3,456 challenges
    // and exactly ONE free call before anyone noticed. A tool that cannot be
    // tried for free cannot convert.
    route: (a) => `/gas?chain=${encodeURIComponent(a.chain || 'all')}`,
    // /gas has no per-chain paths — it takes ?chain= and accepts `all`. Without
    // this the shared handler would rewrite chain into a path prefix and ask for
    // /base/gas, which 404s.
    chainInQuery: true,
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
  // Most tools express chain as a PATH PREFIX (/base/price) because that is how
  // each chain gets its own resource URL upstream. /gas is the exception: it has
  // no per-chain paths, it takes ?chain= and accepts `all`. A tool sets
  // chainInQuery to opt out of both the prefixing and the CHAINS-only check.
  const chainValues = tool.chainInQuery ? [...CHAINS, 'all'] : CHAINS;
  if (a.chain && !chainValues.includes(a.chain)) {
    throw new Error(`unknown chain "${a.chain}". Supported: ${chainValues.join(', ')}`);
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

  let route = tool.route(a);
  if (tool.fix) route = tool.fix(a, route);
  // chain is a path prefix, not a query param — that is how each chain gets its
  // own resource URL upstream. Unless the tool puts it in the query (see
  // chainInQuery): prefixing /gas produced `/base/gas`, which does not exist,
  // and every chain except the default 404'd.
  const prefix = !tool.chainInQuery && a.chain && a.chain !== 'bsc' ? `/${a.chain}` : '';
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
      serverInfo: { name: 'dex-data', version: '1.5.0' },
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
