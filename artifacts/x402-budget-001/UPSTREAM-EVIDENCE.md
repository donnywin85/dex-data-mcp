# What the published x402 packages already do — measured 2026-09-10

Method: `npm pack` each package and read the shipped `dist/`, rather than the
docs or a README. The artifact is the authority. [dns-panel-trap]

## `@coinbase/x402@2.1.0` — no fetch wrapper at all

The brief asked for "`@coinbase/x402`'s current fetch wrapper". There isn't one.
The package's entire public surface (`dist/cjs/index.d.ts`) is:

```
export { createAuthHeader, createCdpAuthHeaders, createCorrelationHeader,
         createFacilitatorConfig, facilitator };
```

That is CDP **facilitator** plumbing — auth headers for the Coinbase facilitator
service. In the V2 scoped-package layout the buyer-side wrapper moved to
`@x402/fetch`. (V1's `x402-fetch` did carry a `maxValue` third argument; V2 does
not.) So the honest comparison is against `@x402/fetch` and `@x402/core`.

## `@x402/fetch@2.25.0` — two arguments, no caps, no receipts

```
declare function wrapFetchWithPayment(
  fetch: typeof globalThis.fetch,
  client: x402Client | x402HTTPClient
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
```

Grep over the whole shipped `dist/` for `maxvalue|budget|receipt|maxSpend|maxAmount`:
**zero matches.**

## `@x402/core@2.25.0` — a real PER-PAYMENT cap, and nothing cumulative

`SpendControls` (client-side, enforced before policies):

```
/** Default USD cap for recognized default assets. Override via SpendControls. */
declare const DEFAULT_MAX_AMOUNT_PER_PAYMENT: Money;

interface SpendControls {
  /**
   * Per-payment USD cap on assets `findDefaultAsset` recognizes.
   * @default "$1"
   */
  maxAmountPerPayment?: Money | false;
  allowedAssets?: true | SpendControlAsset[];
}
```

- `maxAmountPerPayment` occurs 37× in `dist/`. It caps **one** payment.
- No cumulative session total, and no call-count cap: grep for
  `maxTotal|sessionBudget|maxCalls` → **zero matches**.
- `receipt` occurs 20× but every occurrence is **server-side** — the settlement
  receipt a resource server echoes in `PAYMENT-RESPONSE`
  (`server/index.d.mts`: "Resolve the settlement receipt to surface when a
  resource handler fails"). There is no buyer-side ledger.

**Version note:** `SpendControls` is ABSENT from `@x402/core@2.17.0`, which is
what dex-data-mcp pins. Verified by unpacking both versions:

```
ABSENT in 2.17.0
PRESENT in 2.25.0
```

## Conclusion for the README's honesty paragraph

| | per-call ceiling | cumulative cap | call count | buyer receipts |
|---|---|---|---|---|
| `@coinbase/x402@2.1.0` | — | — | — | — |
| `@x402/fetch@2.25.0` | — | — | — | — |
| `@x402/core@2.25.0` `SpendControls` | yes | — | — | — |
| `x402-budget@0.1.0` | yes | yes | yes | yes |

The per-call ceiling genuinely overlaps `SpendControls.maxAmountPerPayment`, and
the README says so and tells the reader to prefer upstream if that is all they
need. The cumulative budget, the call count and the receipts log are the gap.

## Name availability

`npm view x402-budget` → `E404 Not Found`. The name is free; nothing is
published, so the README does not print an `npm install` line.
