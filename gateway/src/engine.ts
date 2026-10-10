// Failover engine. Providers are tried in priority order; 5xx / 429 / timeout / network / bad-credential errors move
// on to the next one. Streaming is item-level: items already sent are remembered by the tool's dedupe key, so when a
// provider dies mid-stream the backup's output is stitched on without repeats and the client never sees an error.
import { ProviderError, type Item, type Provider, type Tool } from './types.js';

export interface Settings { timeoutMs: number; retries: number; cooldownMs: number; failThreshold: number }
export const DEFAULTS: Settings = { timeoutMs: 15000, retries: 1, cooldownMs: 60000, failThreshold: 2 };

/** Where provider health lives: memory for tests / single instance, Redis when several gateways share it. */
export interface HealthStore {
  coolingUntil(id: string): Promise<number>;
  failure(id: string, s: Settings, reason: string): Promise<boolean>; // true when it just entered cooldown
  success(id: string): Promise<void>;
}

export function memoryHealth(now = () => Date.now()): HealthStore {
  const m = new Map<string, { fails: number; until: number }>();
  return {
    async coolingUntil(id) { return m.get(id)?.until ?? 0; },
    async failure(id, s) {
      const h = m.get(id) ?? { fails: 0, until: 0 };
      h.fails++;
      const tripped = h.fails >= s.failThreshold;
      if (tripped) { h.until = now() + s.cooldownMs; h.fails = 0; }
      m.set(id, h);
      return tripped;
    },
    async success(id) { m.delete(id); },
  };
}

export interface FailoverRecord { provider: string; error: string }
export interface RunLog { tool: string; ok: boolean; providers: string[]; failedOver: FailoverRecord[] }

const retryable = (e: any) => e?.name === 'TimeoutError' || e?.name === 'AbortError' || !(e instanceof ProviderError) || e.status >= 500 || [401, 403, 404, 429].includes(e.status);

/** Test hook: "500" | "429" | "timeout" | "drop:N" (die after N items). */
async function* faulty(gen: AsyncGenerator<Item>, fault?: string): AsyncGenerator<Item> {
  if (fault === 'timeout') await new Promise((r) => setTimeout(r, 2 ** 31 - 1));
  if (fault && /^\d{3}$/.test(fault)) throw new ProviderError(Number(fault), `injected ${fault}`);
  const n = Number(fault?.match(/^drop:(\d+)$/)?.[1] ?? Infinity);
  let i = 0;
  for await (const x of gen) { if (i++ === n) throw new ProviderError(502, `injected drop after ${n} items`); yield x; }
}

export interface EngineOptions {
  tools: Record<string, Tool>;
  secrets: Record<string, string | undefined>;
  health: HealthStore;
  faults?: Record<string, string>;
  settings?: Record<string, Partial<Settings>>;
  onHealthEvent?: (provider: string, event: string, detail: string) => void;
  now?: () => number;
}

export function createEngine(o: EngineOptions) {
  const now = o.now ?? (() => Date.now());
  const cfg = (tool: string): Settings => ({ ...DEFAULTS, ...o.settings?.[tool] });
  const usable = (p: Provider) => !p.needs || !!o.secrets[p.needs];

  async function order(t: Tool) {
    const ps = t.providers.filter(usable);
    const until = await Promise.all(ps.map((p) => o.health.coolingUntil(p.id)));
    const cool = ps.filter((_, i) => until[i] > now());
    return [...ps.filter((p) => !cool.includes(p)), ...cool]; // cooling ones only as a last resort
  }

  async function* run(name: string, params: Record<string, any>, onLog?: (r: RunLog) => void): AsyncGenerator<Item & { provider: string }> {
    const t = o.tools[name];
    if (!t) throw new ProviderError(404, `unknown tool ${name}`);
    for (const [k, spec] of Object.entries(t.params)) {
      if (params[k] === undefined && spec.default !== undefined) params[k] = spec.default;
      if (spec.required && (params[k] === undefined || params[k] === '')) throw new ProviderError(400, `missing param ${k}`);
    }
    const c = cfg(name), sent = new Set<string>(), failedOver: FailoverRecord[] = [], used: string[] = [];
    for (const p of await order(t)) {
      for (let attempt = 0; attempt <= c.retries; attempt++) {
        const ac = new AbortController();
        const it = faulty(p.stream({ ...params }, { key: o.secrets[p.needs ?? p.optional ?? ''], signal: ac.signal }), o.faults?.[p.id]);
        try {
          for (;;) {
            let timer: NodeJS.Timeout | undefined;
            const step = await Promise.race([
              it.next(),
              new Promise<never>((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(Object.assign(new Error(`${p.id} timed out after ${c.timeoutMs}ms`), { name: 'TimeoutError' })); }, c.timeoutMs); }),
            ]).finally(() => clearTimeout(timer));
            if (step.done) break;
            const key = t.dedupe(step.value);
            if (sent.has(key)) continue;
            sent.add(key);
            if (used.at(-1) !== p.id) used.push(p.id);
            yield { ...step.value, provider: p.id };
          }
          await o.health.success(p.id);
          onLog?.({ tool: name, ok: true, providers: used, failedOver });
          return;
        } catch (e: any) {
          ac.abort(); it.return?.(undefined).catch(() => {});
          if (!retryable(e)) throw e;
          failedOver.push({ provider: p.id, error: e.message });
          if (await o.health.failure(p.id, c, e.message)) o.onHealthEvent?.(p.id, 'cooldown', e.message);
          else o.onHealthEvent?.(p.id, 'failure', e.message);
          if ([401, 403, 429].includes(e.status)) break; // retrying the same provider won't help
        }
      }
    }
    onLog?.({ tool: name, ok: false, providers: used, failedOver });
    throw new ProviderError(503, `all providers failed: ${failedOver.map((x) => `${x.provider}: ${x.error}`).join('; ') || 'none configured'}`);
  }

  async function call(name: string, params: Record<string, any>, onLog?: (r: RunLog) => void) {
    const items: (Item & { provider: string })[] = [];
    for await (const x of run(name, params, onLog)) items.push(x);
    return items;
  }

  async function status() {
    const out: Record<string, { id: string; configured: boolean; coolingUntil: number | null }[]> = {};
    for (const [n, t] of Object.entries(o.tools))
      out[n] = await Promise.all(t.providers.map(async (p) => {
        const u = await o.health.coolingUntil(p.id);
        return { id: p.id, configured: usable(p), coolingUntil: u > now() ? u : null };
      }));
    return out;
  }

  return { run, call, status, usable };
}

export function render(t: Tool, name: string, items: Item[], format: 'json' | 'markdown' | 'text') {
  if (format === 'json') return { tool: name, items };
  const md = items.map((x) => t.markdown(x)).join('\n\n');
  return { tool: name, content: format === 'markdown' ? md : md.replace(/[#*_`>[\]]/g, '').replace(/\((https?:[^)]*)\)/g, ' $1') };
}
