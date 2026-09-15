#!/usr/bin/env node
// quoteproof MCP server — Robinhood Chain stock-token pool reads as MCP tools.
//
// Same conventions as dex-data-mcp's server.mjs: MCP over stdio as newline-delimited JSON-RPC 2.0
// with zero runtime dependencies, required arguments enforced before any request, and
// notifications never answered. Unlike dex-data-mcp it calls no paid route and holds no wallet:
// every tool is a keyless read of public chain state.

import { createInterface } from 'node:readline';
import { callTool, TOOLS } from './tools.ts';
import { httpGetJson, httpTransport, VERSION } from './rpc.ts';
import type { Ctx } from './reader.ts';

const ctx: Ctx = { rpc: httpTransport(), get: httpGetJson() };

function send(msg: unknown) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(req: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }) {
  const { method, params } = req;
  if (method === 'initialize') {
    return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'quoteproof', version: VERSION } };
  }
  if (method === 'tools/list') {
    return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  }
  if (method === 'tools/call') {
    try {
      const out = await callTool(ctx, String(params?.name), params?.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false };
    } catch (e) {
      return { content: [{ type: 'text', text: String((e as Error)?.message ?? e) }], isError: true };
    }
  }
  if (method === 'ping') return {};
  const err = new Error(`method not found: ${method}`) as Error & { code?: number };
  err.code = -32601;
  throw err;
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let req: { id?: unknown; method?: string };
  try { req = JSON.parse(t); } catch { return; }
  const isNotification = req.id === undefined || req.id === null;
  try {
    const result = await handle(req);
    if (!isNotification) send({ jsonrpc: '2.0', id: req.id, result });
  } catch (e) {
    if (!isNotification) send({ jsonrpc: '2.0', id: req.id, error: { code: (e as { code?: number }).code ?? -32603, message: String((e as Error)?.message ?? e) } });
  }
});
