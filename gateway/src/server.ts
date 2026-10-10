// HTTP API. Users authenticate with their master key (Authorization: Bearer ct_…); the dashboard's admin side with
// ADMIN_TOKEN. Upstream provider credentials never leave this process.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fstatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';
import { TOOLS, catalog } from './registry.js';
import { createEngine, render, type RunLog } from './engine.js';
import { redisHealth, allow, authFailed, isBlocked } from './redis.js';
import type { Db, KeyRow } from './db.js';
import { config } from './config.js';

const err = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });
const bearer = (req: FastifyRequest) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] ?? '');

export function buildServer(db: Db, redis: Redis) {
  const engine = createEngine({
    tools: TOOLS, secrets: config.secrets, faults: config.faults, settings: config.settings, health: redisHealth(redis),
    onHealthEvent: (p, e, d) => { void db.healthLog(p, e, d); },
  });
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: process.env.TRUST_PROXY === '1' });

  // ---- user API -----------------------------------------------------------------------------------------------
  app.register(async (v1) => {
    v1.decorateRequest('key', null as unknown as KeyRow);
    v1.addHook('onRequest', async (req, reply) => {
      if (await isBlocked(redis, req.ip)) return err(reply, 403, 'ip_blocked', 'too many invalid keys from this IP; try again later');
      const k = await db.findKey(bearer(req));
      if (!k) { await authFailed(redis, req.ip, config.authFailLimit, config.blockMinutes); return err(reply, 401, 'invalid_key', 'missing or invalid master key (ct_…)'); }
      if (k.ip_allow.length && !k.ip_allow.includes(req.ip)) return err(reply, 403, 'ip_not_allowed', `IP ${req.ip} is not in this key's allowlist`);
      if (!(await allow(redis, k.key_id, k.per_minute))) return err(reply, 429, 'rate_limited', `over ${k.per_minute} calls/minute`);
      (req as any).key = k;
    });

    v1.get('/tools', async () => catalog(engine.usable));

    v1.post<{ Params: { name: string }; Body: { params?: Record<string, any>; stream?: boolean; format?: 'json' | 'markdown' | 'text' } }>('/tools/:name/execute', async (req, reply) => {
      const k: KeyRow = (req as any).key, name = req.params.name, t = TOOLS[name];
      if (!t) return err(reply, 404, 'unknown_tool', name);
      if (!db.canAfford(k, t.credits)) return err(reply, 402, 'no_credits', `needs ${t.credits} credits, balance ${k.credits}`);
      const { params = {}, stream = false, format = 'json' } = req.body ?? {};
      const started = Date.now();
      let log: RunLog = { tool: name, ok: false, providers: [], failedOver: [] };
      const save = () => db.record({ userId: k.user_id, keyId: k.key_id, tool: name, category: t.category, providers: log.providers, failedOver: log.failedOver, ok: log.ok, streamed: stream, ms: Date.now() - started, credits: t.credits, ip: req.ip });
      try {
        if (stream) {
          reply.hijack();
          reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
          try {
            for await (const item of engine.run(name, params, (r) => (log = r))) reply.raw.write(JSON.stringify({ type: 'item', data: item }) + '\n');
            reply.raw.end(JSON.stringify({ type: 'done', credits: t.credits, providers: log.providers }) + '\n');
          } catch (e: any) {
            reply.raw.end(JSON.stringify({ type: 'error', error: { code: e.status === 400 ? 'bad_params' : 'upstream_failed', message: e.message } }) + '\n');
          }
          return;
        }
        const items = await engine.call(name, params, (r) => (log = r));
        return { ...render(t, name, items, format), credits: t.credits, providers: log.providers, failed_over: log.failedOver };
      } catch (e: any) {
        return err(reply, e.status === 400 ? 400 : 503, e.status === 400 ? 'bad_params' : 'upstream_failed', e.message);
      } finally {
        await save().catch((e) => req.log.error(e));
      }
    });

    v1.get('/account/balance', async (req) => { const k: KeyRow = (req as any).key; return { key: k.hint, ...(await db.balance(k.user_id)) }; });
    v1.get('/account/usage', async (req) => db.usage(((req as any).key as KeyRow).user_id));
    v1.post('/account/rotate', async (req) => ({ key: await db.rotateKey(((req as any).key as KeyRow).key_id), note: 'the old key stopped working; this one is shown once' }));
  }, { prefix: '/v1' });

  // ---- admin API (dashboard) --------------------------------------------------------------------------------------
  app.register(async (admin) => {
    admin.addHook('onRequest', async (req, reply) => {
      if (!config.adminToken || bearer(req) !== config.adminToken) return err(reply, 401, 'admin_only', 'set ADMIN_TOKEN and send it as the bearer token');
    });
    admin.get('/users', async () => db.users());
    admin.get('/plans', async () => db.plans());
    admin.post<{ Body: { email: string; plan?: string } }>('/users', async (req) => {
      const u = await db.createUser(req.body.email, req.body.plan ?? 'basic');
      return { user: u, key: await db.createKey(u.id) };
    });
    admin.get<{ Params: { id: string } }>('/users/:id/keys', async (req) => db.keys(Number(req.params.id)));
    admin.post<{ Params: { id: string }; Body: { name?: string } }>('/users/:id/keys', async (req) => ({ key: await db.createKey(Number(req.params.id), req.body?.name) }));
    admin.post<{ Params: { id: string }; Body: { credits: number } }>('/users/:id/topup', async (req) => { await db.topUp(Number(req.params.id), Number(req.body.credits)); return db.balance(Number(req.params.id)); });
    admin.post<{ Params: { id: string }; Body: { plan: string } }>('/users/:id/plan', async (req) => { await db.setPlan(Number(req.params.id), req.body.plan); return db.balance(Number(req.params.id)); });
    admin.post<{ Params: { id: string } }>('/keys/:id/rotate', async (req) => ({ key: await db.rotateKey(Number(req.params.id)) }));
    admin.post<{ Params: { id: string } }>('/keys/:id/revoke', async (req) => { await db.revokeKey(Number(req.params.id)); return { ok: true }; });
    admin.post<{ Params: { id: string }; Body: { per_minute: number; ip_allow: string[] } }>('/keys/:id', async (req) => { await db.updateKey(Number(req.params.id), req.body.per_minute, req.body.ip_allow ?? []); return { ok: true }; });
    admin.get('/stats', async () => db.stats());
    admin.get('/providers', async () => ({ status: await engine.status(), log: await db.recentHealth() }));
  }, { prefix: '/admin' });

  app.get('/health', async () => ({ ok: true }));

  // Dashboard (built React app) at /
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'dist');
  if (existsSync(dist)) app.register(fstatic, { root: dist });

  return { app, engine };
}
