#!/usr/bin/env node
// contract-mcp --key ct_… [--url https://your-gateway]  (or CONTRACT_KEY / CONTRACT_URL)
// A thin MCP stdio client of the gateway:
//  - tools/list asks the gateway every time → tools added server-side appear without updating this package
//  - find_tools searches the live catalog by keyword / category
//  - tools/call streams from the gateway and forwards each item as an MCP progress notification when the client
//    asked for progress, then returns the complete result
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const key = arg('key') ?? process.env.CONTRACT_KEY;
const url = (arg('url') ?? process.env.CONTRACT_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
if (!key) { console.error('usage: contract-mcp --key ct_…  [--url http://gateway:8080]'); process.exit(1); }

const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(url + path, { ...init, headers });
  const body: any = await r.json();
  if (!r.ok) throw new Error(body.error?.message ?? r.statusText);
  return body;
}
type T = { name: string; description: string; credits: number; input_schema: object; available: boolean; providers: string[] };
const tools = async () => Object.entries((await api('/v1/tools')).categories as Record<string, T[]>).flatMap(([category, ts]) => ts.map((t) => ({ ...t, category })));

const server = new Server({ name: 'contract', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'find_tools', description: 'Search the tools this gateway offers right now, by keyword or category (Search, Scrape, Social, Crypto, Finance, E-commerce, Business).',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, category: { type: 'string' } } } },
    ...(await tools()).filter((t) => t.available).map((t) => ({ name: t.name, description: `${t.description} [${t.category}, ${t.credits} credits]`, inputSchema: t.input_schema as any })),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'find_tools') {
      const q = String(args.query ?? '').toLowerCase(), c = String(args.category ?? '').toLowerCase();
      const hits = (await tools()).filter((t) => (!c || t.category.toLowerCase() === c) && (!q || `${t.name} ${t.description}`.toLowerCase().includes(q)));
      return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] };
    }
    const token = req.params._meta?.progressToken;
    const r = await fetch(`${url}/v1/tools/${name}/execute`, { method: 'POST', headers, body: JSON.stringify({ params: args, stream: true }) });
    if (!r.ok) throw new Error(((await r.json()) as any).error?.message ?? r.statusText);
    const items: any[] = []; let done: any = null, buf = '';
    const dec = new TextDecoder();
    for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const e = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (e.type === 'item') {
          items.push(e.data);
          if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: items.length, message: JSON.stringify(e.data).slice(0, 300) } });
        } else if (e.type === 'error') throw new Error(e.error.message);
        else done = e;
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify({ items, providers: done?.providers, credits: done?.credits }, null, 2) }] };
  } catch (e: any) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
});

await server.connect(new StdioServerTransport());
