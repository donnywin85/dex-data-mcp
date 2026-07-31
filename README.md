# dex-data MCP server

Live multi-chain DEX market data as MCP tools: token prices, liquidity depth,
pool reserves, best execution venue, liquidity risk and pre-trade slippage across
BNB Chain, Polygon, Arbitrum, Base and Avalanche.

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
claude mcp add dex-data -- npx -y @donnyautomation/dex-data-mcp
```

**Claude Desktop / Cursor** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dex-data": {
      "command": "npx",
      "args": ["-y", "@donnyautomation/dex-data-mcp"]
    }
  }
}
```

No API key, no wallet, no signup. The free tier answers every tool for a daily
allowance; after that the endpoints fall back to x402 micropayments.

## Tools

| tool | answers |
|---|---|
| `get_token_price` | USD price of any ERC-20, by ticker or contract address |
| `get_liquidity` | market depth and TVL per venue for a pair |
| `get_best_venue` | which DEX is cheapest to buy on / best to sell into |
| `get_slippage` | price impact for a specific trade size |
| `get_liquidity_risk` | DEEP / MODERATE / SHALLOW / VERY_THIN depth class |
| `list_chains` | supported chains and indexed tokens |

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
