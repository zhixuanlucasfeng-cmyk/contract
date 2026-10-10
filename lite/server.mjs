// HTTP gateway: one master key in, any tool out.
//   GET  /v1/tools                      catalog (dynamic discovery)
//   POST /v1/tools/:name/execute        { params, stream?, format? }  → JSON, or NDJSON when stream:true
//   GET  /v1/account/balance | usage    POST /v1/account/rotate
//   GET  /dashboard                     key, usage, provider health
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './providers.mjs';
import { createEngine, render } from './engine.mjs';
import { openStore, rateLimiter } from './store.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));

export function catalog() {
  const tree = {};
  for (const [name, t] of Object.entries(TOOLS)) {
    (tree[t.category] ??= []).push({
      name, description: t.description, credits: t.credits,
      input_schema: { type: 'object', properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, { type: v.type, ...(v.default !== undefined ? { default: v.default } : {}) }])),
        required: Object.entries(t.params).filter(([, v]) => v.required).map(([k]) => k) },
      output: name === 'web_search' ? '{ items: [{ title, url, snippet, publish_time, author, source, provider }] }' : '{ items: [{ kind: "meta"|"paragraph", title?, url?, text? }] }',
      example: { params: Object.fromEntries(Object.entries(t.params).filter(([, v]) => v.required).map(([k]) => [k, k === 'url' ? 'https://example.com' : 'chainsaw man'])) },
      providers: t.providers.map((p) => p.id),
    });
  }
  return { categories: tree };
}

export function startServer(config) {
  const store = openStore(config.db);
  const engine = createEngine({ tools: TOOLS, secrets: config.secrets, faults: config.faults, settings: config.settings, log: config.log });
  const allow = rateLimiter();

  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const body = (req) => new Promise((ok, bad) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } }); });

  function auth(req, res) {
    const key = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
    const k = store.find(key);
    if (!k) return send(res, 401, { error: { code: 'invalid_key', message: 'missing or invalid master key (ct_…)' } });
    const ip = req.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (k.ip_allow && !k.ip_allow.split(',').map((s) => s.trim()).includes(ip)) return send(res, 403, { error: { code: 'ip_not_allowed', message: `IP ${ip} not in allowlist` } });
    if (!allow(k.id, k.per_minute)) return send(res, 429, { error: { code: 'rate_limited', message: `over ${k.per_minute} calls/minute` } });
    return k;
  }

  async function execute(req, res, name, k) {
    const t = TOOLS[name];
    if (!t) return send(res, 404, { error: { code: 'unknown_tool', message: name } });
    if (k.credits < t.credits) return send(res, 402, { error: { code: 'no_credits', message: `needs ${t.credits} credits, ${k.credits} left` } });
    const { params = {}, stream = false, format = 'json' } = await body(req);
    const started = Date.now(), providers = new Set();
    let ok = false, failedOver = [];
    const onLog = (r) => { failedOver = r.failedOver; };
    try {
      if (stream) {
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
        for await (const item of engine.run(name, params, { onLog })) { providers.add(item.provider); res.write(JSON.stringify({ type: 'item', data: item }) + '\n'); }
        ok = true;
        res.end(JSON.stringify({ type: 'done', credits: t.credits, providers: [...providers] }) + '\n');
      } else {
        const items = await engine.call(name, params, { onLog });
        items.forEach((i) => providers.add(i.provider));
        ok = true;
        send(res, 200, { ...((x) => (typeof x === 'string' ? { tool: name, content: x } : x))(render(name, items, format)), credits: t.credits, providers: [...providers] });
      }
    } catch (e) {
      const code = e.status === 400 ? 400 : 503;
      if (res.headersSent) res.end(JSON.stringify({ type: 'error', error: { code: 'upstream_failed', message: e.message } }) + '\n');
      else send(res, code, { error: { code: code === 400 ? 'bad_params' : 'upstream_failed', message: e.message } });
    } finally {
      if (ok) store.charge(k.id, t.credits);
      store.record({ keyId: k.id, tool: name, provider: [...providers].join('+') || null, ok, ms: Date.now() - started, credits: ok ? t.credits : 0, failedOver });
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    try {
      if (p === '/health') return send(res, 200, { ok: true });
      if (p === '/' || p === '/dashboard') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readFileSync(join(DIR, 'dashboard.html'))); }
      if (!p.startsWith('/v1/')) return send(res, 404, { error: { code: 'not_found' } });
      const k = auth(req, res); if (!k) return;
      if (p === '/v1/tools' && req.method === 'GET') return send(res, 200, catalog());
      const m = p.match(/^\/v1\/tools\/([a-z_]+)\/execute$/);
      if (m && req.method === 'POST') return await execute(req, res, m[1], k);
      if (p === '/v1/account/balance') { const u = store.usage(k.id); return send(res, 200, { key: k.hint, name: k.name, credits: k.credits, used: u.used }); }
      if (p === '/v1/account/usage') return send(res, 200, { ...store.usage(k.id), providers: engine.status() });
      if (p === '/v1/account/rotate' && req.method === 'POST') return send(res, 200, { key: store.rotate(k.id), note: 'old key stops working now; this one is shown once' });
      send(res, 404, { error: { code: 'not_found' } });
    } catch (e) { if (!res.headersSent) send(res, 500, { error: { code: 'internal', message: String(e.message) } }); }
  });
  return new Promise((ok) => server.listen(config.port, config.host, () => ok({ server, store, engine })));
}
