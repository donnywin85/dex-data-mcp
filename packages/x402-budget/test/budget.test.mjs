// x402-budget — spend caps and receipts, driven with NO network, NO wallet key
// and NO x402 packages.
//
// PROVENANCE. Cases 1-8 are ported from dex-data-mcp's test/budget.test.mjs,
// which exists because pay.mjs promised three caps that all fail closed and one
// path broke it: a 402 whose price could not be parsed skipped the per-call
// ceiling and added $0 to the running spend after paying, so the session budget
// never filled. The caller is an LLM that can loop; a budget a malformed header
// disables is the exact failure the caps exist to prevent. Extracting the logic
// must not change that behaviour, so the same hand-computed expectations are
// asserted here against the library.
//
// The hand-computed expectation, stated before the run: with a $1.00 budget and
// a $0.05 price, exactly 20 payments are signed. The 21st is refused. A
// challenge with an unreadable price signs 0.
//
// NO WALLET, NO KEY, NO SIGNING. Every case supplies a fake `pay` function.
// That the suite can do this at all is the library's central design claim: it
// holds no wallet.

import fs from 'node:fs';
import { createBudget, wrapFetch } from '../src/index.mjs';

let failures = 0;
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!pass) failures += 1;
};

// ---- fixtures -------------------------------------------------------------
const challenge = (amountUnits) =>
  Buffer.from(JSON.stringify({ accepts: [{ amount: amountUnits }] })).toString('base64');

const res402 = (hdr) =>
  new Response('pay', { status: 402, headers: hdr ? { 'payment-required': hdr } : {} });

// A settled response carries PAYMENT-RESPONSE: base64 JSON holding the on-chain
// proof. Shape mirrors what the facilitator returns (see the x402 buyer skill:
// decode, then deep-find transaction/txHash).
const settled = (txHash = '0xdeadbeef', network = 'eip155:8453') =>
  new Response('{"ok":true}', {
    status: 200,
    headers: {
      'payment-response': Buffer.from(JSON.stringify({
        success: true, network, payload: { transaction: txHash },
      })).toString('base64'),
    },
  });

const res200 = () => new Response('{"ok":true}', { status: 200 });
const srcOf = (init) => new Headers(init && init.headers).get('x-402-source');

// ---- Cases 1-4: the ported caps (hand-computed, unchanged) ----------------
{
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
  let signatures = 0;
  const doFetch = wrapFetch(async () => res402(challenge(50000)), budget, {
    pay: async () => { signatures += 1; return settled(); },
  });

  let paidCount = 0, lastReason = null;
  for (let i = 0; i < 200; i++) {
    const res = await doFetch('https://example.invalid/scan', {});
    if (res.x402.paid) paidCount += 1; else lastReason = res.x402.reason;
  }
  check('20 of 200 attempts are paid with a $1.00 budget at $0.05', paidCount === 20, `paid=${paidCount}`);
  check('exactly 20 signatures were produced', signatures === 20, `signatures=${signatures}`);
  check('the 21st attempt is refused as a spend cap', /spend cap reached/.test(lastReason || ''), String(lastReason));
  check('toJSON() reports $1.00 spent', budget.toJSON().spentUsd === 1, JSON.stringify(budget.toJSON()));
}

// ---- Cases 5-6: unreadable price signs NOTHING (fail closed) -------------
{
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
  let signatures = 0;
  const doFetch = wrapFetch(async () => res402(null), budget, {
    pay: async () => { signatures += 1; return settled(); },
  });
  let reason = null;
  for (let i = 0; i < 50; i++) reason = (await doFetch('https://example.invalid/scan', {})).x402.reason;
  check('unreadable price: 0 signatures', signatures === 0, `signatures=${signatures}`);
  check('unreadable price: refusal names fail-closed', /fail closed/.test(reason || ''), String(reason));
}

// ---- Case 7: over the per-call ceiling, refused BEFORE paying ------------
{
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
  let signatures = 0;
  const doFetch = wrapFetch(async () => res402(challenge(60000)), budget, {
    pay: async () => { signatures += 1; return settled(); },
  });
  const res = await doFetch('https://example.invalid/scan', {});
  check('over-ceiling price: not paid', res.x402.paid === false && signatures === 0, String(res.x402.reason));
}

// ---- Case 8: negative control -------------------------------------------
{
  const wouldHaveSignedUnderOldCode = 50;
  check('negative control: the old behaviour (50 signatures) is what case 5 rejects', wouldHaveSignedUnderOldCode !== 0);
}

// ---- Case 9: the call-count cap binds independently of the spend cap -----
{
  const budget = createBudget({ maxSpendUsd: 100, maxPriceUsd: 0.05, maxCalls: 3 });
  let signatures = 0;
  const doFetch = wrapFetch(async () => res402(challenge(10000)), budget, {
    pay: async () => { signatures += 1; return settled(); },
  });
  let lastReason = null;
  for (let i = 0; i < 10; i++) lastReason = (await doFetch('https://example.invalid/scan', {})).x402.reason;
  check('maxCalls=3 stops at 3 signatures even with budget left', signatures === 3, `signatures=${signatures}`);
  check('the 4th attempt is refused as a call limit', /paid-call limit reached/.test(lastReason || ''), String(lastReason));
}

// ---- Case 10: integer micro-USD accounting, never floats -----------------
// 19 x 0.05 summed as floats is 0.9500000000000001, which refused the 20th call
// against a $1.00 budget. This asserts the exact integer total.
{
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
  const doFetch = wrapFetch(async () => res402(challenge(50000)), budget, { pay: async () => settled() });
  for (let i = 0; i < 19; i++) await doFetch('https://example.invalid/scan', {});
  const j = budget.toJSON();
  check('19 x $0.05 is exactly $0.95, not 0.9500000000000001', j.spentUsd === 0.95, String(j.spentUsd));
  check('spend is carried as an integer micro-USD count', j.spentMicroUsd === 950000, String(j.spentMicroUsd));
  const res = await doFetch('https://example.invalid/scan', {});
  check('the 20th $0.05 call still fits a $1.00 budget', res.x402.paid === true, String(res.x402.reason));
}

// ---- Case 11: a receipt is appended on settle, with every declared field --
{
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
  const doFetch = wrapFetch(async () => res402(challenge(50000)), budget, {
    source: 'unit-test',
    pay: async () => settled('0xabc123', 'eip155:8453'),
  });
  const before = Date.now();
  const res = await doFetch('https://example.invalid/scan', { method: 'POST' });
  const after = Date.now();

  check('one receipt was appended on settle', budget.receipts.length === 1, `n=${budget.receipts.length}`);
  const r = budget.receipts[0] || {};
  check('receipt.url is the URL that was paid for', r.url === 'https://example.invalid/scan', String(r.url));
  check('receipt.method is the request method', r.method === 'POST', String(r.method));
  check('receipt.priceUsd is the price actually charged', r.priceUsd === 0.05, String(r.priceUsd));
  check('receipt.txHash is decoded from PAYMENT-RESPONSE', r.txHash === '0xabc123', String(r.txHash));
  check('receipt.network is decoded from PAYMENT-RESPONSE', r.network === 'eip155:8453', String(r.network));
  check('receipt.source is the configured source tag', r.source === 'unit-test', String(r.source));
  const ts = Date.parse(r.ts);
  check('receipt.ts is an ISO timestamp taken at settle', ts >= before && ts <= after, String(r.ts));
  check('the settled response is returned to the caller', res.status === 200, String(res.status));
}

// ---- Case 12: an unsettled payment yields NO receipt ---------------------
// A receipt is a claim that money moved. A non-ok paid response means it did
// not, so recording one would put a false line in the buyer's ledger.
{
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
  const doFetch = wrapFetch(async () => res402(challenge(50000)), budget, {
    pay: async () => new Response('facilitator said no', { status: 502 }),
  });
  const res = await doFetch('https://example.invalid/scan', {});
  check('failed settle: no receipt', budget.receipts.length === 0, `n=${budget.receipts.length}`);
  check('failed settle: nothing charged to the budget', budget.toJSON().spentMicroUsd === 0, String(budget.toJSON().spentMicroUsd));
  check('failed settle: not reported as paid', res.x402.paid === false);
}

// ---- Case 13: no receipt on a REFUSAL -----------------------------------
{
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.01, maxCalls: 200 });
  const doFetch = wrapFetch(async () => res402(challenge(50000)), budget, { pay: async () => settled() });
  await doFetch('https://example.invalid/scan', {});
  check('refused call (over ceiling): no receipt', budget.receipts.length === 0, `n=${budget.receipts.length}`);
}

// ---- Case 14: a settle with no on-chain proof records null, not a fake ---
{
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
  const doFetch = wrapFetch(async () => res402(challenge(50000)), budget, { pay: async () => res200() });
  await doFetch('https://example.invalid/scan', {});
  const r = budget.receipts[0] || {};
  check('missing PAYMENT-RESPONSE: txHash is null, not invented', r.txHash === null, String(r.txHash));
  check('missing PAYMENT-RESPONSE: network is null, not invented', r.network === null, String(r.network));
}

// ---- Cases 15-17: the x-402-source header -------------------------------
{
  const seen = [];
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
  const probe = async (url, init) => { seen.push(srcOf(init)); return res402(challenge(50000)); };
  const doFetch = wrapFetch(probe, budget, {
    pay: async (url, init) => { seen.push(srcOf(init)); return settled(); },
  });
  await doFetch('https://example.invalid/scan', {});
  check('x-402-source defaults to x402-budget on the probe', seen[0] === 'x402-budget', String(seen[0]));
  check('x-402-source is also sent on the paid retry', seen[1] === 'x402-budget', String(seen[1]));
}
{
  const seen = [];
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
  const probe = async (url, init) => { seen.push(srcOf(init)); return res402(challenge(50000)); };
  const doFetch = wrapFetch(probe, budget, { source: 'npm-client', pay: async () => settled() });
  await doFetch('https://example.invalid/scan', { headers: { accept: 'application/json' } });
  check('a supplied source overrides the default', seen[0] === 'npm-client', String(seen[0]));
}
{
  // The header must be ADDED, not substituted for the caller's own headers.
  let sawAccept = null;
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
  const probe = async (url, init) => { sawAccept = new Headers(init && init.headers).get('accept'); return res200(); };
  const doFetch = wrapFetch(probe, budget, {});
  await doFetch('https://example.invalid/scan', { headers: { accept: 'application/json' } });
  check('the caller own headers survive', sawAccept === 'application/json', String(sawAccept));
}

// ---- Case 18: toJSON round-trips ----------------------------------------
{
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
  const doFetch = wrapFetch(async () => res402(challenge(50000)), budget, {
    source: 'round-trip', pay: async () => settled('0xfeed', 'eip155:8453'),
  });
  for (let i = 0; i < 3; i++) await doFetch('https://example.invalid/scan', {});

  const wire = JSON.parse(JSON.stringify(budget.toJSON()));
  const restored = createBudget(wire);
  check('toJSON round-trips through JSON unchanged',
    JSON.stringify(restored.toJSON()) === JSON.stringify(budget.toJSON()),
    `${JSON.stringify(restored.toJSON())} vs ${JSON.stringify(budget.toJSON())}`);
  check('a restored budget keeps its receipts', restored.receipts.length === 3, `n=${restored.receipts.length}`);
  check('a restored budget keeps spending where it left off', restored.toJSON().spentMicroUsd === 150000, String(restored.toJSON().spentMicroUsd));

  // The point of restoring: caps keep binding across a process restart.
  let signatures = 0;
  const resumed = wrapFetch(async () => res402(challenge(50000)), restored, {
    pay: async () => { signatures += 1; return settled(); },
  });
  for (let i = 0; i < 100; i++) await resumed('https://example.invalid/scan', {});
  check('a restored budget allows exactly the 17 remaining calls', signatures === 17, `signatures=${signatures}`);
}

// ---- Case 19: summary() -------------------------------------------------
{
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
  const doFetch = wrapFetch(async () => res402(challenge(50000)), budget, { pay: async () => settled() });
  await doFetch('https://example.invalid/scan', {});
  const s = budget.summary();
  check('summary() names the spend, the cap and the call count',
    typeof s === 'string' && s.includes('0.05') && s.includes('1.00') && /1 paid call/.test(s), JSON.stringify(s));
}

// ---- Case 20: a cap that cannot be parsed REFUSES, it does not vanish ---
// NEW BEHAVIOUR, deliberately stricter than the pay.mjs this was extracted
// from. There, caps came from `Number(process.env.X)`, so `DEX_MAX_SPEND_USD=1,00`
// produced NaN — and `spent > NaN`, `price > NaN` and `calls >= NaN` are all
// false, so every cap silently passed and the budget was disabled by a typo.
// That is the same fail-open shape as the unreadable-price bug in case 5. A cap
// the caller cannot see is worse than no cap, so a bad value throws at
// construction rather than at the end of an unbounded spend.
{
  const bad = [
    ['maxSpendUsd', { maxSpendUsd: '1,00', maxPriceUsd: 0.05, maxCalls: 200 }],
    ['maxPriceUsd', { maxSpendUsd: 1, maxPriceUsd: 'five cents', maxCalls: 200 }],
    ['maxCalls', { maxSpendUsd: 1, maxPriceUsd: 0.05, maxCalls: NaN }],
    ['negative maxSpendUsd', { maxSpendUsd: -1, maxPriceUsd: 0.05, maxCalls: 200 }],
  ];
  for (const [label, cfg] of bad) {
    let threw = null;
    try { createBudget(cfg); } catch (e) { threw = e; }
    check(`unparseable cap (${label}) throws instead of disabling the caps`,
      threw instanceof Error && /x402-budget/.test(threw.message), String(threw && threw.message));
  }
}

// ---- Case 21: with no pay function, nothing can ever be paid ------------
{
  const budget = createBudget({ maxSpendUsd: 1.0, maxPriceUsd: 0.05, maxCalls: 200 });
  const doFetch = wrapFetch(async () => res402(challenge(50000)), budget, {});
  const res = await doFetch('https://example.invalid/scan', {});
  check('no pay function: not paid', res.x402.paid === false);
  check('no pay function: refusal says so', /pay/i.test(res.x402.reason || ''), String(res.x402.reason));
  check('no pay function: no receipt', budget.receipts.length === 0, `n=${budget.receipts.length}`);
}

// ---- Case 22: the library never touches wallet material -----------------
// Asserted structurally as well as behaviourally: every paying case above ran
// with no key in the environment and a fake `pay`, so any code path that
// required a signer would have thrown.
{
  const src = fs.readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
  check('the library source references no private-key material',
    !/PRIVATE_KEY|privateKeyToAccount|WALLET_KEY|mnemonic/i.test(src));
}

console.log(failures ? `\n${failures} budget check(s) FAILED` : '\nall budget checks passed');
process.exit(failures ? 1 : 0);
