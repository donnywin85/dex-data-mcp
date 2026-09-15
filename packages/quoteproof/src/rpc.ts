// JSON-RPC and HTTP transports. Keyless, public endpoints only.
//
// The read path is edge-lab/capture/premium.cjs's, which has run unattended every 15 minutes
// since 2026-09-11: an ordinary desktop User-Agent (the public RPC's Cloudflare front returns
// HTTP 403 after ~25 requests without one and 200 with one — no login, key, cookie or challenge
// is involved), a timeout on every call, a minimum gap between requests, and ONE retry for a
// transient status only.
//
// What this adds: every call in a quote carries the SAME explicit block tag. Sending
// eth_blockNumber and then slot0 at `latest` does not pin a block — the two calls race, and
// open-house-entry-draft-001 published a price that the chain does not return at the block it
// was stamped with (playbook lesson 60).

export type Transport = (method: string, params: unknown[]) => Promise<unknown>;
export type HttpGetJson = (url: string) => Promise<unknown>;

export const DEFAULT_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const CHAIN_ID = 4663;
export const VERSION = '0.1.0';
export const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) quoteproof/${VERSION} (read-only; +https://github.com/donnywin85/dex-data-mcp)`;

export class RpcError extends Error {
  method: string;
  constructor(method: string, message: string) {
    super(`${method}: ${message}`);
    this.method = method;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);

export interface HttpOptions {
  url?: string;
  userAgent?: string;
  timeoutMs?: number;
  /** Minimum milliseconds between request starts. premium.cjs runs at 120. */
  minGapMs?: number;
  fetchImpl?: typeof fetch;
}

/** A serial gate: callers queue, so concurrent tool calls cannot burst past the gap. */
function gate(minGapMs: number): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  let last = 0;
  return () => {
    const next = chain.then(async () => {
      const due = last + minGapMs - Date.now();
      if (due > 0) await sleep(due);
      last = Date.now();
    });
    chain = next.catch(() => undefined);
    return next;
  };
}

export function httpTransport(opts: HttpOptions = {}): Transport {
  const url = opts.url ?? process.env.QUOTEPROOF_RPC ?? DEFAULT_RPC;
  const ua = opts.userAgent ?? USER_AGENT;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const f = opts.fetchImpl ?? fetch;
  const wait = gate(opts.minGapMs ?? Number(process.env.QUOTEPROOF_MIN_GAP_MS ?? 150));
  let id = 1;

  const once = async (method: string, params: unknown[]) => {
    await wait();
    try {
      const r = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': ua },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await r.text();
      let json: { result?: unknown; error?: { message?: string } } | null = null;
      try { json = JSON.parse(text); } catch { /* handled below */ }
      return { status: r.status, json, text };
    } catch (e) {
      return { status: 0, json: null, text: String((e as Error)?.message ?? e) };
    }
  };

  return async (method, params) => {
    let r = await once(method, params);
    if (!(r.status === 200 && r.json) && (r.status === 0 || TRANSIENT.has(r.status))) {
      await sleep(r.status === 429 ? 3000 : 1200);
      r = await once(method, params);
    }
    if (r.status !== 200) throw new RpcError(method, `HTTP ${r.status || 'network error'} ${r.text.slice(0, 120)}`);
    if (!r.json) throw new RpcError(method, 'non-JSON body');
    if (r.json.error) throw new RpcError(method, JSON.stringify(r.json.error).slice(0, 200));
    if (!('result' in r.json)) throw new RpcError(method, 'result missing');
    return r.json.result;
  };
}

export function httpGetJson(opts: { userAgent?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): HttpGetJson {
  const f = opts.fetchImpl ?? fetch;
  return async (url) => {
    const r = await f(url, { headers: { 'user-agent': opts.userAgent ?? USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 20000) });
    const text = await r.text();
    if (!r.ok) throw new Error(`GET ${new URL(url).host}: HTTP ${r.status}`);
    return JSON.parse(text);
  };
}

// ---- fixtures -------------------------------------------------------------------------------

export interface RecordedCall { method: string; params: unknown[]; result: unknown }
export interface RecordedGet { url: string; json: unknown }

const key = (method: string, params: unknown[]) => JSON.stringify([method, params]);

export function recordingTransport(inner: Transport, log: RecordedCall[]): Transport {
  return async (method, params) => {
    const result = await inner(method, params);
    log.push({ method, params, result });
    return result;
  };
}

export function recordingGet(inner: HttpGetJson, log: RecordedGet[]): HttpGetJson {
  return async (url) => {
    const json = await inner(url);
    log.push({ url, json });
    return json;
  };
}

/** Replays a recording. A request the recording does not contain THROWS — a fixture test that
 *  silently fell through to the network would be a live test wearing a fixture's name. */
export function replayTransport(calls: RecordedCall[]): Transport {
  const m = new Map<string, unknown>();
  for (const c of calls) m.set(key(c.method, c.params), c.result);
  return async (method, params) => {
    const k = key(method, params);
    if (!m.has(k)) throw new RpcError(method, `fixture miss for ${k.slice(0, 160)}`);
    return m.get(k);
  };
}

export function replayGet(gets: RecordedGet[]): HttpGetJson {
  const m = new Map(gets.map((g) => [g.url, g.json]));
  return async (url) => {
    if (!m.has(url)) throw new Error(`fixture miss for GET ${url}`);
    return m.get(url);
  };
}
