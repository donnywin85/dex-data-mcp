// Deploy QuoteRegistry to Robinhood Chain (4663).
//
//   node scripts/deploy-4663.mjs                 dry run: checks everything, sends nothing
//   node scripts/deploy-4663.mjs --live          signs and sends the deployment
//   node scripts/deploy-4663.mjs --generate-key  creates a fresh key INSIDE Credential Manager and
//                                                prints only its address (refuses if one exists)
//
// THE KEY. Read at run time from Windows Credential Manager, target quoteproof/deployer-4663, by
// scripts/credman.ps1 — never from argv, an env var, a file or a settings file. It lives in this
// process's memory only; it is never printed, logged or written. Output carries the deployer
// ADDRESS and a sha256 fingerprint at most. The deployer is the registry's immutable pauser, so the
// key should be a fresh, single-purpose one holding only the gas for this deployment.
//
// FAIL CLOSED. No --live, no transaction. Wrong chain id, a stale committed build, a missing key, or
// a balance below the estimated cost: each exits non-zero before anything is signed.
//
// Exit 0 ok · 2 key missing (the hand step is printed) · 3 refused a precondition · 1 error.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCustomCommon, Mainnet, Hardfork } from '@ethereumjs/common';
import { createFeeMarket1559Tx } from '@ethereumjs/tx';
import { privateToAddress, bytesToHex, hexToBytes, randomBytes } from '@ethereumjs/util';
import { compile } from './compile.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TARGET = process.env.QUOTEPROOF_DEPLOY_TARGET || 'quoteproof/deployer-4663';
const RPC = process.env.QUOTEPROOF_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) quoteproof/0.1.0 (deploy script)';
const CHAIN_ID = 4663;
const CREDMAN = path.join(ROOT, 'scripts', 'credman.ps1');

export const HAND_STEP = [
  `No deployer key under Windows Credential Manager target ${TARGET}. Contract NOT deployed.`,
  'Hand step (Donny):',
  '  1. node scripts/deploy-4663.mjs --generate-key      (creates a fresh key inside Credential Manager, prints only its address)',
  '     or store a fresh key yourself: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/credman.ps1 -Mode Store -Target ' + TARGET,
  '  2. Send a small amount of ETH on Robinhood Chain (4663) to that address. The dry run prints the estimated cost.',
  '  3. node scripts/deploy-4663.mjs            (dry run: confirms key, balance and estimate)',
  '  4. node scripts/deploy-4663.mjs --live     (deploys; writes deployments/4663.json)',
].join('\n');

function credman(mode, input) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CREDMAN, '-Mode', mode, '-Target', TARGET],
    { encoding: 'utf8', input, timeout: 60000, windowsHide: true });
  return { status: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').slice(0, 300) };
}

let rpcId = 1;
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }), signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}

export function buildSignedDeployTx({ privateKey, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, data }) {
  const common = createCustomCommon({ chainId: CHAIN_ID }, Mainnet, { hardfork: Hardfork.Cancun });
  const tx = createFeeMarket1559Tx({ nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, value: 0n, data: hexToBytes(data) }, { common });
  return tx.sign(privateKey);
}

const addressOf = (privateKey) => bytesToHex(privateToAddress(privateKey));

function readKey() {
  const r = credman('Read');
  if (r.status === 2) return null;
  if (r.status !== 0) throw new Error(`credman Read failed (exit ${r.status}): ${r.err}`);
  const hex = r.out.trim().replace(/^0x/, '');
  // Validate the shape without ever echoing the value.
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`the value under ${TARGET} is not a 32-byte hex private key`);
  return hexToBytes('0x' + hex);
}

async function main(argv) {
  const live = argv.includes('--live');

  if (argv.includes('--generate-key')) {
    const probe = credman('Probe');
    if (probe.status === 0) { console.error(`REFUSED: ${TARGET} already holds a value (${probe.out}). Nothing generated.`); return 3; }
    const key = randomBytes(32);
    const stored = credman('Store', bytesToHex(key).slice(2));
    if (stored.status !== 0) { console.error(`store failed: ${stored.err}`); return 1; }
    const back = readKey();
    if (!back || addressOf(back) !== addressOf(key)) { console.error('read-back did not match; do not fund anything'); return 1; }
    console.log(`${stored.out}\ndeployer address: ${addressOf(key)}\nFund this address with a small amount of ETH on chain 4663, then run the dry run.`);
    return 0;
  }

  // 1. The committed build must be what this source compiles to.
  const built = compile().QuoteRegistry;
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'build', 'QuoteRegistry.json'), 'utf8'));
  if (built.bytecode !== committed.bytecode) { console.error('REFUSED: contracts/build/QuoteRegistry.json is stale; run node scripts/compile.mjs'); return 3; }
  console.log(`build: ${built.compiler}, runtime ${(built.deployedBytecode.length - 2) / 2} bytes, source sha256 ${built.sourceSha256.slice(0, 12)}`);

  // 2. The key, before any network: a missing key is the hand step, not a network error.
  const probe = credman('Probe');
  if (probe.status === 2) { console.log(HAND_STEP); return 2; }
  if (probe.status !== 0) { console.error(`credman Probe failed (exit ${probe.status}): ${probe.err}`); return 1; }
  console.log(`key: present under ${TARGET} (${probe.out})`);

  // 3. The chain.
  const chainId = Number(BigInt(await rpc('eth_chainId', [])));
  if (chainId !== CHAIN_ID) { console.error(`REFUSED: RPC chain id ${chainId}, expected ${CHAIN_ID}`); return 3; }
  const arbBlock = BigInt(await rpc('eth_call', [{ to: '0x0000000000000000000000000000000000000064', data: '0xa3b1b31d' }, 'latest']));
  console.log(`chain: ${chainId}, ArbSys.arbBlockNumber ${arbBlock}`);

  const key = readKey();
  if (!key) { console.log(HAND_STEP); return 2; }
  const from = addressOf(key);
  const [balance, nonce, gasPrice, estimate] = await Promise.all([
    rpc('eth_getBalance', [from, 'latest']).then(BigInt),
    rpc('eth_getTransactionCount', [from, 'pending']).then(BigInt),
    rpc('eth_gasPrice', []).then(BigInt),
    rpc('eth_estimateGas', [{ from, data: built.bytecode }]).then(BigInt),
  ]);
  const gasLimit = (estimate * 13n) / 10n;
  const maxFeePerGas = gasPrice * 2n;
  const worstCase = gasLimit * maxFeePerGas;
  console.log(`deployer ${from}: balance ${balance} wei, nonce ${nonce}; estimate ${estimate} gas at ${gasPrice} wei; worst case ${worstCase} wei`);
  if (balance < worstCase) { console.error(`REFUSED: balance ${balance} wei is below the worst-case cost ${worstCase} wei. Fund ${from} on chain 4663.`); return 3; }
  if (!live) { console.log('dry run: nothing signed, nothing sent. Re-run with --live to deploy.'); return 0; }

  const signed = buildSignedDeployTx({ privateKey: key, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas: 0n, data: built.bytecode });
  const txHash = await rpc('eth_sendRawTransaction', [bytesToHex(signed.serialize())]);
  console.log(`sent ${txHash}`);
  let receipt = null;
  for (let i = 0; i < 60 && !receipt; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  }
  if (!receipt) { console.error(`UNKNOWN: no receipt for ${txHash} after 120 s. Check it before re-running; a re-run would deploy twice.`); return 1; }
  if (receipt.status !== '0x1') { console.error(`deployment reverted in block ${BigInt(receipt.blockNumber)}`); return 1; }
  const address = receipt.contractAddress;

  // Positive probe: the deployed contract answers with this deployer as pauser and is not paused.
  const pauser = '0x' + (await rpc('eth_call', [{ to: address, data: '0x' + built.methodIdentifiers['pauser()'] }, 'latest'])).slice(26);
  const paused = BigInt(await rpc('eth_call', [{ to: address, data: '0x' + built.methodIdentifiers['paused()'] }, 'latest']));
  if (pauser.toLowerCase() !== from.toLowerCase() || paused !== 0n) { console.error(`deployed at ${address} but the probe disagrees: pauser ${pauser}, paused ${paused}`); return 1; }

  const record = {
    chainId, address, transactionHash: txHash, blockNumber: Number(BigInt(receipt.blockNumber)), deployer: from,
    gasUsed: Number(BigInt(receipt.gasUsed)), compiler: built.compiler, settings: built.settings, sourceSha256: built.sourceSha256,
    deployedAt: new Date().toISOString(), probe: { pauser, paused: false },
  };
  fs.mkdirSync(path.join(ROOT, 'deployments'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'deployments', '4663.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(`deployed QuoteRegistry at ${address} (block ${record.blockNumber}); wrote deployments/4663.json`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    // Error text only: nothing on any error path holds or interpolates the key.
    (e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; },
  );
}
