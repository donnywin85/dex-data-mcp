// keccak256, selectors and v4 storage slots — checked against sources this package did not write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { keccak256, selector } from '../src/keccak.ts';
import { SEL, TOPIC_V4_INITIALIZE, mappingSlot } from '../src/abi.ts';
import { POOLS, type V4Pool } from '../src/pools.ts';
import { v4PoolId } from '../src/reader.ts';

const require = createRequire(import.meta.url);

test('published keccak256 vectors', () => {
  assert.equal(keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
});

test('matches js-sha3 over lengths 0..400, covering multi-block absorbs', () => {
  const jsSha3 = require('js-sha3') as { keccak256: (b: Uint8Array) => string };
  for (let n = 0; n <= 400; n++) {
    const b = new Uint8Array(n).map((_, i) => (i * 131 + n * 7) & 255);
    assert.equal(keccak256(b), '0x' + jsSha3.keccak256(b), `length ${n}`);
  }
});

test('selectors equal the literals edge-lab premium.cjs calls successfully on chain 4663', () => {
  assert.deepEqual(
    { decimals: SEL.decimals, token0: SEL.token0, token1: SEL.token1, slot0: SEL.slot0, extsload: SEL.extsload, uiMultiplier: SEL.uiMultiplier, fee: SEL.fee },
    { decimals: '0x313ce567', token0: '0x0dfe1681', token1: '0xd21220a7', slot0: '0x3850c7bd', extsload: '0x1e2eaeaf', uiMultiplier: '0xa60bf13d', fee: '0xddca3f43' },
  );
  assert.equal(selector('transfer(address,uint256)'), '0xa9059cbb');
});

test('Initialize topic equals the topic0 decoded in rwa-venue-recon-001/41-v4-hooks.txt', () => {
  assert.equal(TOPIC_V4_INITIALIZE, '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438');
});

test('v4 slot0 keys reproduce the four keys venues.json pinned from the chain', () => {
  const pinned: Record<string, string> = {
    AAPL: '0x2fdb6d780b05f494c8a4cd7919827c266d25bf49d5a2a8d2fcc9975d4a25f531',
    GOOGL: '0x8d3d14c5df27cf7b0bb6bf29ec29f031d2f9fcc508785a75e0618b7ef32020f2',
    SPY: '0x072e769bb05404d75b36da2825ed92f690cc12e401eff209e8d818afd438f2f5',
    QQQ: '0x233ee377c37045310ce50469be2e8513d55bd8759fc5afc25278b81a36abcd21',
  };
  const v4 = POOLS.filter((p): p is V4Pool => p.version === 'v4');
  assert.equal(v4.length, 4);
  for (const p of v4) assert.equal(mappingSlot(p.poolId.slice(2), 6n), pinned[p.ticker], p.ticker);
});

test('every pinned v4 PoolKey hashes to its pinned poolId', () => {
  for (const p of POOLS.filter((x): x is V4Pool => x.version === 'v4')) assert.equal(v4PoolId(p), p.poolId.toLowerCase(), p.ticker);
});
