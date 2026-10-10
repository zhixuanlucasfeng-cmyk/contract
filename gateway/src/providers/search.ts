// Search: web + news. Normalized item: { title, url, snippet, publish_time, author, source }
import type { Item, Tool } from '../types.js';
import { get, post, json, strip, iso, hasCJK } from './http.js';

const hit = (source: string, x: Partial<Record<string, unknown>>): Item =>
  ({ title: x.title ?? '', url: x.url ?? '', snippet: x.snippet ?? '', publish_time: iso(x.publish_time), author: x.author ?? null, source });
const md = (x: Item) => `- [${x.title}](${x.url})${x.publish_time ? ` · ${String(x.publish_time).slice(0, 10)}` : ''}\n  ${x.snippet}`;
const OUT = '{ title, url, snippet, publish_time, author, source }';
const params = { query: { type: 'string', required: true }, limit: { type: 'integer', default: 5 } } as const;

export const searchTools: Record<string, Tool> = {
  web_search: {
    category: 'Search', description: 'Search the web.', params, credits: 1, output: OUT, markdown: md, dedupe: (x) => String(x.url),
    providers: [
      { id: 'tavily', needs: 'TAVILY_API_KEY', async *stream({ query, limit }, c) {
        const d = await json(await post('https://api.tavily.com/search', { query, max_results: limit }, c, { authorization: `Bearer ${c.key}` }));
        for (const x of d.results ?? []) yield hit('tavily', { title: x.title, url: x.url, snippet: x.content, publish_time: x.published_date });
      } },
      { id: 'brave', needs: 'BRAVE_API_KEY', async *stream({ query, limit }, c) {
        const d = await json(await get(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, c, { 'x-subscription-token': c.key! }));
        for (const x of d.web?.results ?? []) yield hit('brave', { title: x.title, url: x.url, snippet: strip(x.description), publish_time: x.page_age });
      } },
      { id: 'serper', needs: 'SERPER_API_KEY', async *stream({ query, limit }, c) {
        const d = await json(await post('https://google.serper.dev/search', { q: query, num: limit }, c, { 'x-api-key': c.key! }));
        for (const x of d.organic ?? []) yield hit('serper', { title: x.title, url: x.link, snippet: x.snippet, publish_time: x.date });
      } },
      { id: 'exa', needs: 'EXA_API_KEY', async *stream({ query, limit }, c) {
        const d = await json(await post('https://api.exa.ai/search', { query, numResults: limit }, c, { 'x-api-key': c.key! }));
        for (const x of d.results ?? []) yield hit('exa', { title: x.title, url: x.url, snippet: x.text ?? '', publish_time: x.publishedDate, author: x.author });
      } },
      { id: 'perplexity', needs: 'PERPLEXITY_API_KEY', async *stream({ query, limit }, c) {
        const d = await json(await post('https://api.perplexity.ai/search', { query, max_results: limit }, c, { authorization: `Bearer ${c.key}` }));
        for (const x of d.results ?? []) yield hit('perplexity', { title: x.title, url: x.url, snippet: x.snippet, publish_time: x.date });
      } },
      // No-key public APIs keep the gateway useful (and failover testable) with zero setup.
      { id: 'wikipedia', probe: { query: 'test', limit: 1 }, async *stream({ query, limit }, c) {
        const lang = hasCJK(query) ? 'zh' : 'en';
        const d = await json(await get(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`, c));
        for (const x of d.query?.search ?? [])
          yield hit('wikipedia', { title: x.title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, '_'))}`, snippet: strip(x.snippet), publish_time: x.timestamp });
      } },
      { id: 'duckduckgo', probe: { query: 'python', limit: 1 }, async *stream({ query, limit }, c) {
        const d = await json(await get(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, c));
        const flat = [...(d.AbstractURL ? [{ Text: d.AbstractText, FirstURL: d.AbstractURL, Heading: d.Heading }] : []), ...(d.RelatedTopics ?? []).flatMap((t: any) => t.Topics ?? [t])];
        for (const x of flat.filter((t: any) => t.FirstURL).slice(0, limit))
          yield hit('duckduckgo', { title: x.Heading || String(x.Text ?? '').split(' - ')[0].slice(0, 80), url: x.FirstURL, snippet: x.Text ?? '' });
      } },
    ],
  },

  news_search: {
    category: 'Search', description: 'Search recent news articles.', params, credits: 1, output: OUT, markdown: md, dedupe: (x) => String(x.url),
    providers: [
      { id: 'serper-news', needs: 'SERPER_API_KEY', async *stream({ query, limit }, c) {
        const d = await json(await post('https://google.serper.dev/news', { q: query, num: limit }, c, { 'x-api-key': c.key! }));
        for (const x of d.news ?? []) yield hit('serper-news', { title: x.title, url: x.link, snippet: x.snippet, publish_time: x.date, author: x.source });
      } },
      { id: 'tavily-news', needs: 'TAVILY_API_KEY', async *stream({ query, limit }, c) {
        const d = await json(await post('https://api.tavily.com/search', { query, max_results: limit, topic: 'news' }, c, { authorization: `Bearer ${c.key}` }));
        for (const x of d.results ?? []) yield hit('tavily-news', { title: x.title, url: x.url, snippet: x.content, publish_time: x.published_date });
      } },
      { id: 'gdelt', probe: { query: 'economy', limit: 1 }, async *stream({ query, limit }, c) {
        const d = await json(await get(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=${limit}&sort=datedesc`, c));
        const ts = (s: string) => s?.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
        for (const x of d.articles ?? []) yield hit('gdelt', { title: x.title, url: x.url, snippet: x.domain, publish_time: ts(x.seendate), author: x.domain });
      } },
    ],
  },
};
