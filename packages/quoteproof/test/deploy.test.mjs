// The deploy script, offline. The signing path is exercised with a throwaway in-memory key that
// has never existed anywhere else and holds nothing; no transaction is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFeeMarket1559TxFromRLP } from '@ethereumjs/tx';
import { createCustomCommon, Mainnet, Hardfork } from '@ethereumjs/common';
import { bytesToHex, privateToAddress, randomBytes } from '@ethereumjs/util';
import { buildSignedDeployTx } from '../scripts/deploy-4663.mjs';
import { compile } from '../scripts/compile.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/deploy-4663.mjs', import.meta.url));

test('signed deployment is chain 4663, contract creation, zero value, recovers to the signer', () => {
  const key = randomBytes(32);
  const bytecode = compile().QuoteRegistry.bytecode;
  const signed = buildSignedDeployTx({ privateKey: key, nonce: 0n, gasLimit: 800_000n, maxFeePerGas: 2n * 10n ** 7n, maxPriorityFeePerGas: 0n, data: bytecode });
  const common = createCustomCommon({ chainId: 4663 }, Mainnet, { hardfork: Hardfork.Cancun });
  const decoded = createFeeMarket1559TxFromRLP(signed.serialize(), { common });
  assert.equal(decoded.chainId, 4663n);
  assert.equal(decoded.to, undefined, 'contract creation has no recipient');
  assert.equal(decoded.value, 0n);
  assert.equal(bytesToHex(decoded.data), bytecode);
  assert.equal(decoded.getSenderAddress().toString(), bytesToHex(privateToAddress(key)));
});

test('with no key under the target the script prints the hand step, exits 2, and sends nothing', { skip: process.platform !== 'win32' ? 'Credential Manager is Windows-only' : false }, () => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8', timeout: 90000,
    // A target nobody stores, and an RPC that cannot answer: reaching the network would fail loudly.
    env: { ...process.env, QUOTEPROOF_DEPLOY_TARGET: 'quoteproof/test-never-stored', QUOTEPROOF_RPC: 'http://127.0.0.1:9/unreachable' },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /Contract NOT deployed/);
  assert.match(r.stdout, /--generate-key/);
  assert.doesNotMatch(r.stdout + r.stderr, /sent 0x/);
});

test('credman refuses any target outside quoteproof/', { skip: process.platform !== 'win32' ? 'Windows-only' : false }, () => {
  const ps1 = fileURLToPath(new URL('../scripts/credman.ps1', import.meta.url));
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Mode', 'Probe', '-Target', 'rh-agentic-desk/alpaca-paper-key'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /REFUSED/);
});
