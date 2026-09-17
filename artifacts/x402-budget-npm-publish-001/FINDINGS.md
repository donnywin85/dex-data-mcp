# x402-budget-npm-publish-001 — findings

**Verdict: blocked at npm's 2FA/OTP gate. `x402-budget` is NOT on npm. `dex-data-mcp` is
untouched at 1.6.1.**

## The brief's premise was refuted before P1 could start

> *Premise: Donny's Chrome is signed in to npmjs.com and the npm web sign-in flow completes
> without a code when authorised from that session.*

The :9222 Chrome is **signed OUT** of npmjs.com. Three independent instruments agree:

| instrument | reading |
|---|---|
| `window.__context__` (npm's own server-rendered session object) | `user` absent |
| cookie jar for `npmjs.com` | `ISCHECKURLRISK`, `__cf_bm`, `_cfuvid` — Cloudflare/analytics only, **no session cookie** |
| rendered header | "Sign in" link present, no `/~donnywin85` avatar; `/login` serves a real `name="password"` form |

That kills brief route (b) outright — there is no session to authorise a CLI login — and it
kills route (c) too, since minting a granular token also requires being signed in. Both
permitted routes were blocked by the *same* missing session.

## Routes tried, and what each returned

| # | route | result |
|---|---|---|
| 1 | existing token in `~/.npmrc` (`sha256_12=88bb9084d212`) | **dead.** `GET registry.npmjs.org/-/whoami` → `HTTP 401`, asked of the registry directly, not the CLI wrapper |
| 2 | other credential surfaces | no project/user `.npmrc`; `NPM_TOKEN`/`NODE_AUTH_TOKEN`/`NPM_CONFIG_TOKEN` all unset; **no npm-shaped name in the credential store** |
| 3 | first publish via OIDC | structurally impossible. `npm/cli#8544` re-checked live this run: **still OPEN**. A trusted publisher cannot be registered for a package that does not exist |
| 4 | **GitHub Actions + the repo's `NPM_TOKEN` secret** | **got furthest — authenticated, then refused.** See below |
| 5 | trusted-publisher registration via API | no such route. `/-/package/*/oidc`, `/trusted-publisher`, `/-/npm/v1/trusted-publishers` all `ResourceNotFound`, against a live positive control (`/-/package/dex-data-mcp/collaborators` → `200 {"donnywin85":"write"}`). **Web UI only** |
| 6 | restore the web session from a cookie backup | no npmjs.com cookie backup exists anywhere on the box |

## Route 4 is the real finding

Publishing from CI with the repository's `NPM_TOKEN` secret is a *better* position than the
keyboard publish the doctrine assumed: the credential is never on the laptop, never in a
shell, never in a log. It authenticated correctly —

```
authenticated to npm as: donnywin85
```

— and then npm refused the publish itself:

```
npm notice npm tokens that bypass 2FA are being restricted for account changes and direct publishing.
npm error code EOTP
npm error This operation requires a one-time password.
```

**The token is alive and has publish rights. npm no longer accepts it alone for a direct
publish.** This is the GAT 2FA-bypass deprecation landing on a token minted 2026-08-01, and
it is the doctrine's `npm publish 2FA/OTP` row arriving at the last possible step.

Per the brief's fence — *"If npm asks for a one-time code at any point, STOP … never type a
sign-in or a code"* — that is where this stops.

## Why the remaining step is genuinely human

Not merely fenced — **the box could not do it even if it were allowed**. The second factor is
a TOTP on Donny's device, and the credential store holds no npm login secret at all. Both
halves are true, and the second is the one worth recording.

## Fixed on the way through (unrelated to auth, would have broken any future release)

The workflow's own tarball guard — the step that keeps test fixtures and `.env` files out of
the published tarball — was crashing on a `TypeError`, not checking anything. **npm 12.0.2
changed `npm pack --json` from an array of packages to an object keyed by package name**, and
the guard read `[0]`. Because the step above it installs `npm@latest`, this broke on npm 12's
release day with no change to this repo.

Measured rather than guessed: npm 12.0.2 installed into a temp prefix and its real output
captured. The guard now accepts either shape and fails loudly on neither. Proven against 8
cases — both real shapes plus six negatives — in `pack-guard-cases.txt`.

## The systemic gap this exposed

`state/capability-map.json` probes 14 sites for login state. **npmjs.com is not one of them**,
and it is the sole carrier for trusted-publisher registration. The block surfaced at execution
time, inside an approved mutating job, instead of before the job was ever queued.

## One action unblocks everything

**Donny signs in to npmjs.com once in the :9222 Chrome.** That single session then authorises
the CLI web login (P1), makes the publish 2FA-satisfied (P2), *and* is the only surface that
can register the trusted publisher (P3). After that first publish, every later release is OIDC
with no credential in the path — `dex-data-mcp@1.6.1` already publishes exactly that way
(`_npmUser: GitHub Actions`, `trustedPublisher: {id: github}`).

## State left behind

- `x402-budget` — **not on npm** (`HTTP 404`). Nothing was half-published; both failures were
  before the publish call.
- `dex-data-mcp` — **still 1.6.1**, on two instruments. Never tagged, never published.
- Tag `x402-budget-v0.1.0` — **deleted**. It claimed a release that did not happen.
- PR #4 — open, unmerged, as instructed.
- `value-printed=0` — verified by grep over every artifact; GitHub masked the token to `***`.
