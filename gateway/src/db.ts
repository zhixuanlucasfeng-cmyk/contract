import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const newKey = () => 'ct_' + [...randomBytes(32)].map((b) => ALPHA[b % ALPHA.length]).join('');
export const hashKey = (k: string) => createHash('sha256').update(k).digest('hex');
const hint = (k: string) => `${k.slice(0, 7)}…${k.slice(-4)}`;

export interface KeyRow { key_id: number; user_id: number; hint: string; per_minute: number; ip_allow: string[]; credits: number; plan_id: string; overage_allowed: boolean; overage_limit: number; email: string }

export function openDb(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const q = async <T = any>(sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows as T[];

  return {
    pool,
    async findKey(raw: string): Promise<KeyRow | undefined> {
      if (!raw?.startsWith('ct_')) return undefined;
      const [k] = await q<KeyRow>(`select k.id key_id, k.user_id, k.hint, k.per_minute, k.ip_allow, u.credits, u.plan_id, p.overage_allowed, p.overage_limit, u.email
        from api_keys k join users u on u.id = k.user_id join plans p on p.id = u.plan_id where k.key_hash = $1 and k.revoked_at is null`, [hashKey(raw)]);
      if (k) void q('update api_keys set last_used_at = now() where id = $1', [k.key_id]);
      return k;
    },
    canAfford: (k: KeyRow, cost: number) => k.credits - cost >= (k.overage_allowed ? -k.overage_limit : 0),

    /** One transaction: usage row, and on success the credit charge + ledger entry. */
    async record(e: { userId: number; keyId: number; tool: string; category: string; providers: string[]; failedOver: unknown[]; ok: boolean; streamed: boolean; ms: number; credits: number; ip?: string }) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        const { rows: [u] } = await c.query(`insert into usage_events (user_id, key_id, tool, category, providers, failed_over, ok, streamed, ms, credits, ip)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`, [e.userId, e.keyId, e.tool, e.category, e.providers, JSON.stringify(e.failedOver), e.ok, e.streamed, e.ms, e.ok ? e.credits : 0, e.ip ?? null]);
        if (e.ok && e.credits) {
          await c.query('update users set credits = credits - $1 where id = $2', [e.credits, e.userId]);
          await c.query('insert into credit_ledger (user_id, delta, reason, usage_id) values ($1, $2, $3, $4)', [e.userId, -e.credits, `charge:${e.tool}`, u.id]);
        }
        await c.query('commit');
      } catch (err) { await c.query('rollback'); throw err; } finally { c.release(); }
    },

    async createUser(email: string, plan = 'basic') {
      const [u] = await q('insert into users (email, plan_id, credits) select $1, id, monthly_credits from plans where id = $2 returning *', [email, plan]);
      if (!u) throw new Error(`unknown plan ${plan}`);
      await q('insert into credit_ledger (user_id, delta, reason) values ($1, $2, $3)', [u.id, u.credits, 'monthly_grant']);
      return u;
    },
    async createKey(userId: number, name = 'default', perMinute = 60, ipAllow: string[] = []) {
      const key = newKey();
      await q('insert into api_keys (user_id, key_hash, hint, name, per_minute, ip_allow) values ($1,$2,$3,$4,$5,$6)', [userId, hashKey(key), hint(key), name, perMinute, ipAllow]);
      return key;
    },
    /** Same key row (limits, history), new secret; the old one stops working at once. */
    async rotateKey(keyId: number) {
      const key = newKey();
      await q('update api_keys set key_hash = $1, hint = $2 where id = $3', [hashKey(key), hint(key), keyId]);
      return key;
    },
    revokeKey: (keyId: number) => q('update api_keys set revoked_at = now() where id = $1', [keyId]),
    updateKey: (keyId: number, perMinute: number, ipAllow: string[]) => q('update api_keys set per_minute = $2, ip_allow = $3 where id = $1', [keyId, perMinute, ipAllow]),
    async topUp(userId: number, n: number, reason = 'topup') {
      await q('update users set credits = credits + $1 where id = $2', [n, userId]);
      await q('insert into credit_ledger (user_id, delta, reason) values ($1, $2, $3)', [userId, n, reason]);
    },
    setPlan: (userId: number, plan: string) => q('update users set plan_id = $2 where id = $1', [userId, plan]),

    async balance(userId: number) {
      const [u] = await q(`select u.email, u.credits, u.plan_id, p.name plan_name, p.monthly_credits, p.overage_allowed, p.overage_limit, u.period_end,
        (select coalesce(-sum(delta), 0) from credit_ledger where user_id = u.id and delta < 0 and created_at >= u.period_end - interval '1 month') used_this_period
        from users u join plans p on p.id = u.plan_id where u.id = $1`, [userId]);
      return u;
    },
    usage: (userId: number) => Promise.all([
      q(`select date(created_at) as day, category, tool, count(*)::int calls, sum((not ok)::int)::int errors, sum(credits)::int credits
         from usage_events where user_id = $1 and created_at > now() - interval '30 days' group by 1, 2, 3 order by 1 desc, 4 desc`, [userId]),
      q(`select tool, providers, failed_over, ok, streamed, ms, credits, created_at from usage_events where user_id = $1 order by id desc limit 30`, [userId]),
      q(`select delta, reason, created_at from credit_ledger where user_id = $1 order by id desc limit 30`, [userId]),
    ]).then(([byDay, recent, ledger]) => ({ byDay, recent, ledger })),

    // Admin
    users: () => q(`select u.id, u.email, u.plan_id, u.credits, u.period_end, u.created_at,
      (select count(*)::int from api_keys k where k.user_id = u.id and k.revoked_at is null) keys,
      (select count(*)::int from usage_events e where e.user_id = u.id and e.created_at > now() - interval '1 day') calls_24h
      from users u order by u.id`),
    keys: (userId: number) => q('select id, hint, name, per_minute, ip_allow, created_at, last_used_at, revoked_at from api_keys where user_id = $1 order by id', [userId]),
    plans: () => q('select * from plans order by monthly_credits'),
    stats: () => q(`select tool, category, count(*)::int calls, sum((not ok)::int)::int errors, sum((jsonb_array_length(failed_over) > 0)::int)::int failovers,
      round(avg(ms))::int avg_ms, sum(credits)::int credits from usage_events where created_at > now() - interval '1 day' group by 1, 2 order by 3 desc`),
    healthLog: (provider: string, event: string, detail = '') => q('insert into provider_health_log (provider, event, detail) values ($1, $2, $3)', [provider, event, detail.slice(0, 500)]),
    recentHealth: () => q('select provider, event, detail, created_at from provider_health_log order by id desc limit 50'),

    // Worker jobs
    rollup: () => q(`insert into usage_daily (user_id, day, category, tool, calls, errors, credits)
      select user_id, date(created_at), category, tool, count(*), sum((not ok)::int), sum(credits) from usage_events
      where created_at >= date(now()) - 1 group by 1, 2, 3, 4
      on conflict (user_id, day, tool) do update set calls = excluded.calls, errors = excluded.errors, credits = excluded.credits`),
    /** New billing period: reset to the plan's monthly credits (overage debt is carried, unused credits expire). */
    monthlyGrant: () => q(`with due as (
        update users u set credits = least(u.credits, 0) + p.monthly_credits, period_end = u.period_end + interval '1 month'
        from plans p where p.id = u.plan_id and u.period_end <= now() returning u.id, p.monthly_credits)
      insert into credit_ledger (user_id, delta, reason) select id, monthly_credits, 'monthly_grant' from due returning user_id`),
    close: () => pool.end(),
  };
}
export type Db = ReturnType<typeof openDb>;
