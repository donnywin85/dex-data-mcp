# x402-budget-npm-publish-002 — evidence

Run 2026-09-10/11 (UTC 01:25–01:45Z). Every claim below has a file in this directory.

## Premise (brief's, and it was half right)

| claim | measured | file |
|---|---|---|
| :9222 Chrome signed in to npmjs.com | **HELD** — `loggedIn=true`, `donnywin85`, both signals agreeing | `npm-session-probe.json` |
| the web sign-in completes the CLI login without a code | **REFUTED** — escalates to WebAuthn security key | `cli-login-screen.json`, `escalate-options.json` |

Run 001 measured this same browser as signed **out**. It genuinely changed between runs;
Donny's 23:33Z sign-in landed in the :9222 profile after all.

## The four gates, as this run met them

1. **CLI identity** — `npm whoami` → `E401 401 Unauthorized - GET https://registry.npmjs.org/-/whoami`.
2. **CLI web login** — `npm login --auth-type=web --browser=false` printed a URL inside its
   ~5-minute window; the :9222 tab opened it and npm answered
   `/escalate/webauthn` → *"Two-Factor Authentication … Security key … Use security key"*.
   **That screen offers exactly one method** — enumerated every link and button, there is no
   TOTP, no recovery code, no "use another method" (`escalate-options.json`). A WebAuthn
   ceremony is a physical gesture; `isUserVerifyingPlatformAuthenticatorAvailable()` returns
   true (Windows Hello is present), which makes it Donny's finger, not a secret the box holds.
3. **2FA / OTP on publish** — cleared by the brief's pre-authorised fallback (below), not by a code.
4. **Trusted publisher** — still web-UI-only, re-measured against a package that now EXISTS
   (`tp-api-probe.txt`). This mattered: 001's `ResourceNotFound` was taken against a name npm
   had never heard of and could not distinguish "no such route" from "no such package".
   With `/-/package/x402-budget/collaborators` → `200 {"donnywin85":"write"}` as a live positive
   control, all three publisher routes still 404. The route does not exist. The page escalates.

## The publish

Brief route (c), taken only after (b) was measured structurally unavailable:
granular token `x402-budget-first-publish`, **publish-only**, **7 days** (expires 2026-09-17),
bypass-2FA, scope *all packages* — a name that does not exist yet cannot be listed under
"only select packages", so that was the only shape that could publish it.

- Value never printed: written straight to a `0600` userconfig outside the repo, used for one
  command, file deleted. Fingerprint only: **sha256/12 `f859d4c1e6eb`**, length 40.
- `npm whoami --userconfig …` → `donnywin85` (asked of the registry, not a local file).
- `npm publish --access public --userconfig …` → `+ x402-budget@0.1.0`.
- Readback on two instruments: `npm view x402-budget version` → **0.1.0**; raw registry doc
  `dist-tags.latest=0.1.0`, `shasum=4e291f1b2a187b7bad64d09e84bff9880387f5dd` — **identical to
  the local `npm pack`**, so what is on npm is what was built here.
- `npm view dex-data-mcp version` → **1.6.1**, unchanged. No tag cut.

Provenance is impossible from the box: it requires OIDC from a CI runner. Later releases get it.

## ⚠ Residual: the token could not be revoked from here

Both revocation routes are closed to this box, measured:

- **Registry API** — `DELETE /-/npm/v1/tokens/token/<id>` → **403**, and the token still
  authenticates afterwards (`whoami 200`). This is npm's Aug 2026 restriction: a bypass-2FA
  token may not make *account changes*, and revoking a token is one.
- **Web UI** — the row's delete control fires a native `confirm("Are you sure?")`, then lands on
  the same *Security key / Use password* escalation. Verified against the authority, not the
  page: the token list still returns `x402-budget-first-publish` (`token-status-after-revoke.txt`).

**It expires 2026-09-17 on its own. Donny should delete it at npmjs.com → Settings → Access
Tokens.** This is exactly why the brief specified a 7-day expiry — the cap held when revocation
did not.

*(A native `confirm()` blocks every `page.evaluate` until something answers it. The first revoke
attempt hung on that and had to be killed, which stranded the chrome-mutex lock and an orphan
tab; both were cleaned — the lock was verified mine by `caller`+`pid` before deletion.)*

## CI

`publish-x402-budget.yml` dispatched **dry_run=true** on `x402-budget`
(run `34551729827`, **success**) — safe to repeat, since `dry_run` skips the publish entirely.
A real run would only fail on the immutable 0.1.0 and, with no trusted publisher registered,
could not exercise OIDC anyway. It proves the tarball guard fixed in 001 works on the real
runner under `npm@latest`: **`OK: 4 files, no tests, no env`**.

## Two things this run nearly got wrong

**A screenshot held the token in cleartext.** npm shows a new token once, in a
"Token successfully generated" banner, and the post-generate screenshot captured it.
`token-generated.png` was **deleted before any `git add`** — confirmed never tracked
(`git log --all -- <path>` empty, `git ls-files --error-unmatch` → "did not match any file").
The lesson is that `value-printed=0` has to cover **pixels**, not just stdout and files: a
grep for `npm_[A-Za-z0-9]{20,}` over the artifacts passes cleanly either way, because a PNG
does not match a text grep. Screenshots taken on a credential-issuing page need their own check.
The masked display string npm renders in the token *list* (`npm_z5RJ......ndrg`) was scrubbed
from `token-rows.json` for the same reason.

**`stillListed: false` was a false negative.** After the delete the driver reloaded
`/settings/donnywin85/tokens/delete`, which is a **404 page** (`revoke-after.png`) — it lists
no tokens, so "the name is absent" meant nothing at all. The registry is what settled it:
`GET /-/npm/v1/tokens` still returns `x402-budget-first-publish`, and the token still
authenticates. A page that cannot display the answer is not evidence of the answer.
