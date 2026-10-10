// Every tool the gateway offers. Add a provider file and spread it here; /v1/tools and MCP pick it up at runtime.
import type { Tool } from './types.js';
import { searchTools } from './providers/search.js';
import { scrapeTools } from './providers/scrape.js';
import { socialTools } from './providers/social.js';
import { cryptoTools } from './providers/crypto.js';
import { financeTools } from './providers/finance.js';
import { commerceTools } from './providers/commerce.js';
import { businessTools } from './providers/business.js';

export const TOOLS: Record<string, Tool> = {
  ...searchTools, ...scrapeTools, ...socialTools, ...cryptoTools, ...financeTools, ...commerceTools, ...businessTools,
};

export const SECRET_NAMES = [...new Set(Object.values(TOOLS).flatMap((t) => t.providers.flatMap((p) => [p.needs, p.optional]).filter(Boolean) as string[]))];

const example = (k: string) => ({ query: 'chainsaw man', url: 'https://example.com', coin: 'bitcoin', symbol: 'AAPL', address: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe', series: 'UNRATE', country: 'CN', indicator: 'NY.GDP.MKTP.CD', ts_code: '600519.SH', name: 'Anthropic' } as Record<string, string>)[k];

export function catalog(usable: (p: Tool['providers'][number]) => boolean) {
  const categories: Record<string, unknown[]> = {};
  for (const [name, t] of Object.entries(TOOLS)) {
    const live = t.providers.filter(usable).map((p) => p.id);
    (categories[t.category] ??= []).push({
      name, description: t.description, credits: t.credits, output: t.output,
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, { type: v.type, ...(v.default !== undefined ? { default: v.default } : {}), ...(v.description ? { description: v.description } : {}) }])),
        required: Object.entries(t.params).filter(([, v]) => v.required).map(([k]) => k),
      },
      example: { params: Object.fromEntries(Object.entries(t.params).filter(([, v]) => v.required).map(([k]) => [k, example(k)])) },
      providers: live, available: live.length > 0,
    });
  }
  return { categories };
}
