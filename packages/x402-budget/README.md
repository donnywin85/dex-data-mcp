# x402-budget

Buyer-side spend caps and payment receipts for [x402](https://x402.org) agents.

Three limits that fail closed, an integer running total, and an append-only log
of what was actually bought. **It holds no wallet** — you supply the function
that signs, so this package can never move money on its own.

> **On npm as [`x402-budget`](https://www.npmjs.com/package/x402-budget), version
> 0.1.0.** Install it with `npm install x402-budget`. The source lives at
> `packages/x402-budget` in
> [donnywin85/dex-data-mcp](https://github.com/donnywin85/dex-data-mcp).

## Why

An x402 client signs a payment every time a server answers `402`. The caller is
usually an LLM, and an LLM can loop. Nothing in the standard client stack knows
that this call is your four-hundredth — and four hundred individually-legal
payments are how an agent empties a wallet.

## What `@coinbase/x402` and `@x402/fetch` already give you

Read this before adding a dependency; most of what you need may already be
there. Measured against the published artifacts on 2026-09-10:

| | per-call price ceiling | cumulative spend cap | call-count cap | buyer-side receipts |
|---|---|---|---|---|
| `@coinbase/x402@2.1.0` | — | — | — | — |
| `@x402/fetch@2.25.0` | — | — | — | — |
| `@x402/core@2.25.0` `SpendControls` | **yes** | — | — | — |
| `x402-budget@0.1.0` | yes | **yes** | **yes** | **yes** |

- **`@coinbase/x402@2.1.0` has no fetch wrapper at all.** It exports
  `createFacilitatorConfig`, `createCdpAuthHeaders`, `createAuthHeader`,
  `createCorrelationHeader` and `facilitator` — CDP facilitator plumbing. If you
  are looking for the buyer-side wrapper it is in `@x402/fetch`.
- **`@x402/fetch@2.25.0`** exports `wrapFetchWithPayment(fetch, client)`. Two
  arguments, no third. The strings `maxValue`, `budget` and `receipt` do not
  appear anywhere in its `dist/`.
- **`@x402/core@2.25.0`** added client `SpendControls`: `maxAmountPerPayment`
  (default `"$1"`) plus an asset allowlist. This is a real per-payment ceiling
  and it overlaps this package's `maxPriceUsd` — **if a single-payment cap is
  all you need, use it and skip this package.** It caps each payment
  individually; it does not know how many you have made or what they cost in
  total. Note it is absent from `@x402/core@2.17.x`.
- `receipt` does appear in `@x402/core`, but only on the **server** side — the
  settlement receipt a resource server echoes in `PAYMENT-RESPONSE`. There is no
  buyer-side ledger.

So: the per-call ceiling is the overlap, and the cumulative budget, the call
count and the receipts log are what this adds.

## Use

```js
import { createBudget, wrapFetch } from 'x402-budget';
import { wrapFetchWithPayment } from '@x402/fetch';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY) });

const budget = createBudget({ maxSpendUsd: 1.00, maxPriceUsd: 0.05, maxCalls: 200 });
const pay = wrapFetchWithPayment(fetch, client);          // YOUR wallet, not ours
const fetchWithBudget = wrapFetch(fetch, budget, { pay, source: 'my-agent' });

const res = await fetchWithBudget('https://x402.donnyautomation.com/call?pair=WBNB/USDC');
if (!res.x402.paid) console.error('not paid:', res.x402.reason);
console.log(budget.summary());
// $0.01 of $1.00 spent across 1 paid call(s); $0.99 and 199 call(s) remaining; 1 receipt(s)
```

`fetchWithBudget` has fetch's signature and resolves to a normal `Response`,
with one addition: `res.x402` is `{ paid, reason, priceUsd, receipt }`, so a
refusal can be explained instead of surfacing a bare 402.

## The three caps, and what "fail closed" means

| option | default | refuses when |
|---|---|---|
| `maxSpendUsd` | `1.00` | this payment would push the running total past it |
| `maxPriceUsd` | `0.05` | this one call's price is above it |
| `maxCalls` | `200` | this many paid calls have already been made |

Every refusal path returns rather than pays:

- **A price that cannot be read is a refusal.** Checking the ceiling only when
  the price parsed is not a ceiling — a malformed challenge would skip it and
  then add `$0` to the running total, so the budget never fills and the caps are
  off. This is a real bug that shipped, which is why it has its own test.
- **A cap that cannot be parsed throws at construction.** `maxSpendUsd: "1,00"`
  is `NaN`, and `spent > NaN`, `price > NaN` and `calls >= NaN` are all `false` —
  a typo would silently switch every cap off. A cap you cannot see is worse than
  no cap.
- **No `pay` function means nothing can ever be paid.** That is the default.
- **Money is counted in integer micro-USD.** Summing floats drifted: 19 × `0.05`
  is `0.9500000000000001`, which refused the 20th $0.05 call against a $1.00
  budget. Integers make the budget mean what it says.

## Receipts

One entry is appended per **settled** payment. Nothing is recorded for a refusal
or for a payment that did not settle — a receipt is a claim that money moved,
and a false line in a ledger is worse than a missing one.

```json
{
  "ts": "2026-09-10T14:22:31.084Z",
  "url": "https://x402.donnyautomation.com/call?pair=WBNB/USDC",
  "method": "GET",
  "priceUsd": 0.01,
  "txHash": "0x9f2c...",
  "network": "eip155:8453",
  "source": "my-agent"
}
```

`txHash` and `network` are decoded from the `PAYMENT-RESPONSE` header on the
paid response. If the header is absent both are `null` — never invented.

## Persisting a budget

`toJSON()` round-trips, so caps keep binding across a restart:

```js
fs.writeFileSync('budget.json', JSON.stringify(budget.toJSON()));
// ... later, in a new process ...
const resumed = createBudget(JSON.parse(fs.readFileSync('budget.json', 'utf8')));
```

`toJSON()` returns `maxSpendUsd`, `maxPriceUsd`, `maxCalls`, `spentUsd`,
`spentMicroUsd`, `calls`, `remainingUsd` and `receipts`. `spentMicroUsd` is the
canonical integer; `spentUsd` is for display.

## Attribution

Every request carries `x-402-source`, from the `source` option
(default `x402-budget`). Sellers that bucket traffic by client can then tell
where a payer came from. It is set on both the initial probe and the paid retry.

## API

- `createBudget({ maxSpendUsd, maxPriceUsd, maxCalls })` → budget. Also accepts
  its own `toJSON()` output to restore one.
- `budget.check(priceMicroUsd)` → `{ ok }` or `{ ok: false, reason }`. Pure.
- `budget.record(priceMicroUsd, receipt)` — charge and append. Call only after
  money has actually moved.
- `budget.receipts`, `budget.toJSON()`, `budget.summary()`
- `wrapFetch(fetch, budget, { source, pay })` → a budgeted fetch
- `priceFromChallenge(res)` → integer micro-USD, or `null` (which means refuse)
- `settlementFromResponse(res)` → `{ txHash, network }`, either possibly `null`

`check`/`record` are public so a non-fetch transport can use the same accounting.

## Testing

No network, no key, no x402 packages — pass a fake `pay`:

```js
const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
const doFetch = wrapFetch(async () => challenge402, budget, { pay: async () => settled200 });
```

That the suite can do this at all is the design claim: the library holds no
wallet. `node test/budget.test.mjs` — 45 checks.

## Origin

Extracted from `pay.mjs` in
[dex-data-mcp](https://github.com/donnywin85/dex-data-mcp), which is also its
first consumer, where it has been the spend control on a live x402 paid tool.

MIT
