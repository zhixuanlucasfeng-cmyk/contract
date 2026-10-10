// Crypto: prices, DEX pools, wallet balances.
import type { Tool } from '../types.js';
import { get, json, num, iso } from './http.js';

export const cryptoTools: Record<string, Tool> = {
  crypto_price: {
    category: 'Crypto', description: 'Current price of a coin by name or symbol (e.g. bitcoin, ETH).', credits: 1,
    params: { coin: { type: 'string', required: true }, currency: { type: 'string', default: 'usd' } },
    output: '{ symbol, name, price, currency, change_24h_pct, market_cap, time, source }',
    markdown: (x) => `**${x.name} (${x.symbol})** ${x.price} ${String(x.currency).toUpperCase()} · 24h ${x.change_24h_pct ?? '?'}% · 市值 ${x.market_cap ?? '?'} · ${x.source}`,
    dedupe: () => 'price', // one answer; a backup must not add a second
    providers: [
      { id: 'coinmarketcap', needs: 'CMC_API_KEY', async *stream({ coin, currency }, c) {
        const sym = String(coin).toUpperCase(), cur = String(currency).toUpperCase();
        const d = await json(await get(`https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${sym}&convert=${cur}`, c, { 'x-cmc_pro_api_key': c.key! }));
        const x = d.data?.[sym]?.[0]; if (!x) return;
        const q = x.quote[cur];
        yield { symbol: x.symbol, name: x.name, price: q.price, currency, change_24h_pct: num(q.percent_change_24h), market_cap: num(q.market_cap), time: iso(q.last_updated), source: 'coinmarketcap' };
      } },
      { id: 'coingecko', probe: { coin: 'bitcoin', currency: 'usd' }, async *stream({ coin, currency }, c) {
        const s = await json(await get(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(coin)}`, c));
        const hit = s.coins?.find((x: any) => x.symbol?.toLowerCase() === String(coin).toLowerCase() || x.id === String(coin).toLowerCase()) ?? s.coins?.[0];
        if (!hit) return;
        const p = (await json(await get(`https://api.coingecko.com/api/v3/simple/price?ids=${hit.id}&vs_currencies=${currency}&include_24hr_change=true&include_market_cap=true&include_last_updated_at=true`, c)))[hit.id];
        yield { symbol: hit.symbol.toUpperCase(), name: hit.name, price: p[currency], currency, change_24h_pct: num(p[`${currency}_24h_change`]), market_cap: num(p[`${currency}_market_cap`]), time: iso(p.last_updated_at), source: 'coingecko' };
      } },
      { id: 'dexscreener-price', async *stream({ coin, currency }, c) {
        if (String(currency).toLowerCase() !== 'usd') return;
        const d = await json(await get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(coin)}`, c));
        const p = (d.pairs ?? []).filter((x: any) => x.baseToken?.symbol?.toLowerCase() === String(coin).toLowerCase()).sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        if (p) yield { symbol: p.baseToken.symbol, name: p.baseToken.name, price: num(p.priceUsd), currency: 'usd', change_24h_pct: num(p.priceChange?.h24), market_cap: num(p.marketCap ?? p.fdv), time: new Date().toISOString(), source: 'dexscreener (deepest DEX pool)' };
      } },
    ],
  },

  dex_pools: {
    category: 'Crypto', description: 'Find DEX trading pools for a token or pair.', credits: 1,
    params: { query: { type: 'string', required: true }, limit: { type: 'integer', default: 5 } },
    output: '{ pair, dex, chain, price_usd, liquidity_usd, volume_24h_usd, url, source }',
    markdown: (x) => `- **${x.pair}** on ${x.dex} (${x.chain}) · $${x.price_usd} · 流动性 $${x.liquidity_usd} · 24h 成交 $${x.volume_24h_usd} · ${x.url}`,
    dedupe: (x) => `${x.chain}:${String(x.pair).toLowerCase()}:${x.dex}`,
    providers: [
      { id: 'dexscreener', probe: { query: 'WETH', limit: 1 }, async *stream({ query, limit }, c) {
        const d = await json(await get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`, c));
        for (const p of (d.pairs ?? []).slice(0, limit))
          yield { pair: `${p.baseToken.symbol}/${p.quoteToken.symbol}`, dex: p.dexId, chain: p.chainId, price_usd: num(p.priceUsd), liquidity_usd: num(p.liquidity?.usd), volume_24h_usd: num(p.volume?.h24), url: p.url, source: 'dexscreener' };
      } },
      { id: 'geckoterminal', async *stream({ query, limit }, c) {
        const d = await json(await get(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}`, c));
        for (const p of (d.data ?? []).slice(0, limit)) {
          const a = p.attributes, [chain] = String(p.id).split('_');
          yield { pair: a.name, dex: p.relationships?.dex?.data?.id ?? '', chain, price_usd: num(a.base_token_price_usd), liquidity_usd: num(a.reserve_in_usd), volume_24h_usd: num(a.volume_usd?.h24), url: `https://www.geckoterminal.com/${chain}/pools/${a.address}`, source: 'geckoterminal' };
        }
      } },
    ],
  },

  wallet_balance: {
    category: 'Crypto', description: 'Native ETH balance of an Ethereum address.', credits: 1,
    params: { address: { type: 'string', required: true } },
    output: '{ address, chain, balance, unit, source }',
    markdown: (x) => `${x.address} on ${x.chain}: **${x.balance} ${x.unit}** (${x.source})`,
    dedupe: () => 'balance',
    providers: [
      { id: 'etherscan', needs: 'ETHERSCAN_API_KEY', async *stream({ address }, c) {
        const d = await json(await get(`https://api.etherscan.io/v2/api?chainid=1&module=account&action=balance&address=${address}&tag=latest&apikey=${c.key}`, c));
        if (d.status !== '1') throw new Error(`etherscan: ${d.result}`);
        yield { address, chain: 'ethereum', balance: Number(BigInt(d.result)) / 1e18, unit: 'ETH', source: 'etherscan' };
      } },
      { id: 'chainbase', needs: 'CHAINBASE_API_KEY', async *stream({ address }, c) {
        const d = await json(await get(`https://api.chainbase.online/v1/account/balance?chain_id=1&address=${address}`, c, { 'x-api-key': c.key! }));
        yield { address, chain: 'ethereum', balance: Number(BigInt(d.data)) / 1e18, unit: 'ETH', source: 'chainbase' };
      } },
      { id: 'blockscout', probe: { address: '0x0000000000000000000000000000000000000000' }, async *stream({ address }, c) {
        const d = await json(await get(`https://eth.blockscout.com/api/v2/addresses/${address}`, c));
        yield { address, chain: 'ethereum', balance: Number(BigInt(d.coin_balance ?? '0')) / 1e18, unit: 'ETH', source: 'blockscout' };
      } },
    ],
  },
};
