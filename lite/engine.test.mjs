import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from './engine.mjs';
import { ProviderError } from './providers.mjs';

const items = (src, n) => Array.from({ length: n }, (_, i) => ({ url: `u${i}`, title: `t${i}`, src }));
const prov = (id, behaviour) => ({ id, async *stream() {
  if (behaviour === '500') throw new ProviderError(500, 'boom');
  if (behaviour === '400') throw new ProviderError(400, 'bad params');
  for (const [i, x] of items(id, 5).entries()) { if (behaviour === 'drop' && i === 2) throw new ProviderError(502, 'died'); yield x; }
} });
const tool = (...ps) => ({ x: { params: { q: { required: true } }, dedupe: (i) => i.url, providers: ps } });

test('5xx on primary fails over to backup', async () => {
  const e = createEngine({ tools: tool(prov('a', '500'), prov('b')) });
  const out = await e.call('x', { q: 1 });
  assert.deepEqual(out.map((i) => i.provider), ['b', 'b', 'b', 'b', 'b']);
});

test('mid-stream death: client gets one complete, duplicate-free stream', async () => {
  const e = createEngine({ tools: tool(prov('a', 'drop'), prov('b')) });
  const out = await e.call('x', { q: 1 });
  assert.deepEqual(out.map((i) => i.url), ['u0', 'u1', 'u2', 'u3', 'u4']);
  assert.deepEqual(out.map((i) => i.provider), ['a', 'a', 'b', 'b', 'b']);
});

test('client errors are not retried; missing keys are skipped', async () => {
  const e = createEngine({ tools: tool(prov('a', '400'), prov('b')) });
  await assert.rejects(e.call('x', { q: 1 }), /bad params/);
  const k = createEngine({ tools: tool({ ...prov('a'), needs: 'KEY' }, prov('b')) });
  assert.equal((await k.call('x', { q: 1 }))[0].provider, 'b');
  await assert.rejects(k.call('x', {}), /missing param q/);
});

test('timeouts fail over; failing provider cools down then gets retried', async () => {
  let t = 0;
  const hang = { id: 'slow', async *stream() { await new Promise((r) => setTimeout(r, 200)); yield { url: 'never' }; } };
  const e = createEngine({ tools: tool(hang, prov('b')), settings: { x: { timeoutMs: 30, retries: 0, failThreshold: 1, cooldownMs: 1000 } }, now: () => t });
  assert.equal((await e.call('x', { q: 1 }))[0].provider, 'b');
  assert.equal(e.status().x[0].cooling, true);
  t = 2000;
  assert.equal(e.status().x[0].cooling, false);
});

test('injected faults and all-down error', async () => {
  const e = createEngine({ tools: tool(prov('a'), prov('b')), faults: { a: 'drop:1', b: '429' } });
  await assert.rejects(e.call('x', { q: 1 }), /all providers failed/);
});
