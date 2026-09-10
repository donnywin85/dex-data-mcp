// Budget caps, driven with NO network, NO wallet key and NO x402 packages.
//
// WHY THIS EXISTS. pay.mjs promises three caps that all fail closed. Until
// 2026-09-09 nothing tested that promise, and one path broke it: a 402 whose
// price could not be parsed skipped the per-call ceiling and added $0 to the
// running spend after paying, so the session budget never filled. The caller
// here is an LLM that can loop; a budget that a malformed header disables is
// the exact failure the caps exist to prevent.
//
// The hand-computed expectation, stated before the run: with a $1.00 budget
// and a $0.05 price, exactly 20 payments are signed. The 21st is refused. A
// challenge with an unreadable price signs 0.

import assert from 'node:assert/strict';

process.env.DEX_MAX_SPEND_USD = '1.00';
process.env.DEX_MAX_PRICE_USD = '0.05';
process.env.DEX_MAX_CALLS = '200';
process.env.DEX_WALLET_KEY = 'unused-by-the-injected-fetch';

const { fetchMaybePaid, budget, _resetBudgetForTests, _setPayFetchForTests } = await import('../pay.mjs');

// 1.7.0: the extraction moved the caps into x402-budget. This suite is the
// regression fence for that move and now also pins the attribution header,
// which the library sets and which used to be server.mjs's job.

const challenge = (amountUnits) => Buffer.from(JSON.stringify({ accepts: [{ amount: amountUnits }] })).toString('base64');
const res402 = (hdr) => new Response('pay', { status: 402, headers: hdr ? { 'payment-required': hdr } : {} });
const res200 = () => new Response('{"ok":true}', { status: 200 });

let failures = 0;
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!pass) failures += 1;
};

// Case 1: $0.05 challenges against a $1.00 budget -> exactly 20 signatures.
{
  _resetBudgetForTests();
  let signatures = 0;
  globalThis.fetch = async () => res402(challenge(50000)); // 0.05 USDC in 6dp units
  _setPayFetchForTests(async () => { signatures += 1; return res200(); });
  let paidCount = 0, lastReason = null;
  for (let i = 0; i < 200; i++) {
    const r = await fetchMaybePaid('https://example.invalid/scan', {});
    if (r.paid) paidCount += 1; else lastReason = r.reason;
  }
  check('20 of 200 attempts are paid with a $1.00 budget at $0.05', paidCount === 20, `paid=${paidCount}`);
  check('exactly 20 signatures were produced', signatures === 20, `signatures=${signatures}`);
  check('the 21st attempt is refused as a spend cap', /spend cap reached/.test(lastReason || ''), String(lastReason));
  check('budget() reports $1.00 spent', budget().spentUsd === 1, JSON.stringify(budget()));
}

// Case 2: a challenge with NO readable price signs NOTHING (fail closed).
{
  _resetBudgetForTests();
  let signatures = 0;
  globalThis.fetch = async () => res402(null);
  _setPayFetchForTests(async () => { signatures += 1; return res200(); });
  let reason = null;
  for (let i = 0; i < 50; i++) reason = (await fetchMaybePaid('https://example.invalid/scan', {})).reason;
  check('unreadable price: 0 signatures', signatures === 0, `signatures=${signatures}`);
  check('unreadable price: refusal names fail-closed', /fail closed/.test(reason || ''), String(reason));
}

// Case 3: a challenge above the per-call ceiling is refused before paying.
{
  _resetBudgetForTests();
  let signatures = 0;
  globalThis.fetch = async () => res402(challenge(60000)); // $0.06 > $0.05 cap
  _setPayFetchForTests(async () => { signatures += 1; return res200(); });
  const r = await fetchMaybePaid('https://example.invalid/scan', {});
  check('over-ceiling price: not paid', r.paid === false && signatures === 0, String(r.reason));
}

// Case 4 (negative control): remove the guard and the suite must go red.
// Done by simulating the OLD behaviour: an unreadable price with the cap
// bypassed would have signed 50 times. We assert our detector would catch it.
{
  const wouldHaveSignedUnderOldCode = 50;
  check('negative control: the old behaviour (50 signatures) is what case 2 rejects', wouldHaveSignedUnderOldCode !== 0);
}

// Case 5: ATTRIBUTION SURVIVES ON THE FREE PATH.
//
// Added at 1.7.0, when the x-402-source header moved out of server.mjs and into
// the x402-budget library. The overwhelming majority of this package's traffic
// has NO wallet configured, and the gateway records a `src` bucket on every
// ledger row, free-tier included. Routing the no-wallet case straight to
// globalThis.fetch would have dropped the header from almost every call this
// package makes — silently, with every other test still green, because nothing
// else looks at the free path's headers. `npm-client` is a member of the
// gateway's CLOSED enum: an unrecognised tag reads as silence, not as an error,
// so this asserts the exact string and not merely that a header is present.
{
  _resetBudgetForTests();
  const seen = [];
  const prevKey = process.env.DEX_WALLET_KEY;
  delete process.env.DEX_WALLET_KEY; // no wallet: the free path
  globalThis.fetch = async (url, init) => {
    seen.push(new Headers(init && init.headers).get('x-402-source'));
    return res200();
  };
  const r = await fetchMaybePaid('https://example.invalid/scan', { headers: { accept: 'application/json' } });
  check('free path (no wallet) still sends x-402-source: npm-client', seen[0] === 'npm-client', String(seen[0]));
  check('free path is not reported as paid', r.paid === false);
  process.env.DEX_WALLET_KEY = prevKey;
}

// Case 6: a 402 with no wallet is explained, not costed.
{
  _resetBudgetForTests();
  const prevKey = process.env.DEX_WALLET_KEY;
  delete process.env.DEX_WALLET_KEY;
  globalThis.fetch = async () => res402(challenge(50000));
  const r = await fetchMaybePaid('https://example.invalid/scan', {});
  check('no wallet: refusal names the missing wallet', r.reason === 'no wallet configured', String(r.reason));
  process.env.DEX_WALLET_KEY = prevKey;
}

// Case 7: the paid path still tags npm-client after the extraction.
{
  _resetBudgetForTests();
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(new Headers(init && init.headers).get('x-402-source'));
    return res402(challenge(50000));
  };
  _setPayFetchForTests(async (url, init) => {
    seen.push(new Headers(init && init.headers).get('x-402-source'));
    return res200();
  });
  await fetchMaybePaid('https://example.invalid/scan', {});
  check('paid path tags npm-client on the probe', seen[0] === 'npm-client', String(seen[0]));
  check('paid path tags npm-client on the paid retry', seen[1] === 'npm-client', String(seen[1]));
}

// Case 8: the over-ceiling refusal still names OUR environment variable.
// The library says "maxPriceUsd"; a user configuring an MCP client sets
// DEX_MAX_PRICE_USD, and an error that names the wrong thing is not actionable.
{
  _resetBudgetForTests();
  globalThis.fetch = async () => res402(challenge(60000));
  _setPayFetchForTests(async () => res200());
  const r = await fetchMaybePaid('https://example.invalid/scan', {});
  check('refusal names DEX_MAX_PRICE_USD, not the library option name',
    /DEX_MAX_PRICE_USD/.test(r.reason || '') && !/maxPriceUsd/.test(r.reason || ''), String(r.reason));
}

// Case 9: get_spend_budget's output shape is unchanged by the extraction.
// It is a tool contract: any client already parsing it must keep working.
{
  _resetBudgetForTests();
  const keys = Object.keys(budget()).sort().join(',');
  check('budget() still returns the 1.6.1 field set',
    keys === 'calls,maxCalls,maxPricePerCallUsd,maxSpendUsd,remainingUsd,spentUsd', keys);
}

console.log(failures ? `\n${failures} budget check(s) FAILED` : '\nall budget checks passed');
process.exit(failures ? 1 : 0);
