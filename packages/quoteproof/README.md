# quoteproof

Keyless, block-pinned, fee-aware quotes for the tokenized-stock pools on
**Robinhood Chain** (chain id 4663). It has four read tools, an MCP server, a CLI and
`QuoteRegistry`, an on-chain contract that anchors the hash of a served quote.

> **Status: not on npm.** Version 0.1.0 lives at `packages/quoteproof` in
> [donnywin85/dex-data-mcp](https://github.com/donnywin85/dex-data-mcp), branch `quoteproof`.
> **`QuoteRegistry` is compiled and tested but not deployed** (see [Contract](#contract)).

## Why

Robinhood Chain carries 194 tokenized US stocks and ETFs. Three ways to misprice them,
each measured on this chain:

- **Robinhood's REST price endpoint is not a token price.** It passes through the
  underlying equity's bid/ask. Comparing "token vs underlying" with it compares the
  underlying to itself. quoteproof never calls it.
- **A pool mid leaves out the fee, and fees differ from pool to pool.** At block
  63,931,368 the NVDA v3 pool charged 500 ppm (5 bps). The AAPL v4 pool charged 3000 ppm
  of LP fee **plus** a 500 ppm protocol fee, 3499 ppm in all. Readers that used only the
  Initialize-log fee reported 30 bps. quoteproof reads the fee each pool charges at the
  block it reads.
- **"Can this pool refuse me?" is answered in a log, not in the docs.** A Uniswap v4 hook
  can reject a swapper. quoteproof decodes the pool's `Initialize` log, checks that the
  logged PoolKey hashes to the poolId, and reports the hook address.

## What it is not

- **Not routing, execution, custody or advice.** It reads public chain state and stops.
  It has no function that sends a transaction, apart from the separate deploy script for
  its own contract.
- **Not every venue.** Robinhood's docs say stock tokens trade via RFQ at launch. Uniswap
  is one venue beside RFQ, a proprietary AMM and a Lighter orderbook, and none of those
  three is publicly readable. So quoteproof does not claim a best price.
- **Not every token.** It covers the nine measured Uniswap pools for nine of the 194
  tokens.
- **Not a NAV feed.** `nav_context` is labelled reference-only. NAV is the underlying
  close times the issuer's `uiMultiplier()`, and nobody quotes it.

## Install

From a clone (Node 22.18 or later; the sources are TypeScript that Node runs directly):

```sh
git clone https://github.com/donnywin85/dex-data-mcp && cd dex-data-mcp
git checkout quoteproof
npm install -w packages/quoteproof --no-package-lock
cd packages/quoteproof
npm test
```

`npm run build` compiles to `dist/` for use as a plain JavaScript package.

### As an MCP server

```json
{
  "mcpServers": {
    "quoteproof": { "command": "node", "args": ["/path/to/dex-data-mcp/packages/quoteproof/src/server.ts"] }
  }
}
```

It runs over stdio with no runtime dependencies. It follows `dex-data-mcp`'s server
conventions: newline-delimited JSON-RPC 2.0, and required arguments are checked before
any request.

### CLI example

```sh
node src/cli.ts quote NVDA                 # mid, buy/sell after fee, depth at ±50 bps
node src/cli.ts quote AAPL --depth-bps 25
node src/cli.ts hook SPY                   # hook address from the Initialize log
node src/cli.ts nav NVDA                   # reference NAV, marked as such
node src/cli.ts pools --block 63931368     # all nine pools at one historical block
node src/cli.ts quote NVDA > q.json && node src/cli.ts hash < q.json   # bytes32 for anchor()
```

### As a library

```ts
import { quote, httpTransport } from 'quoteproof';
const q = await quote({ rpc: httpTransport() }, { ticker: 'NVDA' });
console.log(q.block.number, q.price.mid, q.price.buy_after_fee, q.fee.buy_ppm);
```

## Tools

| Tool | Input | Returns |
|---|---|---|
| `list_stock_pools` | `block?` | The nine pools at one pinned block: v3 pool address, or v4 PoolManager and poolId; both tokens with decimals and symbol read from the chain; fee tier; tick spacing; active liquidity; mid. A pool that cannot be read comes back with its error, never dropped. |
| `quote_stock_token` | `ticker`, `block?`, `depth_bps?` (default 50) | Mid; the fee charged (v3 `fee()`, or v4 lpFee plus protocol fee per direction); buy = mid/(1−fee); sell = mid×(1−fee); round-trip cost; depth on each side up to a ±`depth_bps` mid move, found by walking the initialised ticks, with amounts before and after fee. |
| `prove_pool_hook` | `ticker`, `block?` | v4: the hook address decoded from the live `Initialize` log, whether the logged PoolKey hashes to the poolId, and the dynamic-fee flag. A zero address means ungated. v3: hooks do not apply. |
| `nav_context` | `ticker`, `block?` | Yahoo Finance regular-session price × on-chain `uiMultiplier()`, labelled `reference_only`, plus the pool mid at the same block and, for USDG-quoted pools, mid vs NAV in bps. |

**Every output carries** `chain_id`, `block.number`, `block.timestamp`, `block.pinned`,
the source pool (`source.pool` for v3, or `source.pool_manager` and `source.pool_id` for
v4) and `fee_tier_ppm`.

**How reads are made.** Every read in one tool call uses the same explicit block tag.
Calling `eth_blockNumber` and then reading at `latest` does not pin a block, because the
two calls race. All reads go to the public RPC `https://rpc.mainnet.chain.robinhood.com`
with an ordinary desktop User-Agent (the RPC's Cloudflare front refuses requests without
one), at most one request per 150 ms, a timeout on every call, and one retry only for
transient statuses. Set `QUOTEPROOF_RPC` to use a different endpoint; the reader refuses
any RPC that does not report chain 4663.

**Self-checks that refuse rather than guess:**

- a v3 pool whose `token0`/`token1` do not include the stock is refused (wrong-pool guard);
- a v4 PoolKey that does not hash to its poolId is refused;
- a slot0 tick that disagrees with `sqrtPriceX96` is refused;
- a v4 lpFee that differs from the pool's static Initialize fee is refused;
- a tick set in the bitmap with zero gross liquidity is refused;
- a tick crossing that would make active liquidity negative is refused.

## Contract

`contracts/QuoteRegistry.sol`, Solidity 0.8.26, optimizer 200 runs, EVM `shanghai`, runtime
1,573 bytes.

| Function | Who | What |
|---|---|---|
| `anchor(bytes32 quoteHash, address pool, uint256 blockNumber)` | anyone | Records submitter, pool, quoted block, and the block and time of anchoring. Emits `QuoteAnchored`. A known hash reverts `AlreadyAnchored`, so the first record can never be overwritten. Refuses a zero hash, zero pool, zero block, or a block in the future. |
| `verify(bytes32)` | view | `anchored`, `submitter`, `pool`, `quotedBlock`, `anchoredBlock`, `anchoredTime`. |
| `verifyQuote(bytes32, address, uint256)` | view | True only for that exact pool and quoted block. |
| `pause()` / `unpause()` | `pauser` (the deployer, immutable) | Stops new anchors only. Views are never pausable. No other privilege exists. |

**What an anchor proves.** An anchor proves that a submitter committed to a quote hash for
a pool and block, at or before `anchoredBlock`. It does **not** prove the quote was true:
a made-up quote anchors just as well. To audit, re-read the pool at `quotedBlock` (every
quote here is block-pinned, so any archive node can answer) and compare the result with
the anchored payload. `quoteHash` is keccak256 of the output's canonical JSON (keys
sorted, no whitespace); `quoteproof hash` computes it.

**Arbitrum block numbers.** On Robinhood Chain the EVM `NUMBER` opcode returns the parent
chain's block. On 2026-09-15 it returned 25,985,166 while `ArbSys.arbBlockNumber()`
returned 63,927,342. `anchor` therefore reads ArbSys when it is present. A naive
`blockNumber <= block.number` check would have refused every real quote; a test covers
exactly that case.

**Holds no funds.** It has no payable function, no `receive` and no `fallback`, and it is
not upgradeable.

**Deployed address on 4663: _not deployed_** (placeholder until `deployments/4663.json`
exists). To deploy, run `node scripts/deploy-4663.mjs`. The dry run sends nothing. The
script reads the key at run time from Windows Credential Manager target
`quoteproof/deployer-4663` and never prints it. It refuses without `--live`, on a stale
build, on a wrong chain id, or when the balance is below the estimated cost.
`--generate-key` creates a fresh key inside Credential Manager and prints only its
address. On 2026-09-15 the chain estimated the deployment at 397,071 gas at 0.068 gwei,
about 0.000027 ETH.

## Tests

`npm test` runs 58 tests with Node's built-in runner:

- **quote maths** against hand-computed fixtures from `quoteproof-spec-001` (60-digit
  decimal arithmetic, tolerance 1e-12) and against the raw words of this build's own live
  probe;
- **keccak256** against published vectors, `js-sha3` over input lengths 0 to 400, and the
  v4 slot keys already pinned from the chain;
- **the reader** replayed against real recorded chain responses in
  `test/fixtures/live-recording.json`; a replay miss throws rather than falling through to
  the network;
- **the MCP server and CLI** as child processes;
- **the contract** compiled with solc-js 0.8.26 and executed on an in-process EVM
  (`@ethereumjs/vm`): anchor, verify, replay refusal, pause, input refusals, the ArbSys
  path, and value refusal;
- **the deploy script** offline;
- **one live smoke test**, reported as skipped when the RPC cannot be reached.

The suite was mutation-checked: ten deliberate defects, ten caught.

## Licence

MIT. See [LICENSE](./LICENSE).

## Prior work

This package was written during the Arbitrum Open House Singapore Buildathon (from
2026-09-14). It builds on research done before the event: the Robinhood Chain venue
recon (`rwa-venue-recon-001`, 2026-09-10/11), the quote-maths and contract specification
(`quoteproof-spec-001`), and the existing `dex-data-mcp` and `x402-budget` packages in
this repository. The disclosure in full is §8 of the entry draft,
`x402-gateway/artifacts/open-house-entry-draft-001/ENTRY.md`.
