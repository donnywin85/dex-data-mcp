// QuoteRegistry — compiled with solc-js 0.8.26 and executed on an in-process EVM
// (@ethereumjs/vm, Prague rules). No network, no chain, no key: callers are fixed test addresses
// with no private key behind them, which runCall does not need.
//
// Neither Hardhat nor Foundry was installed on the build box (`forge` on PATH is Atlassian's CLI),
// and the brief forbade a global install, so the toolchain is two pinned local devDependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVM } from '@ethereumjs/vm';
import { createBlock } from '@ethereumjs/block';
import { createAccount, createAddressFromString, hexToBytes, bytesToHex, bigIntToBytes, setLengthLeft } from '@ethereumjs/util';
import { compile } from '../scripts/compile.mjs';
import { keccak256 } from '../src/keccak.ts';

const ART = compile();
const REG = ART.QuoteRegistry;
const MID = REG.methodIdentifiers;

const DEPLOYER = '0x' + '11'.repeat(20);
const ALICE = '0x' + '22'.repeat(20);
const BOB = '0x' + '33'.repeat(20);
const POOL = '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3';
const OTHER_POOL = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const HASH = keccak256('{"kind":"quote","ticker":"NVDA"}');
const HASH2 = keccak256('{"kind":"quote","ticker":"AAPL"}');
const ARBSYS = '0x0000000000000000000000000000000000000064';

const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const aw = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const hw = (h) => h.slice(2);
const errSel = (sig) => keccak256(sig).slice(0, 10);

async function setup({ number = 100, timestamp = 1_757_966_400, arbL2Block = null } = {}) {
  const vm = await createVM();
  for (const a of [DEPLOYER, ALICE, BOB]) {
    await vm.stateManager.putAccount(createAddressFromString(a), createAccount({ nonce: 0n, balance: 10n ** 20n }));
  }
  const env = { number, timestamp };
  const block = () => createBlock({ header: { number: BigInt(env.number), timestamp: BigInt(env.timestamp), gasLimit: 30_000_000n } }, { common: vm.common });
  if (arbL2Block !== null) {
    const arb = createAddressFromString(ARBSYS);
    await vm.stateManager.putAccount(arb, createAccount({ nonce: 0n, balance: 0n }));
    await vm.stateManager.putCode(arb, hexToBytes(ART.MockArbSys.deployedBytecode));
    await vm.stateManager.putStorage(arb, setLengthLeft(new Uint8Array([0]), 32), bigIntToBytes(BigInt(arbL2Block)));
  }
  const dep = await vm.evm.runCall({ caller: createAddressFromString(DEPLOYER), data: hexToBytes(REG.bytecode), gasLimit: 5_000_000n, block: block() });
  assert.equal(dep.execResult.exceptionError, undefined, 'deployment must not revert');
  const registry = dep.createdAddress;

  async function send(from, sigAndArgs, { value = 0n } = {}) {
    const r = await vm.evm.runCall({
      caller: createAddressFromString(from), to: registry, data: hexToBytes(sigAndArgs), value, gasLimit: 1_000_000n, block: block(),
    });
    const ret = bytesToHex(r.execResult.returnValue);
    return { reverted: !!r.execResult.exceptionError, ret, logs: r.execResult.logs ?? [], gas: r.execResult.executionGasUsed };
  }
  const anchor = (from, hash, pool, blk, opts) => send(from, '0x' + MID['anchor(bytes32,address,uint256)'] + hw(hash) + aw(pool) + w(blk), opts);
  const verify = async (hash) => {
    const r = await send(ALICE, '0x' + MID['verify(bytes32)'] + hw(hash));
    const h = r.ret.slice(2);
    const word = (i) => BigInt('0x' + h.slice(i * 64, i * 64 + 64));
    return {
      anchored: word(0) === 1n,
      submitter: '0x' + word(1).toString(16).padStart(40, '0'),
      pool: '0x' + word(2).toString(16).padStart(40, '0'),
      quotedBlock: word(3), anchoredBlock: word(4), anchoredTime: word(5),
    };
  };
  const verifyQuote = async (hash, pool, blk) => {
    const r = await send(ALICE, '0x' + MID['verifyQuote(bytes32,address,uint256)'] + hw(hash) + aw(pool) + w(blk));
    return BigInt(r.ret) === 1n;
  };
  const view = async (sig) => BigInt((await send(ALICE, '0x' + MID[sig])).ret);
  return { vm, env, registry, send, anchor, verify, verifyQuote, view };
}

test('deploy: pauser is the deployer, not paused, nothing payable', async () => {
  const c = await setup();
  assert.equal('0x' + (await c.view('pauser()')).toString(16).padStart(40, '0'), DEPLOYER);
  assert.equal(await c.view('paused()'), 0n);
  assert.ok(REG.abi.every((e) => e.type !== 'receive' && e.type !== 'fallback' && e.stateMutability !== 'payable'), 'no payable entry, receive or fallback');
});

test('mutating surface is exactly anchor, pause, unpause', () => {
  const mutating = REG.abi.filter((e) => e.type === 'function' && !['view', 'pure'].includes(e.stateMutability)).map((e) => e.name).sort();
  assert.deepEqual(mutating, ['anchor', 'pause', 'unpause']);
});

test('anchor stores the record and emits QuoteAnchored', async () => {
  const c = await setup({ number: 100, timestamp: 1_757_966_400 });
  const r = await c.anchor(ALICE, HASH, POOL, 99);
  assert.equal(r.reverted, false);
  assert.equal(r.logs.length, 1);
  const [addr, topics, data] = r.logs[0];
  assert.equal(bytesToHex(addr), c.registry.toString());
  assert.equal(bytesToHex(topics[0]), keccak256('QuoteAnchored(bytes32,address,address,uint256,uint256,uint256)'));
  assert.equal(bytesToHex(topics[1]), HASH);
  assert.equal(bytesToHex(topics[2]), '0x' + aw(POOL));
  assert.equal(bytesToHex(topics[3]), '0x' + aw(ALICE));
  assert.equal(bytesToHex(data), '0x' + w(99) + w(100) + w(1_757_966_400));
  console.log(`    gas: first anchor executionGasUsed=${r.gas}`);
});

test('verify: unknown hash is not anchored and all fields are zero', async () => {
  const c = await setup();
  const v = await c.verify(HASH);
  assert.deepEqual(v, { anchored: false, submitter: '0x' + '0'.repeat(40), pool: '0x' + '0'.repeat(40), quotedBlock: 0n, anchoredBlock: 0n, anchoredTime: 0n });
});

test('verify: returns submitter, pool, quoted block, anchored block and time', async () => {
  const c = await setup({ number: 250, timestamp: 1_757_970_000 });
  await c.anchor(BOB, HASH, POOL, 240);
  assert.deepEqual(await c.verify(HASH), { anchored: true, submitter: BOB, pool: POOL, quotedBlock: 240n, anchoredBlock: 250n, anchoredTime: 1_757_970_000n });
});

test('verifyQuote: true only for the exact pool and quoted block', async () => {
  const c = await setup();
  await c.anchor(ALICE, HASH, POOL, 90);
  assert.equal(await c.verifyQuote(HASH, POOL, 90), true);
  assert.equal(await c.verifyQuote(HASH, OTHER_POOL, 90), false);
  assert.equal(await c.verifyQuote(HASH, POOL, 91), false);
  assert.equal(await c.verifyQuote(HASH2, POOL, 90), false);
});

test('replay refusal: a known hash reverts AlreadyAnchored for any sender and the first record stands', async () => {
  const c = await setup({ number: 100 });
  assert.equal((await c.anchor(ALICE, HASH, POOL, 99)).reverted, false);
  c.env.number = 150;
  const expected = errSel('AlreadyAnchored(bytes32,uint256)') + hw(HASH) + w(100);
  const same = await c.anchor(ALICE, HASH, POOL, 99);
  assert.equal(same.reverted, true);
  assert.equal(same.ret, expected);
  const other = await c.anchor(BOB, HASH, OTHER_POOL, 149);
  assert.equal(other.reverted, true);
  assert.equal(other.ret, expected);
  assert.equal(other.logs.length, 0);
  assert.deepEqual(await c.verify(HASH), { anchored: true, submitter: ALICE, pool: POOL, quotedBlock: 99n, anchoredBlock: 100n, anchoredTime: 1_757_966_400n });
});

test('pause: only the pauser can pause or unpause; paused blocks anchors but never views', async () => {
  const c = await setup();
  await c.anchor(ALICE, HASH, POOL, 99);
  const notPauser = errSel('NotPauser()');
  const p1 = await c.send(ALICE, '0x' + MID['pause()']);
  assert.equal(p1.reverted, true);
  assert.equal(p1.ret, notPauser);
  const p2 = await c.send(DEPLOYER, '0x' + MID['pause()']);
  assert.equal(p2.reverted, false);
  assert.equal(bytesToHex(p2.logs[0][1][0]), keccak256('Paused(address)'));
  assert.equal(await c.view('paused()'), 1n);
  const blocked = await c.anchor(BOB, HASH2, POOL, 99);
  assert.equal(blocked.reverted, true);
  assert.equal(blocked.ret, errSel('AnchoringPaused()'));
  assert.equal((await c.verify(HASH)).anchored, true, 'verify must work while paused');
  assert.equal(await c.verifyQuote(HASH, POOL, 99), true, 'verifyQuote must work while paused');
  const u1 = await c.send(BOB, '0x' + MID['unpause()']);
  assert.equal(u1.reverted, true);
  assert.equal(u1.ret, notPauser);
  const u2 = await c.send(DEPLOYER, '0x' + MID['unpause()']);
  assert.equal(u2.reverted, false);
  assert.equal(bytesToHex(u2.logs[0][1][0]), keccak256('Unpaused(address)'));
  assert.equal((await c.anchor(BOB, HASH2, POOL, 99)).reverted, false);
});

test('input refusals: zero hash, zero pool, zero block, future block, block beyond uint96', async () => {
  const c = await setup({ number: 100 });
  const zero = '0x' + '0'.repeat(64);
  assert.equal((await c.anchor(ALICE, zero, POOL, 99)).ret, errSel('ZeroHash()'));
  assert.equal((await c.anchor(ALICE, HASH, '0x' + '0'.repeat(40), 99)).ret, errSel('ZeroPool()'));
  assert.equal((await c.anchor(ALICE, HASH, POOL, 0)).ret, errSel('ZeroBlock()'));
  assert.equal((await c.anchor(ALICE, HASH, POOL, 101)).ret, errSel('FutureBlock(uint256,uint256)') + w(101) + w(100));
  assert.equal((await c.anchor(ALICE, HASH, POOL, 1n << 96n)).ret, errSel('BlockTooLarge(uint256)') + w(1n << 96n));
  assert.equal((await c.anchor(ALICE, HASH, POOL, 100)).reverted, false, 'the current block itself is allowed');
});

test('Arbitrum path: block checks use ArbSys.arbBlockNumber(), not the NUMBER opcode', async () => {
  // The numbers measured on Robinhood Chain on 2026-09-15: NUMBER returned 25,985,166 while
  // ArbSys.arbBlockNumber() returned 63,927,342.
  const c = await setup({ number: 25_985_166, arbL2Block: 63_927_342 });
  const ok = await c.anchor(ALICE, HASH, POOL, 63_927_000);
  assert.equal(ok.reverted, false, 'an L2 block above NUMBER must be accepted when ArbSys is present');
  const v = await c.verify(HASH);
  assert.equal(v.anchoredBlock, 63_927_342n);
  assert.equal(v.quotedBlock, 63_927_000n);
  const future = await c.anchor(ALICE, HASH2, POOL, 63_927_343);
  assert.equal(future.ret, errSel('FutureBlock(uint256,uint256)') + w(63_927_343) + w(63_927_342));
});

test('without ArbSys the same L2 block would be refused as future (the bug the ArbSys path prevents)', async () => {
  const c = await setup({ number: 25_985_166 });
  const r = await c.anchor(ALICE, HASH, POOL, 63_927_000);
  assert.equal(r.ret, errSel('FutureBlock(uint256,uint256)') + w(63_927_000) + w(25_985_166));
});

test('value is refused: anchor is not payable and there is no receive or fallback', async () => {
  const c = await setup();
  const paid = await c.anchor(ALICE, HASH, POOL, 99, { value: 1n });
  assert.equal(paid.reverted, true);
  const bare = await c.send(ALICE, '0x', { value: 1n });
  assert.equal(bare.reverted, true);
  const acct = await c.vm.stateManager.getAccount(c.registry);
  assert.equal(acct?.balance ?? 0n, 0n);
});
