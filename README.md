# dex-data MCP server

[![dex-data-mcp MCP server](https://glama.ai/mcp/servers/donnywin85/dex-data-mcp/badges/score.svg)](https://glama.ai/mcp/servers/donnywin85/dex-data-mcp)

---

# For an agent

Everything you need to decide whether to call this server, and what it will cost,
is in this section. Read no further unless a human is asking.

## Install

```bash
claude mcp add dex-data -- npx -y dex-data-mcp
```

Or, for any MCP host that reads a JSON config:

```json
{ "mcpServers": { "dex-data": { "command": "npx", "args": ["-y", "dex-data-mcp"] } } }
```

## Cost model

**The first 25 calls each day are free on every tool.** No wallet, no signup, no
API key, no account. The free answer is the full answer — nothing is stubbed,
truncated or degraded. What the free tier limits is how many calls you make, not
what is in them.

After 25 calls in a day, a tool returns a payment challenge instead of an answer.
If — and only if — a wallet is configured, this server settles that challenge in
USDC on Base and returns the answer. With no wallet it tells you the price and
spends nothing.

## Environment

| variable | what it does | default |
|---|---|---|
| `DEX_WALLET_KEY` | EVM private key that pays. **Omit it and this server can never spend anything.** `EVM_PRIVATE_KEY` is read as a fallback. | unset — free tier only |
| `DEX_MAX_PRICE_USD` | Per-call ceiling. A call costing more is refused **before** paying. | `0.05` |
| `DEX_MAX_SPEND_USD` | Total for the life of the process. | `1.00` |
| `DEX_MAX_CALLS` | Number of paid calls for the life of the process. | `200` |
| `DEX_MCP_TIMEOUT_MS` | Upstream request timeout. | `45000` |

The default ceiling is `$0.05`, which is exactly the dearest tool here. Lower it
below that and the `$0.05` tools stop working — deliberately, and they say so.

## The cap, and what "fails closed" means

Every paid call passes the same four gates, in this order, and any one of them
refuses without paying:

1. **No wallet** → never pays. This is the state you are in unless someone set a key.
2. **Price unreadable** → refuses. A challenge whose amount cannot be parsed is
   not treated as free or as cheap; it is treated as unknown, and unknown does
   not get paid.
3. **Price above `DEX_MAX_PRICE_USD`** → refuses, and names the price and the cap.
4. **Would cross `DEX_MAX_SPEND_USD` or `DEX_MAX_CALLS`** → refuses.

Accounting is in integer micro-USD, so a `$1.00` budget at `$0.05` a call buys
exactly 20 calls and not 19 — floating-point drift cannot quietly close the
budget early.

**Call `get_spend_budget` before any loop over paid tools.** It is free, local
and makes no network call, and it returns what has been spent and every cap in
force.

## Tools

Thirteen tools. Twelve fetch from the gateway; one is local. Each of the twelve
targets exactly one route, and together they are exactly the routes the
storefront lists — there is no hidden catalogue and no tool pointing at
something that was withdrawn.

| tool | price/call | what it returns | example |
|---|---|---|---|
| `get_base_liquidity` | $0.01 | DEX liquidity, depth and TVL per venue on Base | `{"pair":"WETH/USDC"}` |
| `get_polygon_token_price` | $0.01 | Live USD price from Polygon pools, with the backing liquidity and a confidence rating | `{"symbol":"WMATIC"}` |
| `get_avalanche_pool_reserves` | $0.01 | Raw AMM reserves, fee, implied price and TVL at one block height | `{"pair":"WAVAX/USDC"}` |
| `find_polygon_arbitrage` | $0.01 | Cross-venue price gaps on Polygon, ranked by gross spread | `{"minSpreadBps":25}` |
| `find_avalanche_arbitrage` | $0.01 | The same scan on Avalanche C-Chain | `{"minSpreadBps":25}` |
| `get_v4_hook_risk` | $0.01 | Uniswap v4 hook permission bits, custody class and verified-source consensus | `{"address":"0x…80"}` |
| `lookup_lei` | $0.03 | GLEIF legal-entity record **by name**, lapsed entities flagged not hidden | `{"q":"Apple Inc."}` |
| `get_treasury_yield_curve` | $0.03 | US Treasury par yield curve, 1 month to 30 years | `{}` for the latest |
| `get_company_dossier` | $0.05 | Identity, OFAC screening and SEC registration for one entity, joined | `{"ticker":"AAPL"}` |
| `get_sec_filings` | $0.05 | Everything an issuer has filed since your cursor | `{"ticker":"AAPL","since":"2026-09-01"}` |
| `get_sec_events` | $0.05 | 8-K material events since your cursor, decoded by item code | `{"ticker":"TSLA","since":"2026-09-01","items":"5.02"}` |
| `get_sec_insiders` | $0.05 | Forms 3/4/5, SC 13D/G ownership changes since your cursor | `{"ticker":"NVDA","since":"2026-09-01"}` |
| `get_spend_budget` | free, local | What this session has spent and every cap in force | `{}` |

Prices are USDC on Base (`eip155:8453`) and are read from the gateway's own
`x-payment-info`, not kept in step by hand.

## Three things that will save you a wasted call

- **The three `get_sec_*` tools return DELTAS, not dumps.** `since` is required
  and inclusive. Pass the date you last read; you get what has landed since.
  They report `matched` and `truncated`, so a cut-off delta is never mistaken
  for a complete one.
- **Missing arguments are refused here, not upstream.** A call with a required
  argument absent or empty is stopped before any request is made, and says
  `Nothing was requested and nothing was spent`. It does not become
  `?symbol=undefined` and it does not cost you a call.
- **`get_v4_hook_risk` never outputs SAFE.** It is capability analysis: it tells
  you what a hook is *able* to do to your trade, not whether its author intends
  to. Treat `OPAQUE` as unresolved, not as clean.

---

# For a human

## What this is

Thirteen MCP tools over live on-chain and regulatory data: DEX market state on
Base, Polygon and Avalanche, Uniswap v4 hook security, GLEIF legal-entity
lookup, OFAC-screened counterparty dossiers, SEC EDGAR change oracles and the US
Treasury yield curve.

Zero dependencies, stdio, Node 18+. The payment packages are optional and are
only loaded if a wallet is configured.

## Why the tool list shrank in 1.7.0

1.6.1 shipped 23 tools. This release ships 13, and the nine-tool difference is
the point.

The gateway behind this server sold 62 priced routes, and this package carried a
tool for most of them — including geocoding, weather, web search, public
holidays, RSS and IP lookup. Then the demand was measured across the whole
recorded history of the storefront: 12 routes have either organic buyers or no
substitute anywhere in the catalogue. The other 50 had between zero and two
calls each, every one of them from a single wallet. On 2026-09-16 the storefront
was cut to those 12, and this release follows it.

A tool list is not free. It is loaded into the model's context in every session,
whether or not a single tool is called, and a tool that advertises a shelf the
storefront no longer stocks costs the agent a turn to discover the gap. Removing
nine tools makes the list shorter and every entry in it true.

**The 50 dropped routes still work.** They are served, priced and payable by
anyone holding the URL. Removing a tool withdrew a recommendation, not a product.

Three of the nine went for a second, independent reason: the upstreams behind
`geocode`, `reverse_geocode` and `get_weather` retire on 2026-09-27. A tool that
will 404 in eleven days should not ship in a release today.

## Upgrading from 1.6.x

Breaking, and deliberately so:

- **No tool takes a `chain` argument any more.** Each tool targets one chain's
  route and writes the whole path itself. Sending `chain` is now an error rather
  than being silently ignored — ignoring it would have sent a Polygon question to
  a Base route and charged for the answer.
- **These tools are gone**, with the routes they used to call, which are all still
  live: `get_token_price` (`/price`), `get_liquidity` (`/liquidity`),
  `get_pool_reserves` (`/reserves`), `find_arbitrage` (`/scan`), `get_best_venue`
  (`/route`), `get_slippage` (`/slippage`), `get_liquidity_risk` (`/risk`),
  `geocode`, `reverse_geocode`, `get_weather`, `search`,
  `get_search_suggestions`, `get_holidays`, `read_feed`, `get_random`,
  `url_to_markdown`, `geolocate_ip`, `get_gas`, `list_chains` and
  `get_dex_spread` (`/call`).
- **Chain-specific replacements** exist for the routes the storefront kept:
  `get_base_liquidity`, `get_polygon_token_price`,
  `get_avalanche_pool_reserves`, `find_polygon_arbitrage`,
  `find_avalanche_arbitrage`.
- **New**: `get_v4_hook_risk`, `get_company_dossier`, `get_sec_filings`,
  `get_sec_events`, `get_sec_insiders`.
- `lookup_lei`, `get_treasury_yield_curve` and `get_spend_budget` are unchanged.

If you were calling a removed tool, the route behind it still answers. Call it
directly, at list price, at `https://x402.donnyautomation.com`.

## Paying

Set `DEX_WALLET_KEY` to an EVM private key holding USDC on Base, and install the
optional payment packages:

```bash
npm i @x402/fetch @x402/core @x402/evm viem
```

Without both, this server cannot spend anything: it returns the price and the
payment instructions and stops. With them, it pays only what the caps in the
agent section above allow.

- **Fund it with USDC on Base and nothing else.** x402's `exact` scheme is
  EIP-3009: you sign an off-chain authorization and the facilitator broadcasts and
  pays the gas, so the wallet needs **zero ETH**.
- **Use a burner.** The key sits in your MCP client config in plaintext. A few
  dollars of USDC, never a main wallet.
- **Spend is capped and fails closed** — `DEX_MAX_SPEND_USD` (default $1 total for
  the process), `DEX_MAX_PRICE_USD` (default $0.05 for any single call) and
  `DEX_MAX_CALLS` (default 200). Hitting any one stops payment and returns a plain
  explanation rather than continuing to spend. The asking price is read from the
  402 challenge and refused **before** paying if it exceeds the ceiling. A cap
  that cannot be parsed (`DEX_MAX_SPEND_USD=1,00`) now refuses to start rather
  than silently evaluating to `NaN`, which switched every cap off.
- `get_spend_budget` reports what this session has spent and the caps in force.
- Since 1.7.0 the caps, the integer accounting and the receipts log live in
  [`x402-budget`](packages/x402-budget), a standalone package in this repo that
  holds no wallet. `pay.mjs` is the adapter that reads the `DEX_*` variables and
  supplies the signing function. Behaviour is unchanged.

Use a wallet you funded for this and nothing else. This server holds no custody,
takes no fee and sends nothing anywhere except the payment the challenge asks
for — but the key is yours to scope.

## Development

```bash
node test/arg-validation.test.mjs   # argument validation over real stdio, no network
node test/budget.test.mjs           # spend-cap accounting, no wallet, no network
node test/paywall-402.test.mjs      # every tool against a recorded 402, loopback only
node test/spend-cap.test.mjs        # the cap refuses each price point, loopback only
node packages/x402-budget/test/budget.test.mjs  # the library's own caps and receipts, no network
node scripts/check-coverage.mjs     # tools vs the gateway's listed catalogue (needs the network)
```

The five no-network suites run in CI on every push and pull request. The
coverage check runs at release, because it is the only one that needs the
gateway to be up.

`test/fixtures/challenge-402.json` is a verbatim recording of the live gateway's
402 challenge for each of the twelve routes. Re-record it if prices change; the
suites assert that each tool's description quotes the same price the challenge
asks for.

## Links

- Gateway and full API: <https://x402.donnyautomation.com>
- Source: <https://github.com/donnywin85/dex-data-mcp>
- MIT licensed.
