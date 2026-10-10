// Finance: stock quotes, macro series, A-shares.
import type { Tool } from '../types.js';
import { get, post, json, num, iso } from './http.js';

const quoteMd = (x: any) => `**${x.symbol}** ${x.price} ${x.currency ?? ''} · ${x.change_pct ?? '?'}% · ${String(x.time ?? '').slice(0, 16)} · ${x.source}`;

export const financeTools: Record<string, Tool> = {
  stock_quote: {
    category: 'Finance', description: 'Latest quote for a stock ticker (e.g. AAPL).', credits: 1,
    params: { symbol: { type: 'string', required: true } },
    output: '{ symbol, price, change, change_pct, currency, time, source }', markdown: quoteMd, dedupe: () => 'quote',
    providers: [
      { id: 'finnhub', needs: 'FINNHUB_API_KEY', async *stream({ symbol }, c) {
        const d = await json(await get(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${c.key}`, c));
        if (!d.c) return;
        yield { symbol, price: d.c, change: num(d.d), change_pct: num(d.dp), currency: 'USD', time: iso(d.t), source: 'finnhub' };
      } },
      { id: 'alphavantage', needs: 'ALPHAVANTAGE_API_KEY', async *stream({ symbol }, c) {
        const q = (await json(await get(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${c.key}`, c)))['Global Quote'];
        if (!q?.['05. price']) throw new Error('alphavantage: no quote (rate limited?)');
        yield { symbol, price: num(q['05. price']), change: num(q['09. change']), change_pct: num(String(q['10. change percent']).replace('%', '')), currency: 'USD', time: iso(q['07. latest trading day']), source: 'alphavantage' };
      } },
    ],
  },

  macro_series: {
    category: 'Finance', description: 'Recent observations of a FRED economic series (e.g. CPIAUCSL, UNRATE, DGS10).', credits: 1,
    params: { series: { type: 'string', required: true }, limit: { type: 'integer', default: 12 } },
    output: '{ series, date, value, source }', markdown: (x) => `- ${x.date}: ${x.value}`, dedupe: (x) => String(x.date),
    providers: [
      { id: 'fred', needs: 'FRED_API_KEY', async *stream({ series, limit }, c) {
        const d = await json(await get(`https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(series)}&api_key=${c.key}&file_type=json&sort_order=desc&limit=${limit}`, c));
        for (const o of d.observations ?? []) yield { series, date: o.date, value: num(o.value), source: 'fred' };
      } },
    ],
  },

  country_indicator: {
    category: 'Finance', description: 'World Bank indicator for a country (e.g. country=CN, indicator=NY.GDP.MKTP.CD).', credits: 1,
    params: { country: { type: 'string', required: true }, indicator: { type: 'string', required: true }, limit: { type: 'integer', default: 10 } },
    output: '{ series, date, value, source }', markdown: (x) => `- ${x.date}: ${x.value}`, dedupe: (x) => String(x.date),
    providers: [
      { id: 'worldbank', probe: { country: 'US', indicator: 'NY.GDP.MKTP.CD', limit: 1 }, async *stream({ country, indicator, limit }, c) {
        const [, rows] = await json(await get(`https://api.worldbank.org/v2/country/${encodeURIComponent(country)}/indicator/${encodeURIComponent(indicator)}?format=json&per_page=${limit}`, c));
        for (const r of rows ?? []) yield { series: `${country}:${indicator}`, date: r.date, value: num(r.value), source: 'worldbank' };
      } },
    ],
  },

  cn_stock_daily: {
    category: 'Finance', description: 'A-share daily bars from Tushare (ts_code like 600519.SH).', credits: 2,
    params: { ts_code: { type: 'string', required: true }, limit: { type: 'integer', default: 10 } },
    output: '{ ts_code, date, open, high, low, close, pct_chg, source }',
    markdown: (x) => `- ${x.date} 开 ${x.open} 高 ${x.high} 低 ${x.low} 收 ${x.close} (${x.pct_chg}%)`, dedupe: (x) => String(x.date),
    providers: [
      { id: 'tushare', needs: 'TUSHARE_TOKEN', async *stream({ ts_code, limit }, c) {
        const d = await json(await post('https://api.tushare.pro', { api_name: 'daily', token: c.key, params: { ts_code }, fields: 'trade_date,open,high,low,close,pct_chg' }, c));
        if (d.code) throw new Error(`tushare: ${d.msg}`);
        for (const r of (d.data?.items ?? []).slice(0, limit)) yield { ts_code, date: r[0], open: r[1], high: r[2], low: r[3], close: r[4], pct_chg: r[5], source: 'tushare' };
      } },
    ],
  },
};
