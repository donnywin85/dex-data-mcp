// check-coverage.mjs — does this MCP server expose everything the gateway sells?
//
// MCP is the distribution channel that actually works: ~672 npm downloads a week
// against essentially zero organic paid API calls. A product that ships on the
// gateway but never gets an MCP tool is invisible on the only channel with
// traction, and nothing used to notice — the gateway repo and this one are
// separate, so no single CI job could see both sides.
//
// This runs at RELEASE time, not on every commit, and deliberately so: it needs
// the network, and x402-gateway's CI gates its Railway deploys. A flaky
// network check there would block shipping the gateway for reasons that have
// nothing to do with the gateway. Here the worst case is a delayed npm publish.
//
//   node scripts/check-coverage.mjs          # fail on an uncovered product
//   node scripts/check-coverage.mjs --warn   # report only, never fail
//
// Chain-prefixed routes collapse to one family: the gateway sells /price,
// /base/price, /polygon/price and so on, but a single tool covers them all via
// its `chain` argument. Comparing raw paths would report 40 phantom gaps.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const GATEWAY = (process.env.X402_BASE || 'https://x402.donnyautomation.com').replace(/\/$/, '');
const WARN_ONLY = process.argv.includes('--warn');

const CHAINS = ['bsc', 'polygon', 'arbitrum', 'base', 'avalanche', 'optimism'];

// Products with no MCP tool, each with a reason. This list is the point of the
// file: an uncovered product is either a deliberate choice or an oversight, and
// the difference has to be written down or it decays into "we never noticed".
//
// Anything NOT listed here and NOT covered fails the check — so shipping a new
// gateway product without a tool breaks the next release rather than going
// unnoticed until someone reads two repos side by side.
const EXEMPT = {
  '/call': 'legacy generic proxy, superseded by the named product routes',
  '/v4hooks': 'one-off research product, not part of the general catalogue',
  // ↓ NOT deliberate. Real gaps, listed so they are visible and countable.
  '/gas': 'GAP — no tool yet. Demand data ranked this 21 paying wallets, second only to geocoding.',
  '/reserves': 'GAP — no tool yet. Pool reserves across 6 chains.',
  '/scan': 'GAP — no tool yet. Arbitrage scanner, 6 chains.',
};

function familyOf(p) {
  const m = p.match(new RegExp(`^/(${CHAINS.join('|')})(/.*)$`));
  return m ? m[2] : p;
}

const res = await fetch(`${GATEWAY}/openapi.json`, { signal: AbortSignal.timeout(30000) });
if (!res.ok) throw new Error(`gateway /openapi.json returned HTTP ${res.status}`);
const openapi = await res.json();

// /demo/* is the free try-before-you-pay surface, not a sold product.
const sold = [...new Set(
  Object.keys(openapi.paths || {}).filter((p) => !p.startsWith('/demo')).map(familyOf),
)].sort();

// Every gateway path a tool targets, read from the route template literals.
// Parsing the source rather than importing: server.mjs is a stdio server and
// importing it starts a readline loop that never returns.
const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const covered = new Set([...src.matchAll(/`(\/[a-z][a-z-]*)/g)].map((m) => m[1]));

const missing = sold.filter((p) => !covered.has(p) && !(p in EXEMPT));
const gaps = sold.filter((p) => !covered.has(p) && p in EXEMPT);

console.log(`gateway sells ${sold.length} product families; this server covers ${sold.filter((p) => covered.has(p)).length}`);
if (gaps.length) {
  console.log(`\n  known uncovered (${gaps.length}) — listed in EXEMPT, not silently dropped:`);
  for (const p of gaps) console.log(`    ${p.padEnd(18)} ${EXEMPT[p]}`);
}

// A stale exemption is its own bug: it hides a product that no longer exists and
// would mask a real gap if the path were ever reused.
const stale = Object.keys(EXEMPT).filter((p) => !sold.includes(p) || covered.has(p));
if (stale.length) {
  console.log(`\n  ⚠ stale EXEMPT entries (product gone, or now covered): ${stale.join(', ')}`);
}

if (missing.length) {
  console.error(`\n✖ ${missing.length} gateway product(s) have no MCP tool and no EXEMPT entry:`);
  for (const p of missing) console.error(`    ${p}`);
  console.error('\nAdd a tool to server.mjs, or an EXEMPT entry with a reason. MCP is the');
  console.error('channel with actual traction — shipping a product that never reaches it');
  console.error('is the failure this check exists to catch.');
  if (!WARN_ONLY) process.exit(1);
}

console.log(missing.length ? '\n(--warn set: not failing)' : '\n✅ every sold product is covered or explicitly exempt');
