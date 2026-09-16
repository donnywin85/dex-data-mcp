// check-coverage.mjs — does this MCP server expose exactly what the gateway LISTS?
//
// ★ WHAT THIS GATE COMPARES AGAINST CHANGED IN 1.7.0, AND THAT IS THE POINT.
//
//   It used to read every path in the gateway's openapi.json and demand a tool
//   for each. That was right while the gateway listed everything it served. On
//   2026-09-16 the storefront was cut to the 12 routes with measured demand or
//   no substitute, while all 62 priced routes CARRY ON BEING SERVED and payable
//   (x402-gateway/artifacts/x402-catalogue-focus-001/KEEP.md). Against openapi
//   the old gate would now demand 50 tools for products the storefront has
//   deliberately stopped recommending — it would enforce precisely the drift
//   this release exists to remove.
//
//   So the authority is now /.well-known/x402, which is the gateway's own
//   statement of what it lists. openapi.json is still read, but only to prove
//   each listed route really exists and to quote its price.
//
// ★ IT RECONCILES BOTH WAYS. [inventory-reconcile]
//
//   listed with no tool   -> FAIL. The front door is missing a room.
//   tool with no listing  -> FAIL. The tool recommends a route the storefront
//                            dropped; it still works, but this package should
//                            not be the thing pointing at it.
//
//   One-way checking is how the two repos drifted apart the first time: nothing
//   could see both sides at once, so "we cover everything" and "we cover only
//   what is sold" were never the same statement.
//
// Runs at RELEASE time, not on every commit: it needs the network, and a flaky
// network check in the commit path would block work for reasons unrelated to it.
// Worst case here is a delayed npm publish.
//
//   node scripts/check-coverage.mjs          # fail on any mismatch
//   node scripts/check-coverage.mjs --warn   # report only, never fail

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const GATEWAY = (process.env.X402_BASE || 'https://x402.donnyautomation.com').replace(/\/$/, '');
const WARN_ONLY = process.argv.includes('--warn');

// Listed routes with no tool, each with a reason and a condition that ends it.
// Empty is the correct state, and it is the state 1.7.0 ships in. An entry here
// is a WAIVER: it re-announces itself on every run, because a silent exemption
// reads as "covered" when it is not. [loud-waiver]
const EXEMPT = {};

const timeout = { signal: AbortSignal.timeout(30000) };

const wellKnownRes = await fetch(`${GATEWAY}/.well-known/x402`, timeout);
if (!wellKnownRes.ok) throw new Error(`gateway /.well-known/x402 returned HTTP ${wellKnownRes.status}`);
const wellKnown = await wellKnownRes.json();

const openapiRes = await fetch(`${GATEWAY}/openapi.json`, timeout);
if (!openapiRes.ok) throw new Error(`gateway /openapi.json returned HTTP ${openapiRes.status}`);
const openapi = await openapiRes.json();

// The resources array holds absolute URLs; reduce to paths.
const listed = [...new Set(
  (wellKnown.resources || []).map((r) => {
    const u = typeof r === 'string' ? r : (r.resource || r.url || '');
    try { return new URL(u).pathname; } catch { return String(u); }
  }).filter(Boolean),
)].sort();

if (!listed.length) {
  // A gate that cannot see the inventory refuses; it never passes. [fail-closed]
  throw new Error('/.well-known/x402 listed 0 resources — refusing to report coverage against an empty inventory');
}

// Ask the route functions what they target rather than pattern-matching the
// source. See the DEX_MCP_DUMP_ROUTES block in server.mjs for why.
const dump = execFileSync(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, DEX_MCP_DUMP_ROUTES: '1' },
  encoding: 'utf8',
});
const tools = dump.trim().split('\n').filter(Boolean).map((l) => {
  const [name, route] = l.split('\t');
  return { name, route };
});
const networked = tools.filter((t) => t.route !== '(local)');
const covered = new Map(networked.map((t) => [t.route, t.name]));

const priceOf = (p) => openapi.paths?.[p]?.get?.['x-payment-info']?.priceUsd || '?';

console.log(`gateway lists ${listed.length} route(s); this server has ${networked.length} route tool(s) `
  + `and ${tools.length - networked.length} local tool(s)\n`);

for (const p of listed) {
  const tool = covered.get(p);
  console.log(`  ${tool ? '✓' : '✖'} ${p.padEnd(22)} ${String(priceOf(p)).padEnd(6)} ${tool || (EXEMPT[p] ? `WAIVED — ${EXEMPT[p]}` : 'NO TOOL')}`);
}

const missing = listed.filter((p) => !covered.has(p) && !(p in EXEMPT));
const waived = listed.filter((p) => !covered.has(p) && p in EXEMPT);
const extra = networked.filter((t) => !listed.includes(t.route));

// A route listed in openapi but absent from it is a broken listing, and it would
// otherwise show up only as a '?' in the price column.
const unknownToOpenapi = listed.filter((p) => !openapi.paths?.[p]);

// A waiver whose route is no longer listed is furniture: it hides nothing and
// would mask a real gap if the path were listed again.
const stale = Object.keys(EXEMPT).filter((p) => !listed.includes(p) || covered.has(p));

const problems = [];
if (missing.length) problems.push(`${missing.length} listed route(s) have no tool and no waiver: ${missing.join(', ')}`);
if (extra.length) problems.push(`${extra.length} tool(s) target a route the gateway does not list: ${extra.map((t) => `${t.name} -> ${t.route}`).join(', ')}`);
if (unknownToOpenapi.length) problems.push(`${unknownToOpenapi.length} listed route(s) are absent from openapi.json: ${unknownToOpenapi.join(', ')}`);
if (stale.length) problems.push(`stale EXEMPT entries (route no longer listed, or now covered): ${stale.join(', ')}`);

if (waived.length) {
  console.log(`\n  ⚠ ${waived.length} listed route(s) WAIVED, not covered:`);
  for (const p of waived) console.log(`    ${p.padEnd(22)} ${EXEMPT[p]}`);
}

if (problems.length) {
  console.error('\n✖ the tool list and the listed catalogue do not agree:');
  for (const m of problems) console.error(`    ${m}`);
  console.error('\nAdd or remove a tool in server.mjs, or add an EXEMPT entry with a reason and');
  console.error('the condition that ends it. This package is the front door to the storefront:');
  console.error('a door with a room missing, or a door onto a room that was closed, is the');
  console.error('failure this check exists to catch.');
  if (!WARN_ONLY) process.exit(1);
  console.log('\n(--warn set: not failing)');
} else {
  console.log('\n✅ every listed route has exactly one tool, and no tool points anywhere else');
}
