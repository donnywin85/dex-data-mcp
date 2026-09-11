// Re-measure the trusted-publisher endpoints NOW THAT THE PACKAGE EXISTS.
// The prior ResourceNotFound was taken against a name npm had never heard of, so it
// could not distinguish "no such route" from "no such package". [stale-premise]
// Reads the token from the 0600 userconfig; never prints it. [fingerprints-only]
const fs = require('fs');
const crypto = require('crypto');
const NPMRC = 'C:/Users/donny/AppData/Local/Temp/x402-budget-publish.npmrc';
const tok = (fs.readFileSync(NPMRC, 'utf8').match(/_authToken=(\S+)/) || [])[1];
if (!tok) { console.log('no token in userconfig'); process.exit(2); }
console.log('token fingerprint sha256/12: ' + crypto.createHash('sha256').update(tok).digest('hex').slice(0, 12));

const urls = [
  'https://registry.npmjs.org/-/package/x402-budget/oidc',
  'https://registry.npmjs.org/-/package/x402-budget/trusted-publisher',
  'https://registry.npmjs.org/-/npm/v1/trusted-publishers?package=x402-budget',
  'https://registry.npmjs.org/-/package/x402-budget/collaborators',
  // positive control: a route that certainly exists, proving the instrument is alive
  'https://registry.npmjs.org/-/whoami',
];

(async () => {
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { authorization: `Bearer ${tok}`, accept: 'application/json' } });
      const body = (await r.text()).slice(0, 220);
      console.log(`${r.status}  ${u}\n      ${body.replace(/\s+/g, ' ')}`);
    } catch (e) {
      console.log(`ERR   ${u}  ${String(e.message || e)}`);
    }
  }
})();
