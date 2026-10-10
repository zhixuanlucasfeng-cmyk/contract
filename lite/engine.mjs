// Failover engine: try providers in priority order; on 5xx / 429 / timeout / network error move to the next one.
// Streams are item-level: items already sent are remembered by the tool's dedupe key, so when a provider dies
// mid-stream the next provider's output is stitched on without repeats and the client never sees the failure.
import { ProviderError } from './providers.mjs';

export const DEFAULTS = { timeoutMs: 15000, retries: 1, cooldownMs: 60000, failThreshold: 2 };

const retryable = (e) => e.name === 'TimeoutError' || e.name === 'AbortError' || !(e instanceof ProviderError) || e.status >= 500 || e.status === 429 || e.status === 401 || e.status === 403;

// Test hook: make a provider fail on purpose ("500", "429", "timeout", "drop:N" = die after N items).
async function* faulty(gen, fault) {
  if (fault === 'timeout') { await new Promise((r) => setTimeout(r, 1e9)); }
  if (/^\d{3}$/.test(fault)) throw new ProviderError(Number(fault), `injected ${fault}`);
  const n = Number(fault?.match(/^drop:(\d+)$/)?.[1] ?? Infinity);
  let i = 0;
  for await (const x of gen) { if (i++ === n) throw new ProviderError(502, `injected drop after ${n} items`); yield x; }
}

export function createEngine({ tools, secrets = {}, faults = {}, settings = {}, now = () => Date.now(), log = () => {} }) {
  const health = new Map(); // providerId -> { fails, cooldownUntil }
  const cfg = (tool) => ({ ...DEFAULTS, ...settings[tool] });
  const usable = (p) => !p.needs || secrets[p.needs];
  const cooling = (p) => (health.get(p.id)?.cooldownUntil ?? 0) > now();

  function fail(p, c) {
    const h = health.get(p.id) ?? { fails: 0, cooldownUntil: 0 };
    h.fails++;
    if (h.fails >= c.failThreshold) { h.cooldownUntil = now() + c.cooldownMs; h.fails = 0; }
    health.set(p.id, h);
  }

  // Healthy providers first in priority order; cooling ones only as a last resort (half-open retry).
  const order = (t) => { const ps = t.providers.filter(usable); return [...ps.filter((p) => !cooling(p)), ...ps.filter(cooling)]; };

  async function* run(name, params, { onLog } = {}) {
    const report = (r) => { log(r); onLog?.(r); };
    const t = tools[name];
    if (!t) throw new ProviderError(404, `unknown tool ${name}`);
    for (const [k, spec] of Object.entries(t.params)) if (spec.required && (params[k] === undefined || params[k] === '')) throw new ProviderError(400, `missing param ${k}`);
    const c = cfg(name), sent = new Set(), errors = [];
    for (const p of order(t)) {
      for (let attempt = 0; attempt <= c.retries; attempt++) {
        const ac = new AbortController();
        const it = faulty(p.stream(params, { key: secrets[p.needs ?? p.optional], signal: ac.signal }), faults[p.id])[Symbol.asyncIterator]();
        try {
          for (;;) {
            let timer;
            const step = await Promise.race([it.next(), new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(Object.assign(new Error(`${p.id} timed out after ${c.timeoutMs}ms`), { name: 'TimeoutError' })); }, c.timeoutMs); })]);
            clearTimeout(timer);
            if (step.done) break;
            const key = t.dedupe(step.value);
            if (sent.has(key)) continue;
            sent.add(key);
            yield { ...step.value, provider: p.id };
          }
          health.set(p.id, { fails: 0, cooldownUntil: 0 });
          report({ tool: name, provider: p.id, ok: true, failedOver: errors });
          return;
        } catch (e) {
          ac.abort(); it.return?.().catch(() => {});
          if (!retryable(e)) throw e;
          errors.push({ provider: p.id, error: e.message });
          fail(p, c);
          if (e.status === 429 || e.status === 401 || e.status === 403) break; // retrying the same provider won't help
        }
      }
    }
    report({ tool: name, ok: false, failedOver: errors });
    throw new ProviderError(503, `all providers failed: ${errors.map((x) => `${x.provider}: ${x.error}`).join('; ') || 'none configured'}`);
  }

  async function call(name, params, opts) {
    const items = [];
    for await (const x of run(name, params, opts)) items.push(x);
    return items;
  }

  const status = () => Object.fromEntries(Object.entries(tools).map(([n, t]) => [n, t.providers.map((p) => ({
    id: p.id, configured: !!usable(p), cooling: cooling(p), cooldownUntil: health.get(p.id)?.cooldownUntil || null,
  }))]));

  return { run, call, status };
}

// Output formats: structured JSON (default), Markdown, plain text.
export function render(name, items, format = 'json') {
  if (format === 'json') return { tool: name, items };
  const md = name === 'web_search'
    ? items.map((x, i) => `${i + 1}. [${x.title}](${x.url})${x.publish_time ? ` · ${x.publish_time.slice(0, 10)}` : ''}\n   ${x.snippet}`).join('\n')
    : items.map((x) => (x.kind === 'meta' ? `# ${x.title}\n\n<${x.url}>` : x.text)).join('\n\n');
  return format === 'markdown' ? md : md.replace(/[#*_`>[\]]/g, '').replace(/\(http[^)]*\)/g, '');
}
