// Does the bootstrap token still authenticate? The registry is the authority; the token
// LIST page is not. [ask-the-authority] [positive-probe]
const fs = require('fs');
const NPMRC = 'C:/Users/donny/AppData/Local/Temp/x402-budget-publish.npmrc';
const tok = (fs.readFileSync(NPMRC, 'utf8').match(/_authToken=(\S+)/) || [])[1];
(async () => {
  const who = await fetch('https://registry.npmjs.org/-/whoami', { headers: { authorization: `Bearer ${tok}` } });
  console.log('whoami status ' + who.status + '  ' + (await who.text()).slice(0, 120));
  const list = await fetch('https://registry.npmjs.org/-/npm/v1/tokens', { headers: { authorization: `Bearer ${tok}` } });
  const b = await list.text();
  let names = 'unparsed';
  try { const j = JSON.parse(b); names = (j.objects || j.tokens || []).map((r) => r.name); } catch {}
  console.log('token list status ' + list.status + '  names=' + JSON.stringify(names));
})();
