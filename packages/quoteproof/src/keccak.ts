// keccak256 — the pre-NIST Keccak (padding 0x01), which is what the EVM uses.
//
// WHY THIS FILE EXISTS: node:crypto's `sha3-256` is the NIST SHA-3 (padding 0x06) and returns a
// DIFFERENT digest. edge-lab's premium capture worked around the gap by PINNING the v4 storage
// slot as an opaque constant. This reader needs mapping slots it cannot pin in advance (tick
// bitmap words, tick info), a PoolKey -> poolId recomputation, and the Initialize topic, so it
// carries its own hash instead of a runtime dependency.
//
// It is checked three ways in test/keccak.test.ts: published vectors, a cross-check against
// js-sha3 over lengths 0..400 (multi-block absorbs), and reproduction of the four v4 slot0 keys
// that premium.cjs pinned from the chain.

const MASK = (1n << 64n) - 1n;
const ROTL: number[] = [];
const PI: number[] = [];
const IOTA: bigint[] = [];

// Round constants and permutation indices generated from their definitions rather than typed
// in as 72 magic numbers.
{
  let R = 1;
  let x = 1;
  let y = 0;
  for (let round = 0; round < 24; round++) {
    [x, y] = [y, (2 * x + 3 * y) % 5];
    PI.push(5 * y + x);
    ROTL.push((((round + 1) * (round + 2)) / 2) % 64);
    let t = 0n;
    for (let j = 0; j < 7; j++) {
      R = ((R << 1) ^ ((R >> 7) * 0x71)) % 256;
      if (R & 2) t ^= 1n << ((1n << BigInt(j)) - 1n);
    }
    IOTA.push(t);
  }
}

const rotl = (v: bigint, s: number): bigint => (s === 0 ? v : ((v << BigInt(s)) | (v >> BigInt(64 - s))) & MASK);

function permute(s: bigint[]): void {
  const B: bigint[] = new Array(5).fill(0n);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) B[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = B[(x + 4) % 5] ^ rotl(B[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    let cur = s[1];
    for (let t = 0; t < 24; t++) {
      const idx = PI[t];
      const tmp = s[idx];
      s[idx] = rotl(cur, ROTL[t]);
      cur = tmp;
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) B[x] = s[y + x];
      for (let x = 0; x < 5; x++) s[y + x] = B[x] ^ (~B[(x + 1) % 5] & MASK & B[(x + 2) % 5]);
    }
    s[0] ^= IOTA[round];
  }
}

const RATE = 136; // bytes, for a 256-bit output

export function keccak256Bytes(input: Uint8Array): Uint8Array {
  const s: bigint[] = new Array(25).fill(0n);
  const padLen = RATE - (input.length % RATE);
  const msg = new Uint8Array(input.length + padLen);
  msg.set(input);
  msg[input.length] ^= 0x01;
  msg[msg.length - 1] ^= 0x80;
  for (let off = 0; off < msg.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(msg[off + i * 8 + b]);
      s[i] ^= lane;
    }
    permute(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = s[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`not an even-length hex string: ${hex.slice(0, 20)}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = '0x';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** keccak256 of a UTF-8 string, or of raw bytes when given a 0x-prefixed hex string. */
export function keccak256(data: string | Uint8Array, as: 'utf8' | 'hex' = 'utf8'): string {
  if (data instanceof Uint8Array) return bytesToHex(keccak256Bytes(data));
  return bytesToHex(keccak256Bytes(as === 'hex' ? hexToBytes(data) : new TextEncoder().encode(data)));
}

/** 4-byte function selector for a canonical signature such as `slot0()`. */
export const selector = (signature: string): string => keccak256(signature).slice(0, 10);
