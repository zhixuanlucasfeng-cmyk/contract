// Shared state in Redis: provider health (so every gateway instance agrees), rate limits, IP blocks.
import { Redis } from 'ioredis';
import type { HealthStore, Settings } from './engine.js';

export const connect = (url: string) => new Redis(url, { maxRetriesPerRequest: null });

export function redisHealth(r: Redis): HealthStore {
  return {
    async coolingUntil(id) { return Number(await r.get(`health:${id}:until`)) || 0; },
    async failure(id, s: Settings) {
      const fails = await r.incr(`health:${id}:fails`);
      await r.pexpire(`health:${id}:fails`, s.cooldownMs);
      if (fails < s.failThreshold) return false;
      await r.multi().set(`health:${id}:until`, Date.now() + s.cooldownMs, 'PX', s.cooldownMs * 10).del(`health:${id}:fails`).exec();
      return true;
    },
    async success(id) { await r.del(`health:${id}:fails`, `health:${id}:until`); },
  };
}

/** Fixed one-minute window per key. Returns false when over the limit. */
export async function allow(r: Redis, keyId: string | number, perMinute: number) {
  const k = `rl:${keyId}:${Math.floor(Date.now() / 60000)}`;
  const n = await r.incr(k);
  if (n === 1) await r.expire(k, 61);
  return n <= perMinute;
}

/** Counts bad-key attempts per IP; past the limit the IP is blocked for a while. */
export async function authFailed(r: Redis, ip: string, limit: number, blockMinutes: number) {
  const k = `authfail:${ip}`;
  const n = await r.incr(k);
  if (n === 1) await r.expire(k, 60);
  if (n >= limit) await r.set(`blocked:${ip}`, '1', 'EX', blockMinutes * 60);
}
export const isBlocked = async (r: Redis, ip: string) => (await r.exists(`blocked:${ip}`)) === 1;
