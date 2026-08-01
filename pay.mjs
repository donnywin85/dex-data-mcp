// pay.mjs — optional x402 payment for the MCP server.
//
// WHY THIS EXISTS: without it, a user who likes the tool and exhausts the daily
// free allowance has NO WAY TO PAY. The server previously advertised a
// "DEX_API_KEY" that the gateway never implemented — a dangling promise at the
// exact moment someone wants to hand over money. This makes the paid path real.
//
// OPT-IN ONLY. Nothing here runs unless the user sets DEX_WALLET_KEY. A package
// that strangers install must never move funds because a model decided to call a
// tool a few extra times.
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

const MAX_SPEND_USD = Number(process.env.DEX_MAX_SPEND_USD || 1.0);
const MAX_PRICE_USD = Number(process.env.DEX_MAX_PRICE_USD || 0.05);
const MAX_CALLS = Number(process.env.DEX_MAX_CALLS || 200);

let state = { spentUsd: 0, calls: 0 };
let payFetch = null;
let initError = null;

export function payEnabled() {
  return !!(process.env.DEX_WALLET_KEY || '').trim();
}

export function budget() {
  return {
    spentUsd: Number(state.spentUsd.toFixed(4)),
    calls: state.calls,
    maxSpendUsd: MAX_SPEND_USD,
    maxCalls: MAX_CALLS,
    maxPricePerCallUsd: MAX_PRICE_USD,
    remainingUsd: Number(Math.max(0, MAX_SPEND_USD - state.spentUsd).toFixed(4)),
  };
}

async function getPayFetch() {
  if (payFetch) return payFetch;
  if (initError) throw initError;
  try {
    const [{ wrapFetchWithPayment }, { x402Client }, { registerExactEvmScheme }, { privateKeyToAccount }] =
      await Promise.all([
        import('@x402/fetch'), import('@x402/core/client'),
        import('@x402/evm/exact/client'), import('viem/accounts'),
      ]);
    const raw = process.env.DEX_WALLET_KEY.trim();
    const key = raw.startsWith('0x') ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error('DEX_WALLET_KEY is not a 32-byte hex private key');
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

// Read the asking price from the 402 challenge so a call is refused BEFORE
// paying if it exceeds the per-call ceiling. Paying first and checking after
// would make the cap decorative.
function priceFromChallenge(res) {
  try {
    const hdr = res.headers.get('payment-required');
    if (!hdr) return null;
    const j = JSON.parse(Buffer.from(hdr, 'base64').toString());
    const a = (j.accepts || [])[0];
    if (!a) return null;
    // amount is in the asset's smallest unit; USDC is 6dp.
    const amt = Number(a.amount ?? a.maxAmountRequired ?? 0);
    return Number.isFinite(amt) ? amt / 1e6 : null;
  } catch { return null; }
}

/**
 * Fetch `url`, paying via x402 only if the free tier is exhausted AND every
 * budget limit still allows it. Returns { res, paid, reason }.
 */
export async function fetchMaybePaid(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.status !== 402) return { res, paid: false };
  if (!payEnabled()) return { res, paid: false, reason: 'no wallet configured' };

  const price = priceFromChallenge(res);
  if (price != null && price > MAX_PRICE_USD) {
    return { res, paid: false, reason: `call costs $${price} which exceeds DEX_MAX_PRICE_USD ($${MAX_PRICE_USD})` };
  }
  if (state.calls >= MAX_CALLS) {
    return { res, paid: false, reason: `paid-call limit reached (${MAX_CALLS})` };
  }
  const projected = state.spentUsd + (price ?? MAX_PRICE_USD);
  if (projected > MAX_SPEND_USD) {
    return { res, paid: false, reason: `spend cap reached ($${state.spentUsd.toFixed(4)} of $${MAX_SPEND_USD})` };
  }

  try {
    const { fn } = await getPayFetch();
    const paidRes = await fn(url, opts);
    if (paidRes.ok) { state.spentUsd += price ?? 0; state.calls += 1; }
    return { res: paidRes, paid: paidRes.ok, price };
  } catch (e) {
    return { res, paid: false, reason: String((e && e.message) || e) };
  }
}
