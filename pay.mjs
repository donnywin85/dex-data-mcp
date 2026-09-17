// pay.mjs — optional x402 payment for the MCP server.
//
// WHY THIS EXISTS: without it, a user who likes the tool and exhausts the daily
// free allowance has NO WAY TO PAY. The server previously advertised a
// "DEX_API_KEY" that the gateway never implemented — a dangling promise at the
// exact moment someone wants to hand over money. This makes the paid path real.
//
// OPT-IN ONLY. Nothing here runs unless the user sets a wallet key. A package
// that strangers install must never move funds because a model decided to call a
// tool a few extra times.
//
// ★ WHAT THIS FILE IS NOW. The spend caps, the integer accounting and the
//   receipts log moved out to the `x402-budget` package (packages/x402-budget)
//   at 1.7.0. They were never specific to this server: any x402 buyer needs
//   them, and `@x402/fetch` supplies none of them. What is left here is the
//   half that IS specific to us — reading OUR env vars, holding the wallet, and
//   naming OUR variables in the error messages. The library decides whether to
//   pay; this file is the only place a private key is ever touched.
//
// TWO ACCEPTED KEY NAMES, ONE MEANING. DEX_WALLET_KEY is this package's own name
// and stays first. EVM_PRIVATE_KEY is the name the CDP x402 MCP docs use, and the
// name bsc-dex-spread-mcp read - so when the paid tool moved in here (P1), every
// MCP client config already written against that package keeps working untouched.
// Accepting both is the point of collapsing to one client: a user who had the
// paid server installed must not have to rename an env var to keep paying.
//
// SPEND CAPS ARE NOT OPTIONAL. The caller here is an LLM, which can loop. Three
// independent limits, all failing closed:
//   DEX_MAX_SPEND_USD   total for the process lifetime   (default 1.00)
//   DEX_MAX_PRICE_USD   ceiling for any single call      (default 0.05)
//   DEX_MAX_CALLS       number of paid calls             (default 200)
// Hitting any of them stops payment and returns a plain explanation rather than
// quietly continuing to spend.
//
// The x402 client packages are optionalDependencies and imported lazily, so the
// free path stays fast and works even if they are absent.

import { createBudget, wrapFetch } from 'x402-budget';

// ★ WHY THIS TAG LIVES HERE. The 2026-08-04 -> 08-25 cycle closed with 4 settled
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
// It moved from server.mjs to here at 1.7.0 so there is exactly ONE owner: the
// library sets the header from the `source` option, and if server.mjs also set
// it, the two could drift and the library's value would silently win.
export const SRC_TAG = 'npm-client';

// The env var names we accept, in precedence order. Exported so the paywall
// message can NAME them instead of making the user guess which one this build
// reads. An error that does not name the variable to set is not actionable.
export const WALLET_ENV_NAMES = ['DEX_WALLET_KEY', 'EVM_PRIVATE_KEY'];

// Map the library's option names back to the environment variables a user of
// THIS package actually sets. "exceeds maxPriceUsd" is not actionable in an MCP
// client config; "exceeds DEX_MAX_PRICE_USD" is.
const OPTION_TO_ENV = {
  maxSpendUsd: 'DEX_MAX_SPEND_USD',
  maxPriceUsd: 'DEX_MAX_PRICE_USD',
  maxCalls: 'DEX_MAX_CALLS',
};
const inOurTerms = (reason) => {
  if (!reason) return reason;
  let out = String(reason);
  for (const [opt, env] of Object.entries(OPTION_TO_ENV)) out = out.split(opt).join(env);
  return out;
};

// A cap the user cannot see is worse than no cap. Before 1.7.0 these were
// `Number(process.env.X || default)`, so DEX_MAX_SPEND_USD=1,00 became NaN — and
// `spent > NaN`, `price > NaN` and `calls >= NaN` are all false, so a typo
// silently switched every cap OFF. createBudget now throws on an unparseable
// cap; rethrow it naming the ENVIRONMENT VARIABLE rather than the option.
function budgetFromEnv() {
  try {
    return createBudget({
      maxSpendUsd: process.env.DEX_MAX_SPEND_USD || 1.0,
      maxPriceUsd: process.env.DEX_MAX_PRICE_USD || 0.05,
      maxCalls: process.env.DEX_MAX_CALLS || 200,
    });
  } catch (e) {
    throw new Error(inOurTerms((e && e.message) || e));
  }
}

let budgetState = budgetFromEnv();
let payFetch = null;
let initError = null;
let testPayFn = null;

/** Returns { name, key } for the first accepted env var that is set, else null. */
export function walletKey() {
  for (const name of WALLET_ENV_NAMES) {
    const v = (process.env[name] || '').trim();
    if (v) return { name, key: v };
  }
  return null;
}

export function payEnabled() {
  return !!walletKey();
}

/**
 * The shape the get_spend_budget MCP tool returns. Deliberately UNCHANGED across
 * the 1.7.0 extraction — the library's own field names differ (maxPriceUsd vs
 * maxPricePerCallUsd) and a tool's output is a contract with every client that
 * already parses it.
 */
export function budget() {
  const j = budgetState.toJSON();
  return {
    spentUsd: j.spentUsd,
    calls: j.calls,
    maxSpendUsd: j.maxSpendUsd,
    maxCalls: j.maxCalls,
    maxPricePerCallUsd: j.maxPriceUsd,
    remainingUsd: j.remainingUsd,
  };
}

/** The payment receipts recorded so far: { ts, url, method, priceUsd, txHash, network, source }. */
export function receipts() {
  return budgetState.receipts;
}

// ---- the wallet half: the ONLY place a private key is touched -------------
async function getPayFetch() {
  if (payFetch) return payFetch;
  if (initError) throw initError;
  try {
    const [{ wrapFetchWithPayment }, { x402Client }, { registerExactEvmScheme }, { privateKeyToAccount }] =
      await Promise.all([
        import('@x402/fetch'), import('@x402/core/client'),
        import('@x402/evm/exact/client'), import('viem/accounts'),
      ]);
    const found = walletKey();
    if (!found) throw new Error(`no wallet key set (${WALLET_ENV_NAMES.join(' or ')})`);
    const key = found.key.startsWith('0x') ? found.key : `0x${found.key}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      // Name the variable that is wrong, NEVER its value. [fingerprints-only]
      throw new Error(`${found.name} is not a 32-byte hex private key`);
    }
    const account = privateKeyToAccount(key);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: account });
    payFetch = { fn: wrapFetchWithPayment(fetch, client), address: account.address };
    return payFetch;
  } catch (e) {
    initError = new Error(
      `x402 payment unavailable: ${(e && e.message) || e}. `
      + 'Install the payment extras with: npm i @x402/fetch @x402/core @x402/evm viem');
    throw initError;
  }
}

// The pluggable payer handed to the library. THIS is the seam that lets
// x402-budget hold no wallet: it decides whether to pay and calls this to do it.
const payAdapter = async (url, init) => {
  if (testPayFn) return testPayFn(url, init);
  const { fn } = await getPayFetch();
  return fn(url, init);
};

// `globalThis.fetch` is read at CALL time, not captured here: test/budget.test.mjs
// swaps the global after importing this module.
const lateFetch = (u, i) => globalThis.fetch(u, i);

let budgetedFetch = wrapFetch(lateFetch, budgetState, { source: SRC_TAG, pay: payAdapter });

// ★ THE FREE PATH GOES THROUGH THE LIBRARY TOO, and it must.
//
// Attribution is not a property of PAID calls. The gateway records a `src`
// bucket on every ledger row, free-tier included, and the overwhelming majority
// of this package's traffic has no wallet configured at all. When the
// x-402-source header moved out of server.mjs and into the library at 1.7.0,
// short-circuiting the no-wallet case straight to `globalThis.fetch` would have
// dropped the header from nearly every call this package makes — silently, with
// every test still green, because no test looked at the free path's headers.
// Same wrapper, no `pay` function: the header is set, and nothing can be paid
// because there is nothing to pay with. Pinned by test/budget.test.mjs.
let unpaidFetch = wrapFetch(lateFetch, budgetState, { source: SRC_TAG });

/**
 * Fetch `url`, paying via x402 only if the free tier is exhausted AND every
 * budget limit still allows it. Returns { res, paid, reason, price }.
 */
export async function fetchMaybePaid(url, opts = {}) {
  // The wallet check stays HERE and stays first: with no wallet configured there
  // is nothing to decide, and the 402 should be explained rather than costed.
  if (!payEnabled()) {
    const res = await unpaidFetch(url, opts);
    if (res.status !== 402) return { res, paid: false };
    return { res, paid: false, reason: 'no wallet configured' };
  }
  const res = await budgetedFetch(url, opts);
  const { paid, reason, priceUsd } = res.x402;
  return { res, paid, reason: inOurTerms(reason), price: priceUsd };
}

// ── test seam ──────────────────────────────────────────────────────────────
// Lets test/budget.test.mjs drive fetchMaybePaid with a fake paying fetch and a
// fresh budget, without a wallet key, a network, or the optional x402 packages.
// Not part of the public surface; the leading underscore is the contract.
export function _resetBudgetForTests() {
  budgetState = budgetFromEnv();
  payFetch = null;
  initError = null;
  testPayFn = null;
  budgetedFetch = wrapFetch(lateFetch, budgetState, { source: SRC_TAG, pay: payAdapter });
  unpaidFetch = wrapFetch(lateFetch, budgetState, { source: SRC_TAG });
}
export function _setPayFetchForTests(fn) {
  testPayFn = fn;
  payFetch = { fn, address: '0xtest' };
}
