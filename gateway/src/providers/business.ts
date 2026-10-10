// Business: company registries and funding data.
import { createHash } from 'node:crypto';
import type { Tool } from '../types.js';
import { get, json, iso } from './http.js';

export const businessTools: Record<string, Tool> = {
  company_lookup: {
    category: 'Business', description: 'Find a company: registry id, jurisdiction, status, founding date.', credits: 2,
    params: { name: { type: 'string', required: true }, limit: { type: 'integer', default: 5 } },
    output: '{ name, id, jurisdiction, status, incorporated, description, url, source }',
    markdown: (x) => `- **${x.name}** · ${x.jurisdiction ?? ''} · ${x.status ?? ''} · 成立 ${String(x.incorporated ?? '?').slice(0, 10)} · ${x.id} · ${x.source}${x.url ? `\n  ${x.url}` : ''}`,
    dedupe: (x) => String(x.name).toLowerCase().replace(/[^a-z0-9一-鿿]/g, ''),
    providers: [
      { id: 'crunchbase', needs: 'CRUNCHBASE_API_KEY', async *stream({ name, limit }, c) {
        const d = await json(await get(`https://api.crunchbase.com/api/v4/autocompletes?query=${encodeURIComponent(name)}&collection_ids=organizations&limit=${limit}`, c, { 'x-cb-user-key': c.key! }));
        for (const e of d.entities ?? []) yield { name: e.identifier?.value, id: e.identifier?.permalink, jurisdiction: null, status: null, incorporated: null, description: e.short_description ?? '', url: `https://www.crunchbase.com/organization/${e.identifier?.permalink}`, source: 'crunchbase' };
      } },
      // 企查查: signed requests — Token = MD5(key + Timespan + SecretKey), uppercase.
      { id: 'qichacha', needs: 'QCC_APP_KEY', async *stream({ name, limit }, c) {
        const secret = process.env.QCC_SECRET_KEY ?? '', ts = String(Math.floor(Date.now() / 1000));
        const token = createHash('md5').update(c.key! + ts + secret).digest('hex').toUpperCase();
        const d = await json(await get(`https://api.qichacha.com/FuzzySearch/GetList?key=${c.key}&searchKey=${encodeURIComponent(name)}`, c, { Token: token, Timespan: ts }));
        if (d.Status !== '200') throw new Error(`qichacha: ${d.Message}`);
        for (const r of (d.Result ?? []).slice(0, limit)) yield { name: r.Name, id: r.CreditCode || r.KeyNo, jurisdiction: 'CN', status: r.Status, incorporated: iso(r.StartDate), description: r.OperName ? `法定代表人 ${r.OperName}` : '', url: null, source: 'qichacha' };
      } },
      { id: 'opencorporates', optional: 'OPENCORPORATES_API_TOKEN', async *stream({ name, limit }, c) {
        const d = await json(await get(`https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(name)}&per_page=${limit}${c.key ? `&api_token=${c.key}` : ''}`, c));
        for (const { company: x } of d.results?.companies ?? []) yield { name: x.name, id: x.company_number, jurisdiction: x.jurisdiction_code, status: x.current_status, incorporated: iso(x.incorporation_date), description: '', url: x.opencorporates_url, source: 'opencorporates' };
      } },
      { id: 'gleif', probe: { name: 'Apple', limit: 1 }, async *stream({ name, limit }, c) {
        const d = await json(await get(`https://api.gleif.org/api/v1/lei-records?filter[fulltext]=${encodeURIComponent(name)}&page[size]=${limit}`, c, { accept: 'application/vnd.api+json' }));
        for (const r of d.data ?? []) {
          const e = r.attributes.entity;
          yield { name: e.legalName?.name, id: `LEI ${r.attributes.lei}`, jurisdiction: e.jurisdiction ?? e.legalAddress?.country, status: e.status, incorporated: iso(e.creationDate), description: [e.legalAddress?.city, e.legalAddress?.country].filter(Boolean).join(', '), url: `https://search.gleif.org/#/record/${r.attributes.lei}`, source: 'gleif' };
        }
      } },
    ],
  },
};
