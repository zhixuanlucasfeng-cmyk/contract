// E-commerce: product search through marketplaces' official developer APIs.
// Not included: Amazon (PA-API needs an approved Associates account), Taobao / JD / TikTok Shop (partner programs);
// add them as providers once you have those credentials — never by scraping.
import type { Tool } from '../types.js';
import { get, json, num } from './http.js';

export const commerceTools: Record<string, Tool> = {
  product_search: {
    category: 'E-commerce', description: 'Search products and prices on marketplaces (eBay, Best Buy).', credits: 2,
    params: { query: { type: 'string', required: true }, limit: { type: 'integer', default: 10 } },
    output: '{ title, price, currency, url, seller, source }',
    markdown: (x) => `- [${x.title}](${x.url}) · **${x.price} ${x.currency}** · ${x.seller ?? ''} · ${x.source}`,
    dedupe: (x) => String(x.url),
    providers: [
      { id: 'ebay', needs: 'EBAY_OAUTH_TOKEN', async *stream({ query, limit }, c) {
        const d = await json(await get(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=${limit}`, c, { authorization: `Bearer ${c.key}`, 'x-ebay-c-marketplace-id': 'EBAY_US' }));
        for (const i of d.itemSummaries ?? []) yield { title: i.title, price: num(i.price?.value), currency: i.price?.currency, url: i.itemWebUrl, seller: i.seller?.username ?? null, source: 'ebay' };
      } },
      { id: 'bestbuy', needs: 'BESTBUY_API_KEY', async *stream({ query, limit }, c) {
        const terms = String(query).split(/\s+/).map((w) => `search=${encodeURIComponent(w)}`).join('&');
        const d = await json(await get(`https://api.bestbuy.com/v1/products((${terms}))?apiKey=${c.key}&format=json&show=name,salePrice,url&pageSize=${limit}`, c));
        for (const p of d.products ?? []) yield { title: p.name, price: num(p.salePrice), currency: 'USD', url: p.url, seller: 'Best Buy', source: 'bestbuy' };
      } },
    ],
  },
};
