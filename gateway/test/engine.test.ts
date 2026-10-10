import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, memoryHealth } from '../src/engine.js';
import { ProviderError, type Tool, type Provider } from '../src/types.js';

const prov = (id: string, behaviour?: '500' | '400' | 'drop'): Provider => ({ id, async *stream() {
  if (behaviour === '500') throw new ProviderError(500, 'boom');
  if (behaviour === '400') throw new ProviderError(400, 'bad params');
  for (let i = 0; i < 5; i++) { if (behaviour === 'drop' && i === 2) throw new ProviderError(502, 'died'); yield { url: `u${i}` }; }
} });
const tools = (...providers: Provider[]): Record<string, Tool> => ({ x: { category: 'Search', description: '', credits: 1, output: '', markdown: String, params: { q: { type: 'string', required: true } }, dedupe: (i) => String(i.url), providers } });
const engine = (ps: Provider[], extra = {}) => createEngine({ tools: tools(...ps), secrets: {}, health: memoryHealth(), ...extra });

test('5xx fails over to the backup', async () => {
  assert.deepEqual((await engine([prov('a', '500'), prov('b')]).call('x', { q: 1 })).map((i) => i.provider), ['b', 'b', 'b', 'b', 'b']);
});

test('provider dying mid-stream: one complete, duplicate-free stream', async () => {
  const out = await engine([prov('a', 'drop'), prov('b')]).call('x', { q: 1 });
  assert.deepEqual(out.map((i) => i.url), ['u0', 'u1', 'u2', 'u3', 'u4']);
  assert.deepEqual(out.map((i) => i.provider), ['a', 'a', 'b', 'b', 'b']);
});

test('400 is not retried; providers without credentials are skipped; required params checked', async () => {
  await assert.rejects(engine([prov('a', '400'), prov('b')]).call('x', { q: 1 }), /bad params/);
  const e = engine([{ ...prov('a'), needs: 'KEY' }, prov('b')]);
  assert.equal((await e.call('x', { q: 1 }))[0].provider, 'b');
  await assert.rejects(e.call('x', {}), /missing param q/);
});

test('timeout fails over, provider cools down, then is back', async () => {
  let t = 0;
  const slow: Provider = { id: 'slow', async *stream() { await new Promise((r) => setTimeout(r, 200)); yield { url: 'never' }; } };
  const e = createEngine({ tools: tools(slow, prov('b')), secrets: {}, health: memoryHealth(() => t), now: () => t, settings: { x: { timeoutMs: 30, retries: 0, failThreshold: 1, cooldownMs: 1000 } } });
  assert.equal((await e.call('x', { q: 1 }))[0].provider, 'b');
  assert.ok((await e.status()).x[0].coolingUntil);
  t = 5000;
  assert.equal((await e.status()).x[0].coolingUntil, null);
});

test('run log records who answered and who failed', async () => {
  let log: any;
  await engine([prov('a', 'drop'), prov('b')]).call('x', { q: 1 }, (r) => (log = r));
  assert.deepEqual(log.providers, ['a', 'b']);
  assert.equal(log.failedOver[0].provider, 'a');
});

test('injected faults; everything down → one clear error', async () => {
  await assert.rejects(engine([prov('a'), prov('b')], { faults: { a: 'drop:1', b: '429' } }).call('x', { q: 1 }), /all providers failed/);
});
