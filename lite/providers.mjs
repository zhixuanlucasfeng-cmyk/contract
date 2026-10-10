// Service providers. Each tool (capability) lists providers in priority order; the engine fails over down the list.
// A provider is { id, needs?: 'ENV_KEY', async *stream(params, ctx) } yielding normalized items.
// Providers whose key isn't configured are skipped. Throw ProviderError(status) so the engine can classify it.

export class ProviderError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function http(url, { key, signal, ...init } = {}) {
  const res = await fetch(url, { ...init, signal });
  if (!res.ok) throw new ProviderError(res.status, `${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

const strip = (html) => String(html ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const hasCJK = (s) => /[一-鿿]/.test(s);

// Normalized search item: { title, url, snippet, publish_time, author, source }
const searchItem = (source, x) => ({ title: x.title ?? '', url: x.url ?? '', snippet: x.snippet ?? '', publish_time: x.publish_time ?? null, author: x.author ?? null, source });

// Normalized scrape item: one paragraph of Markdown at a time, so a stream can resume on another provider.
const paragraphs = function* (source, url, markdown, title) {
  if (title) yield { kind: 'meta', title, url, source };
  for (const p of String(markdown).split(/\n{2,}/)) if (p.trim()) yield { kind: 'paragraph', text: p.trim(), source };
};

export const TOOLS = {
  web_search: {
    category: 'Search',
    description: 'Search the web. Returns results with title, url, snippet, publish_time, author.',
    params: { query: { type: 'string', required: true }, limit: { type: 'integer', default: 5 } },
    credits: 1,
    dedupe: (item) => item.url,
    providers: [
      { id: 'tavily', needs: 'TAVILY_API_KEY', async *stream({ query, limit = 5 }, { key, signal }) {
        const r = await http('https://api.tavily.com/search', { signal, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ query, max_results: limit }) });
        for (const x of (await r.json()).results ?? []) yield searchItem('tavily', { title: x.title, url: x.url, snippet: x.content, publish_time: x.published_date });
      } },
      { id: 'brave', needs: 'BRAVE_API_KEY', async *stream({ query, limit = 5 }, { key, signal }) {
        const r = await http(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, { signal, headers: { accept: 'application/json', 'x-subscription-token': key } });
        for (const x of (await r.json()).web?.results ?? []) yield searchItem('brave', { title: x.title, url: x.url, snippet: strip(x.description), publish_time: x.page_age ?? null });
      } },
      // No-key public APIs, so the gateway works (and fails over) out of the box.
      { id: 'wikipedia', async *stream({ query, limit = 5 }, { signal }) {
        const lang = hasCJK(query) ? 'zh' : 'en';
        const r = await http(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`,
          { signal, headers: { 'user-agent': 'contract-lite/0.1 (gateway demo)' } });
        for (const x of (await r.json()).query?.search ?? [])
          yield searchItem('wikipedia', { title: x.title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, '_'))}`, snippet: strip(x.snippet), publish_time: x.timestamp });
      } },
      { id: 'duckduckgo', async *stream({ query, limit = 5 }, { signal }) {
        const r = await http(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, { signal });
        const d = await r.json();
        const flat = [...(d.AbstractURL ? [{ Text: d.AbstractText || d.Heading, FirstURL: d.AbstractURL, Heading: d.Heading }] : []), ...(d.RelatedTopics ?? []).flatMap((t) => t.Topics ?? [t])];
        for (const x of flat.filter((t) => t.FirstURL).slice(0, limit))
          yield searchItem('duckduckgo', { title: x.Heading || (x.Text ?? '').split(' - ')[0].slice(0, 80), url: x.FirstURL, snippet: x.Text ?? '' });
      } },
    ],
  },

  web_scrape: {
    category: 'Scrape',
    description: 'Fetch a URL and return its content as Markdown (meta first, then paragraphs).',
    params: { url: { type: 'string', required: true } },
    credits: 2,
    dedupe: (item) => (item.kind === 'meta' ? 'meta' : item.text.replace(/[#*_`>\-\[\]()!]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)),
    providers: [
      { id: 'firecrawl', needs: 'FIRECRAWL_API_KEY', async *stream({ url }, { key, signal }) {
        const r = await http('https://api.firecrawl.dev/v1/scrape', { signal, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ url, formats: ['markdown'] }) });
        const d = (await r.json()).data ?? {};
        yield* paragraphs('firecrawl', url, d.markdown ?? '', d.metadata?.title);
      } },
      // Jina Reader streams its body, which is what makes mid-stream failover observable.
      { id: 'jina', optional: 'JINA_API_KEY', async *stream({ url }, { key, signal }) {
        const r = await http(`https://r.jina.ai/${url}`, { signal, headers: { accept: 'text/plain', ...(key ? { authorization: `Bearer ${key}` } : {}) } });
        const dec = new TextDecoder(); let buf = '', title = null, started = false;
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          if (!started) {
            const m = buf.match(/Markdown Content:\n/); if (!m) continue;
            title = buf.match(/^Title:\s*(.*)$/m)?.[1] ?? null; buf = buf.slice(m.index + m[0].length); started = true;
            if (title) yield { kind: 'meta', title, url, source: 'jina' };
          }
          let i; while ((i = buf.indexOf('\n\n')) >= 0) { const p = buf.slice(0, i).trim(); buf = buf.slice(i + 2); if (p) yield { kind: 'paragraph', text: p, source: 'jina' }; }
        }
        if (buf.trim()) yield { kind: 'paragraph', text: buf.trim(), source: 'jina' };
      } },
      { id: 'direct', async *stream({ url }, { signal }) {
        const r = await http(url, { signal, headers: { 'user-agent': 'contract-lite/0.1 (gateway demo)' } });
        const html = await r.text();
        const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
        const body = html.replace(/<head[\s\S]*?<\/head>/i, '').replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, '')
          .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(+n)} ${strip(t)}\n\n`)
          .replace(/<(p|li|div|br|tr)[^>]*>/gi, '\n\n');
        yield* paragraphs('direct', url, strip(body.replace(/\n{2,}/g, '\u0000')).split('\u0000').join('\n\n'), title);
      } },
    ],
  },
};
