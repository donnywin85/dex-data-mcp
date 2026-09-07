# dex-data MCP server

[![dex-data-mcp MCP server](https://glama.ai/mcp/servers/donnywin85/dex-data-mcp/badges/score.svg)](https://glama.ai/mcp/servers/donnywin85/dex-data-mcp)

**Twenty-three tools for your agent — DEX market data, everyday utilities and
reference data. Twenty-two need no API key, no wallet and no signup; one is paid
and pays from a wallet you control.**

## Try it in 30 seconds

```bash
claude mcp add dex-data -- npx -y dex-data-mcp
```

That is the whole install. Ask your agent *"what's the price of WBNB on BSC?"*
and it answers from live on-chain pool state:

```json
{
  "symbol": "WBNB", "priceUsd": 677.25, "network": "bsc",
  "via": "WBNB/USDT", "venues": 7, "totalTvlUsd": 117110555.6,
  "confidence": "HIGH", "spreadBps": 25.26, "blockNumber": 117223818
}
```

**Measured 2026-08-21: all 22 free tools answered keyless, with full payloads.**
No tool is degraded on the free tier, and none returns a stub or a placeholder —
the free answer is the same answer. What the free tier limits is *how many* calls
per day, not what is in them.

Since 1.6.0 there is also **one paid tool**, `get_dex_spread` — see
[Paid tools](#paid-tools). It is the only tool that needs a wallet, it is labelled
PAID in its own description, and without a wallet it explains what to set and
spends nothing. The 22 tools above are unaffected by it.

Twenty-two free tools, no API key and no wallet, in three groups:

- **Multi-chain DEX market data** — token prices, liquidity depth, pool reserves,
  best execution venue, liquidity risk, pre-trade slippage and gas costs across BNB Chain,
  Polygon, Arbitrum, Base, Avalanche and Optimism.
- **General-purpose agent utilities** — geocoding, reverse geocoding, weather,
  web search, article/PDF to Markdown, and cryptographic randomness.
- **Reference and research data** — search autocomplete, public holidays and
  business days, RSS/Atom feeds, IP geolocation, GLEIF legal-entity lookup and
  the US Treasury yield curve.

## Why this exists

The ledger says it plainly. Of 20,392 paywall challenges recorded, **zero** were
genuine third-party queries — 82.5% were our own monitoring, 17.3% were catalogue
crawlers walking every route with no parameters. We were being indexed, not
shopped.

Bazaar listings are a bet on demand that does not exist yet. MCP is where agents
already are today: Claude Desktop, Claude Code, Cursor, and every other MCP host.
This server is the same data, delivered where the users are, and it needs no
payment at all for the free tier — which removes the one barrier that a browsing
agent cannot cross on its own.

## Install

**Claude Code**

```
claude mcp add dex-data -- npx -y dex-data-mcp
```

**Claude Desktop / Cursor** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dex-data": {
      "command": "npx",
      "args": ["-y", "dex-data-mcp"]
    }
  }
}
```

No API key, no wallet, no signup. The free tier answers every tool for a daily
allowance; after that the endpoints fall back to x402 micropayments.

## Tools

**DEX market data**

| tool | answers |
|---|---|
| `get_token_price` | USD price of any ERC-20, by ticker or contract address |
| `get_liquidity` | market depth and TVL per venue for a pair |
| `get_best_venue` | which DEX is cheapest to buy on / best to sell into |
| `get_slippage` | price impact for a specific trade size |
| `get_liquidity_risk` | DEEP / MODERATE / SHALLOW / VERY_THIN depth class |
| `get_gas` | gas cost in USD per chain, ranked cheapest-first (gwei is not comparable across chains) |
| `get_pool_reserves` | raw reserves, fee and TVL per venue at one block — the data the others compute from |
| `find_arbitrage` | cross-venue arbitrage now, ranked by gross USD at the optimal size, not raw spread |
| `list_chains` | supported chains and indexed tokens |

**General-purpose agent utilities**

Not a change of theme — these were chosen the same way everything else here was.
Reading USDC receipts across 1,062 x402 seller wallets on Base ranked what
actually gets paid for, and DEX data was not near the top of that list. Forward
geocoding was (56 paying wallets), then weather, then article-to-Markdown, then
randomness. These are the answers to that data.

| tool | answers |
|---|---|
| `geocode` | address or place name to coordinates, worldwide (OpenStreetMap) |
| `reverse_geocode` | coordinates to the nearest street address |
| `get_weather` | current conditions plus up to a 7-day forecast for any coordinates |
| `search` | free-text web search to ranked organic results, sponsored rows excluded |
| `url_to_markdown` | a public article or PDF URL to clean Markdown |
| `get_random` | CSPRNG integers or bytes, for agents that cannot generate their own |

**Reference and research data**

Chosen the same way, but from a corrected reading. The category totals in the
original scan were double-counted — the biggest x402 sellers carry 10-16 of the
16 category tags each, so every category reported nearly the whole market's
revenue. Seller-level rows are clean, and every tool below is something a wallet
took real USDC for during the sampled window.

| tool | answers |
|---|---|
| `get_search_suggestions` | what people actually type about a topic — autocomplete, expanded into questions and comparisons |
| `get_holidays` | public and bank holidays for 100+ countries, and whether a given date is a business day |
| `read_feed` | any RSS, Atom or RDF feed as clean JSON, summaries in both HTML and plain text |
| `geolocate_ip` | where an IP is, with the datacentre/VPN flag that says whether to believe it |
| `lookup_lei` | a company's Legal Entity Identifier **by name**, with lapsed registrations flagged not hidden |
| `get_treasury_yield_curve` | the US par yield curve plus 2s10s / 3m10y / 5s30s and the inversion flag |

**Local**

| tool | answers |
|---|---|
| `get_spend_budget` | what this session has spent on paid calls, and the caps in force |

<a name="paid-tools"></a>
**Paid — needs a wallet you control**

| tool | answers | price |
|---|---|---|
| `get_dex_spread` | real-time cross-DEX price & spread on BSC: per-venue prices across PancakeSwap v2, PancakeSwap v3 (all fee tiers), Biswap and ApeSwap in one call, plus best buy/sell venue, gross arbitrage spread (bps + USD), optimal trade size, liquidity and block number | $0.01 USDC/call, no free tier |

This tool used to be a separate package, `bsc-dex-spread-mcp`. It lives here now:
one install, one config, free tools and paid tools side by side. Nothing else
changed — same route, same data, same price.

**Before you reach for it, the free tools may already answer you.**
`get_liquidity` gives per-venue depth for a pair and `find_arbitrage` gives a
cross-venue spread scan, both inside the 25-calls-a-day free tier with no wallet
at all. `get_dex_spread` is worth paying for when you want all four BSC venues
and the optimal trade size in a single call, or when you have exhausted the free
allowance.

Pairings worth knowing: `geocode` then `get_weather` turns a place name into a
forecast, `search` then `url_to_markdown` turns a question into readable source
text, and `read_feed` then `url_to_markdown` turns a feed into full articles.

## Free tier

Every one of the 22 free tools answers within a daily per-caller allowance — no
wallet, no signup. The remaining quota is returned on `X-FreeTier-Remaining`.
Beyond it, calls fall back to x402 micropayments (USDC on Base). `get_dex_spread`
is the exception: it is paid from the first call and has no allowance.

Every response carries the liquidity backing the number and a confidence rating.
A quote with no depth behind it is refused rather than returned — a dust-pool
price is worse than no price when an agent may trade on it.

## Paying: the wallet is yours, and this package ships no keys

**This package contains no private key, no seed and no funded wallet.** Payment
is opt-in and off unless you set a key yourself; a package strangers install must
never move funds because a model called a tool a few extra times.

Set **one** of these in your MCP client's `env` block for this server:

```json
{
  "mcpServers": {
    "dex-data": {
      "command": "npx",
      "args": ["-y", "dex-data-mcp"],
      "env": { "DEX_WALLET_KEY": "0x<64 hex chars>" }
    }
  }
}
```

`EVM_PRIVATE_KEY` is accepted as an alias — it is the name the CDP x402 docs use
and the name `bsc-dex-spread-mcp` read, so an existing config for that package
keeps working unchanged.

- **Fund it with USDC on Base and nothing else.** x402's `exact` scheme is
  EIP-3009: you sign an off-chain authorization and the facilitator broadcasts and
  pays the gas, so the wallet needs **zero ETH**.
- **Use a burner.** The key sits in your MCP client config in plaintext. A few
  dollars of USDC, never a main wallet.
- **Spend is capped and fails closed** — `DEX_MAX_SPEND_USD` (default $1 total for
  the process), `DEX_MAX_PRICE_USD` (default $0.05 for any single call) and
  `DEX_MAX_CALLS` (default 200). Hitting any one stops payment and returns a plain
  explanation rather than continuing to spend. The asking price is read from the
  402 challenge and refused **before** paying if it exceeds the ceiling.
- `get_spend_budget` reports what this session has spent and the caps in force.

Without a wallet, `get_dex_spread` returns the price, the two env var names, the
shape of the value and the free alternatives — never a stack trace, and never a
silent failure.

## Honest limits

- Depth and prices cover **the venues this API indexes**; a deeper pool may exist
  on a DEX not covered here.
- v3 figures distinguish custody TVL from tradeable depth at the current price.
  They are not the same number and are not labelled as if they were.
- `get_slippage` is pool-level price impact: it excludes gas, MEV and multi-hop
  routing, and flags v3 estimates that cross the active tick band.
- A tool called without its required argument is **refused before any request is
  made**, so a malformed call never spends a free-tier slot or a cent. The refusal
  names the argument: `search` needs `q`, `get_slippage` needs `amountUsd` or
  `amountIn`, `lookup_lei` needs `q` or `lei`.

## Where to go next

- **Cross-DEX spread only, on six chains** — [`arb-dex-mcp`](https://github.com/donnywin85/arb-dex-mcp)
  is the focused sibling: `npx -y arb-dex-mcp`. Keyless too, and its free answers
  carry a `limitation` field naming exactly what a key would add.
- **Paid, per-call BSC spread** — that is now the `get_dex_spread` tool *in this
  package*; you do not need a second install. It was previously the standalone
  [`bsc-dex-spread-mcp`](https://github.com/donnywin85/bsc-dex-spread-mcp), which
  still works and is unchanged, but this server is where it is maintained.
- **You want the compliance pair (OFAC screening, GLEIF LEI)** —
  [`agent-utils-mcp`](https://github.com/donnywin85/agent-utils-mcp).
- **You want the human-approval job queue this whole stack is operated by** —
  [`approval-queue-starter`](https://github.com/donnywin85/approval-queue-starter),
  one file, zero dependencies.
- **The weekly measurements, free** — <https://arbdatadesk.beehiiv.com>.
  **The live dashboard** — <https://arb-dex-data-production.up.railway.app/dashboard>.
