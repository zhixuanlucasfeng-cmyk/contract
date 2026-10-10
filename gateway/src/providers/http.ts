import { ProviderError, type Ctx } from '../types.js';

export const UA = 'contract-gateway/0.1 (+https://github.com/)';

export async function get(url: string, ctx: Ctx, headers: Record<string, string> = {}) {
  const r = await fetch(url, { signal: ctx.signal, headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
  if (!r.ok) throw new ProviderError(r.status, `${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
}

export async function post(url: string, body: unknown, ctx: Ctx, headers: Record<string, string> = {}) {
  const r = await fetch(url, { method: 'POST', signal: ctx.signal, headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!r.ok) throw new ProviderError(r.status, `${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
}

export const json = async (r: Response): Promise<any> => r.json();
export const strip = (html: unknown) => String(html ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
export const iso = (v: unknown) => { if (v === undefined || v === null || v === '') return null; const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v)); return isNaN(+d) ? null : d.toISOString(); };
export const num = (v: unknown) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? null : Number(v));
export const hasCJK = (s: string) => /[一-鿿]/.test(s);
