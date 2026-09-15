// Minimal ABI word handling — only what the pool reads need. No encoder for dynamic types.
import { keccak256, selector } from './keccak.ts';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Selectors derived from their signatures at load time; test/keccak.test.ts pins them against
 *  the literals edge-lab's premium capture has been calling successfully since 2026-09-11. */
export const SEL = {
  slot0: selector('slot0()'),
  liquidity: selector('liquidity()'),
  fee: selector('fee()'),
  tickSpacing: selector('tickSpacing()'),
  token0: selector('token0()'),
  token1: selector('token1()'),
  tickBitmap: selector('tickBitmap(int16)'),
  ticks: selector('ticks(int24)'),
  decimals: selector('decimals()'),
  symbol: selector('symbol()'),
  uiMultiplier: selector('uiMultiplier()'),
  extsload: selector('extsload(bytes32)'),
} as const;

export const TOPIC_V4_INITIALIZE = keccak256('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');

const TWO256 = 1n << 256n;

/** Two's-complement 32-byte word (no 0x) for a signed or unsigned integer. */
export function word(v: bigint | number): string {
  let b = BigInt(v);
  if (b < 0n) b += TWO256;
  if (b < 0n || b >= TWO256) throw new Error(`value out of 256-bit range: ${v}`);
  return b.toString(16).padStart(64, '0');
}

export const addressWord = (addr: string): string => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`not an address: ${addr}`);
  return addr.slice(2).toLowerCase().padStart(64, '0');
};

/** The i-th 32-byte word of an ABI return, unsigned. Throws on a short return. */
export function uintAt(ret: string, i: number): bigint {
  const h = ret.startsWith('0x') ? ret.slice(2) : ret;
  const w = h.slice(i * 64, (i + 1) * 64);
  if (w.length !== 64) throw new Error(`ABI return too short: wanted word ${i}, got ${h.length / 2} bytes`);
  return BigInt('0x' + w);
}

export function intAt(ret: string, i: number): bigint {
  const u = uintAt(ret, i);
  return u >= 1n << 255n ? u - TWO256 : u;
}

export const addressAt = (ret: string, i: number): string => '0x' + uintAt(ret, i).toString(16).padStart(40, '0');

/** Sign-extend the low `bits` of a bigint. */
export function signed(v: bigint, bits: number): bigint {
  const m = 1n << BigInt(bits);
  const x = v & (m - 1n);
  return x >= m >> 1n ? x - m : x;
}

/** Decode an ABI-encoded `string` return. Returns null for anything that is not one (some
 *  older tokens return bytes32 for symbol()). */
export function stringAt(ret: string): string | null {
  try {
    const off = Number(uintAt(ret, 0)) / 32;
    const len = Number(uintAt(ret, off));
    const h = ret.slice(2 + (off + 1) * 64, 2 + (off + 1) * 64 + len * 2);
    if (h.length !== len * 2) return null;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** keccak256(abi.encode(bytes32|int key, uint256 slot)) — a Solidity mapping slot. */
export function mappingSlot(keyWord: string, slot: bigint): string {
  return keccak256('0x' + keyWord + word(slot), 'hex');
}

export const eqAddr = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
