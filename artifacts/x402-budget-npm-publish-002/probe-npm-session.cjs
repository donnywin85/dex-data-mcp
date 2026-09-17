// P0 premise check: is the :9222 Chrome signed in to npmjs.com?
// Uses the estate's own probe module. Own tab, disconnect never close (module does both).
const path = 'C:/Users/donny/Documents/empire-command/scripts/npm-identity.cjs';
const mod = require(path);

(async () => {
  const out = await mod.probeCapabilityRow({ browserURL: 'http://127.0.0.1:9222' });
  console.log(JSON.stringify({ at: new Date().toISOString(), ...out }, null, 2));
})().catch((e) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), loggedIn: null, basis: 'probe threw: ' + String(e && e.message || e) }, null, 2));
  process.exitCode = 3;
});
