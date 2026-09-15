#!/usr/bin/env node
// quoteproof CLI — the same four tools, from a terminal.
//
//   quoteproof pools [--block N]
//   quoteproof quote NVDA [--depth-bps 50] [--block N]
//   quoteproof hook AAPL [--block N]
//   quoteproof nav NVDA [--block N]
//   quoteproof hash < output.json        keccak256 of the canonical JSON, for QuoteRegistry.anchor

import { callTool } from './tools.ts';
import { httpGetJson, httpTransport } from './rpc.ts';
import { quoteHash } from './reader.ts';

const USAGE = 'usage: quoteproof <pools|quote|hook|nav> [TICKER] [--block N] [--depth-bps N]\n       quoteproof hash < output.json';

function flag(argv: string[], name: string): number | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`${name} needs a number`);
  return v;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ticker] = argv;
  if (cmd === 'hash') {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    console.log(quoteHash(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    return 0;
  }
  const names: Record<string, string> = { pools: 'list_stock_pools', quote: 'quote_stock_token', hook: 'prove_pool_hook', nav: 'nav_context' };
  if (!cmd || !names[cmd]) { console.error(USAGE); return 2; }
  const args: Record<string, unknown> = { block: flag(argv, '--block') };
  if (cmd !== 'pools') args.ticker = ticker;
  if (cmd === 'quote') args.depth_bps = flag(argv, '--depth-bps');
  const out = await callTool({ rpc: httpTransport(), get: httpGetJson() }, names[cmd], args);
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => { console.error(String((e as Error)?.message ?? e)); process.exitCode = 1; },
);
