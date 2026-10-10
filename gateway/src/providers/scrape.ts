// Scrape: URL → Markdown, streamed one paragraph at a time so a stream can resume on another provider.
// Normalized item: { kind: 'meta' | 'paragraph', title?, url?, text? }
import type { Item, Tool } from '../types.js';
import { get, post, json, strip } from './http.js';

function* paragraphs(source: string, url: string, markdown: string, title?: string): Generator<Item> {
  if (title) yield { kind: 'meta', title, url, source };
  for (const p of String(markdown).split(/\n{2,}/)) if (p.trim()) yield { kind: 'paragraph', text: p.trim(), source };
}

export const scrapeTools: Record<string, Tool> = {
  web_scrape: {
    category: 'Scrape', description: 'Fetch a URL and return its content as Markdown.', credits: 2,
    params: { url: { type: 'string', required: true } },
    output: "{ kind: 'meta'|'paragraph', title?, url?, text? }",
    markdown: (x) => (x.kind === 'meta' ? `# ${x.title}\n\n<${x.url}>` : String(x.text)),
    dedupe: (x) => (x.kind === 'meta' ? 'meta' : String(x.text).replace(/[#*_`>\-[\]()!]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)),
    providers: [
      { id: 'firecrawl', needs: 'FIRECRAWL_API_KEY', async *stream({ url }, c) {
        const d = (await json(await post('https://api.firecrawl.dev/v1/scrape', { url, formats: ['markdown'] }, c, { authorization: `Bearer ${c.key}` }))).data ?? {};
        yield* paragraphs('firecrawl', url, d.markdown ?? '', d.metadata?.title);
      } },
      // Jina Reader streams its body, which makes mid-stream failover real rather than simulated.
      { id: 'jina', optional: 'JINA_API_KEY', probe: { url: 'https://example.com' }, async *stream({ url }, c) {
        const r = await get(`https://r.jina.ai/${url}`, c, { accept: 'text/plain', ...(c.key ? { authorization: `Bearer ${c.key}` } : {}) });
        const dec = new TextDecoder(); let buf = '', started = false;
        for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true });
          if (!started) {
            const m = buf.match(/Markdown Content:\n/); if (!m) continue;
            const title = buf.match(/^Title:\s*(.*)$/m)?.[1]; buf = buf.slice(m.index! + m[0].length); started = true;
            if (title) yield { kind: 'meta', title, url, source: 'jina' };
          }
          let i; while ((i = buf.indexOf('\n\n')) >= 0) { const p = buf.slice(0, i).trim(); buf = buf.slice(i + 2); if (p) yield { kind: 'paragraph', text: p, source: 'jina' }; }
        }
        if (buf.trim()) yield { kind: 'paragraph', text: buf.trim(), source: 'jina' };
      } },
      { id: 'direct', probe: { url: 'https://example.com' }, async *stream({ url }, c) {
        const html = await (await get(url, c, { accept: 'text/html' })).text();
        const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
        const body = html.replace(/<head[\s\S]*?<\/head>/i, '').replace(/<(script|style|nav|footer|header|noscript)[\s\S]*?<\/\1>/gi, '')
          .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\u0000${'#'.repeat(+n)} ${strip(t)}\u0000`)
          .replace(/<\/?(p|li|div|br|tr|section|article)[^>]*>/gi, '\u0000');
        yield* paragraphs('direct', url, body.split('\u0000').map(strip).filter(Boolean).join('\n\n'), title);
      } },
    ],
  },
};
