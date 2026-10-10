// MCP stdio server: a thin client of the gateway. tools/list asks the gateway every time, so tools added on the
// server show up without updating this client (dynamic discovery). find_tools lets an agent search the catalog.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function startMcp({ url, key }) {
  const api = async (path, init = {}) => {
    const r = await fetch(url + path, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error?.message ?? r.statusText);
    return body;
  };
  const tools = async () => Object.values((await api('/v1/tools')).categories).flat();

  const server = new Server({ name: 'contract-lite', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'find_tools', description: 'List or search the tools this gateway offers right now (by category or keyword).',
        inputSchema: { type: 'object', properties: { query: { type: 'string' }, category: { type: 'string' } } } },
      ...(await tools()).map((t) => ({ name: t.name, description: `[${t.description}] (${t.credits} credits)`, inputSchema: t.input_schema })),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
    try {
      if (name === 'find_tools') {
        const q = (args.query ?? '').toLowerCase(), c = (args.category ?? '').toLowerCase();
        const hits = (await api('/v1/tools')).categories;
        const out = Object.entries(hits).filter(([cat]) => !c || cat.toLowerCase() === c)
          .flatMap(([cat, ts]) => ts.filter((t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q)).map((t) => ({ category: cat, ...t })));
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }
      const r = await api(`/v1/tools/${name}/execute`, { method: 'POST', body: JSON.stringify({ params: args, format: 'markdown' }) });
      return { content: [{ type: 'text', text: `${r.content}\n\n(via ${r.providers.join(' → ')}, ${r.credits} credits)` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });
  await server.connect(new StdioServerTransport());
}
