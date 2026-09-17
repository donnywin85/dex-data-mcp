// Revoke the bootstrap token through the registry API. No browser, no dialog to block on.
// Prints ids and names only — never a token value, and never npm's masked display string.
const fs = require('fs');
const NPMRC = 'C:/Users/donny/AppData/Local/Temp/x402-budget-publish.npmrc';
const tok = (fs.readFileSync(NPMRC, 'utf8').match(/_authToken=(\S+)/) || [])[1];
const H = { authorization: `Bearer ${tok}`, accept: 'application/json' };
const safe = (o) => JSON.parse(JSON.stringify(o, (k, v) =>
  (/^(token|value|key|cidr_whitelist)$/i.test(k) ? '[redacted]' : v)));

(async () => {
  const list = await fetch('https://registry.npmjs.org/-/npm/v1/tokens', { headers: H });
  const body = await list.text();
  console.log('LIST status ' + list.status);
  let objs;
  try { objs = JSON.parse(body); } catch { console.log('non-JSON: ' + body.slice(0, 200)); return; }
  const rows = objs.objects || objs.tokens || [];
  console.log(JSON.stringify(safe(rows).map((r) => ({
    id: r.id, name: r.name, created: r.created, expires: r.expires,
    bypass2FA: r.bypass_2fa !== undefined ? r.bypass_2fa : r.bypass2FA,
  })), null, 2));

  const mine = rows.find((r) => r.name === 'x402-budget-first-publish');
  if (!mine) { console.log('token not found by name in the API listing'); return; }
  const id = mine.id || mine.key;
  console.log('revoking id ' + id);
  const del = await fetch(`https://registry.npmjs.org/-/npm/v1/tokens/token/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: H,
  });
  console.log('DELETE status ' + del.status + '  ' + (await del.text()).slice(0, 250).replace(/\s+/g, ' '));

  // Positive re-probe: the token must no longer authenticate. [positive-probe]
  const who = await fetch('https://registry.npmjs.org/-/whoami', { headers: H });
  console.log('post-revoke whoami status ' + who.status + '  ' + (await who.text()).slice(0, 120));
})();
