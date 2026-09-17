// x402-budget — buyer-side spend caps and payment receipts for x402 agents.
//
// WHY THIS EXISTS. The x402 client stack will sign a payment every time a
// server answers 402. The caller is usually an LLM, and an LLM can loop. The
// published wrapper (`@x402/fetch`'s `wrapFetchWithPayment`) takes a client and
// nothing else: no cumulative budget, no call ceiling, and no record of what was
// bought. `@x402/core`'s `SpendControls` (added after 2.17) caps a SINGLE
// payment; it does not know that this is your four-hundredth. Four hundred
// individually-legal payments are how an agent empties a wallet.
//
// So this library holds the three limits that only the buyer can set, and the
// ledger that only the buyer can keep:
//
//   maxSpendUsd   cumulative, for the lifetime of the budget object
//   maxPriceUsd   ceiling for any single call
//   maxCalls      number of paid calls
//
// All three FAIL CLOSED: an unreadable price refuses, an unparseable cap
// refuses, a missing payer refuses. A cap that a malformed header or a typo can
// switch off is not a cap — that exact bug (a 402 whose amount could not be
// parsed skipped the ceiling and then added $0 to the running total, so the
// budget never filled) is why the logic this was extracted from grew tests.
//
// IT HOLDS NO WALLET. Signing is the caller's, supplied as a `pay` function.
// The library decides WHETHER to pay and records THAT it happened; it can never
// itself move money, which is what makes it safe to depend on and testable with
// no key, no network and no x402 packages installed.

// USDC is 6dp, so money is counted in integer micro-USD everywhere and
// converted to a float only for display. Summing floats drifted: 19 x 0.05
// became 0.9500000000000001 and the 20th $0.05 call was refused against a $1.00
// budget. Integers make the budget mean what it says.
const UNITS = 1e6;

const DEFAULTS = { maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 };

/** Parse a USD amount to integer micro-USD, or throw naming the field. */
function toUnits(value, field) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `x402-budget: ${field} must be a non-negative finite number of USD, got ${JSON.stringify(value)}. `
      + 'Refusing to build a budget whose caps would not bind.');
  }
  return Math.round(n * UNITS);
}

/** Parse a call count to a non-negative integer, or throw naming the field. */
function toCount(value, field) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new Error(
      `x402-budget: ${field} must be a non-negative integer, got ${JSON.stringify(value)}. `
      + 'Refusing to build a budget whose caps would not bind.');
  }
  return n;
}

/** Money for humans: 2dp when the amount is whole cents, else full 6dp. */
function fmt(units) {
  return (units / UNITS).toFixed(units % 10000 === 0 ? 2 : 6);
}

/**
 * A spend budget: three caps, an integer running total, and a receipts log.
 *
 * Accepts its own `toJSON()` output, so a budget survives a process restart with
 * its caps still binding — pass the parsed JSON straight back in.
 *
 * @param {object} [config]
 * @param {number} [config.maxSpendUsd=1.0]  cumulative cap for this budget
 * @param {number} [config.maxPriceUsd=0.05] ceiling for any single call
 * @param {number} [config.maxCalls=200]     number of paid calls allowed
 * @param {number} [config.spentMicroUsd=0]  restore point (integer micro-USD)
 * @param {number} [config.calls=0]          restore point (paid calls so far)
 * @param {object[]} [config.receipts=[]]    restore point (prior receipts)
 */
export function createBudget(config = {}) {
  const maxSpendUnits = toUnits(config.maxSpendUsd ?? DEFAULTS.maxSpendUsd, 'maxSpendUsd');
  const maxPriceUnits = toUnits(config.maxPriceUsd ?? DEFAULTS.maxPriceUsd, 'maxPriceUsd');
  const maxCalls = toCount(config.maxCalls ?? DEFAULTS.maxCalls, 'maxCalls');

  let spentUnits = toCount(config.spentMicroUsd ?? 0, 'spentMicroUsd');
  let calls = toCount(config.calls ?? 0, 'calls');
  const receipts = Array.isArray(config.receipts) ? config.receipts.slice() : [];

  const budget = {
    /** Append-only log of settled payments. See `wrapFetch`. */
    receipts,

    /**
     * Would a call at `priceUnits` (integer micro-USD) be allowed right now?
     * Returns `{ ok: true }` or `{ ok: false, reason }`. Never mutates.
     *
     * Order matters and is the order the caps were written in: an unreadable
     * price is refused before anything else, because it is the one input that
     * could otherwise bypass every check below it.
     */
    check(priceUnits) {
      if (priceUnits == null || !Number.isFinite(priceUnits)) {
        return { ok: false, reason: 'challenge price unreadable; refusing to pay (fail closed)' };
      }
      if (priceUnits > maxPriceUnits) {
        return { ok: false, reason: `call costs $${fmt(priceUnits)} which exceeds maxPriceUsd ($${fmt(maxPriceUnits)})` };
      }
      if (calls >= maxCalls) {
        return { ok: false, reason: `paid-call limit reached (${maxCalls})` };
      }
      if (spentUnits + priceUnits > maxSpendUnits) {
        return { ok: false, reason: `spend cap reached ($${fmt(spentUnits)} of $${fmt(maxSpendUnits)})` };
      }
      return { ok: true };
    },

    /**
     * Record a payment that HAS SETTLED: charge the budget and append a receipt.
     * Call this only once money has actually moved — a receipt is a claim that
     * it did, and a false line in a buyer's ledger is worse than a missing one.
     */
    record(priceUnits, receipt) {
      spentUnits += priceUnits;
      calls += 1;
      if (receipt) receipts.push(receipt);
      return receipt;
    },

    /** Machine-readable state. Round-trips: `createBudget(b.toJSON())`. */
    toJSON() {
      return {
        maxSpendUsd: maxSpendUnits / UNITS,
        maxPriceUsd: maxPriceUnits / UNITS,
        maxCalls,
        spentUsd: spentUnits / UNITS,
        spentMicroUsd: spentUnits,
        calls,
        remainingUsd: Math.max(0, maxSpendUnits - spentUnits) / UNITS,
        receipts,
      };
    },

    /** One line a human (or a model) can read before deciding to continue. */
    summary() {
      const remaining = Math.max(0, maxSpendUnits - spentUnits);
      return `$${fmt(spentUnits)} of $${fmt(maxSpendUnits)} spent across ${calls} paid call(s); `
        + `$${fmt(remaining)} and ${Math.max(0, maxCalls - calls)} call(s) remaining; `
        + `${receipts.length} receipt(s)`;
    },
  };

  return budget;
}

/**
 * Read the asking price from a 402 challenge, as integer micro-USD.
 *
 * Returns null when it cannot be read, and the caller MUST treat null as a
 * refusal — checking the ceiling only when the price parsed is how a malformed
 * header used to buy an unbounded number of calls.
 */
export function priceFromChallenge(res) {
  try {
    const hdr = res.headers.get('payment-required') || res.headers.get('x-payment-required');
    if (!hdr) return null;
    const j = JSON.parse(Buffer.from(hdr, 'base64').toString());
    const a = (j.accepts || [])[0];
    if (!a) return null;
    // amount is in the asset's smallest unit; USDC is 6dp.
    const amt = Number(a.amount ?? a.maxAmountRequired);
    return Number.isFinite(amt) && amt >= 0 ? Math.round(amt) : null;
  } catch { return null; }
}

/** Depth-first search for the first of `keys` holding a non-empty string. */
function deepFind(node, keys, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  for (const k of keys) {
    const v = node[k];
    if (typeof v === 'string' && v) return v;
  }
  for (const v of Object.values(node)) {
    const found = deepFind(v, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Decode the settlement proof a facilitator returns on the paid response.
 * Returns `{ txHash, network }`, either of which may be null — an absent proof
 * is recorded as null, never invented. [derive-or-delete]
 */
export function settlementFromResponse(res) {
  const empty = { txHash: null, network: null };
  try {
    const hdr = res.headers.get('payment-response') || res.headers.get('x-payment-response');
    if (!hdr) return empty;
    const j = JSON.parse(Buffer.from(hdr, 'base64').toString());
    return {
      txHash: deepFind(j, ['transaction', 'txHash', 'transactionHash']),
      network: deepFind(j, ['network', 'chainId']),
    };
  } catch { return empty; }
}

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

function methodOf(input, init) {
  const m = (init && init.method) || (input && input.method) || 'GET';
  return String(m).toUpperCase();
}

/** Return a copy of `init` with the x-402-source header added to its headers. */
function withSource(init, source) {
  const headers = new Headers((init && init.headers) || undefined);
  headers.set('x-402-source', source);
  return { ...(init || {}), headers };
}

/** Attach the payment decision to a Response without making it enumerable. */
function decorate(res, x402) {
  Object.defineProperty(res, 'x402', { value: x402, enumerable: false, configurable: true, writable: true });
  return res;
}

/**
 * Wrap a fetch so that 402 responses are paid for ONLY when `budget` allows it.
 *
 * The returned function has fetch's signature and resolves to a Response, with
 * one addition: `res.x402` carries `{ paid, reason, priceUsd, receipt }` so a
 * caller can explain a refusal instead of surfacing a bare 402.
 *
 * @param {typeof fetch} fetchImpl  the fetch to wrap (usually globalThis.fetch)
 * @param {ReturnType<createBudget>} budget
 * @param {object} [options]
 * @param {string} [options.source='x402-budget']  value for the x-402-source header
 * @param {Function} [options.pay]  a fetch-shaped function that SIGNS and pays,
 *   e.g. `wrapFetchWithPayment(fetch, client)` from `@x402/fetch`. Omit it and
 *   nothing can ever be paid — this library holds no wallet by design.
 */
export function wrapFetch(fetchImpl, budget, options = {}) {
  const source = options.source || 'x402-budget';
  const pay = options.pay;

  return async function budgetedFetch(input, init) {
    const tagged = withSource(init, source);
    const res = await fetchImpl(input, tagged);
    if (res.status !== 402) return decorate(res, { paid: false, reason: null, priceUsd: null, receipt: null });

    if (typeof pay !== 'function') {
      return decorate(res, {
        paid: false, priceUsd: null, receipt: null,
        reason: 'no pay function supplied; refusing to pay (fail closed)',
      });
    }

    // Price FIRST, then decide. Paying and checking afterwards would make the
    // ceiling decorative.
    const priceUnits = priceFromChallenge(res);
    const verdict = budget.check(priceUnits);
    const priceUsd = priceUnits == null ? null : priceUnits / UNITS;
    if (!verdict.ok) return decorate(res, { paid: false, reason: verdict.reason, priceUsd, receipt: null });

    let paidRes;
    try {
      paidRes = await pay(input, tagged);
    } catch (e) {
      // The payer blew up; hand back the original 402 and say why.
      return decorate(res, { paid: false, reason: String((e && e.message) || e), priceUsd, receipt: null });
    }

    if (!paidRes.ok) {
      // Money did not move, so nothing is charged and no receipt is written.
      return decorate(paidRes, { paid: false, reason: `payment did not settle (HTTP ${paidRes.status})`, priceUsd, receipt: null });
    }

    const { txHash, network } = settlementFromResponse(paidRes);
    const receipt = {
      ts: new Date().toISOString(),
      url: urlOf(input),
      method: methodOf(input, init),
      priceUsd,
      txHash,
      network,
      source,
    };
    budget.record(priceUnits, receipt);
    return decorate(paidRes, { paid: true, reason: null, priceUsd, receipt });
  };
}
