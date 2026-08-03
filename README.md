# dex-data MCP server

Fourteen tools, no API key and no wallet, in two groups:

- **Multi-chain DEX market data** — token prices, liquidity depth, pool reserves,
  best execution venue, liquidity risk, pre-trade slippage and gas costs across BNB Chain,
  Polygon, Arbitrum, Base, Avalanche and Optimism.
- **General-purpose agent utilities** — geocoding, reverse geocoding, weather,
  web search, article/PDF to Markdown, and cryptographic randomness.

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

**Local**

| tool | answers |
|---|---|
| `get_spend_budget` | what this session has spent on paid calls, and the caps in force |

Two pairings worth knowing: `geocode` then `get_weather` turns a place name into
a forecast, and `search` then `url_to_markdown` turns a question into readable
source text.

## Free tier

Every tool answers free within a daily per-caller allowance — no wallet, no
signup. The remaining quota is returned on `X-FreeTier-Remaining`. Beyond it,
calls fall back to x402 micropayments (USDC on Base).

Every response carries the liquidity backing the number and a confidence rating.
A quote with no depth behind it is refused rather than returned — a dust-pool
price is worse than no price when an agent may trade on it.

## Honest limits

- Depth and prices cover **the venues this API indexes**; a deeper pool may exist
  on a DEX not covered here.
- v3 figures distinguish custody TVL from tradeable depth at the current price.
  They are not the same number and are not labelled as if they were.
- `get_slippage` is pool-level price impact: it excludes gas, MEV and multi-hop
  routing, and flags v3 estimates that cross the active tick band.
