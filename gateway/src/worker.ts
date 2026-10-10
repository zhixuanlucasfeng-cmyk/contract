// Background jobs (BullMQ): probe cooling providers so they come back on their own, roll up daily usage,
// and start each user's new billing period.
import { Queue, Worker } from 'bullmq';
import { openDb } from './db.js';
import { connect, redisHealth } from './redis.js';
import { TOOLS } from './registry.js';
import { config } from './config.js';

const db = openDb(config.databaseUrl);
const redis = connect(config.redisUrl);
const health = redisHealth(redis);
const connection = connect(config.redisUrl);
const queue = new Queue('contract', { connection });

await queue.upsertJobScheduler('health-probe', { every: 60_000 }, { name: 'health-probe' });
await queue.upsertJobScheduler('usage-rollup', { every: 3_600_000 }, { name: 'usage-rollup' });
await queue.upsertJobScheduler('monthly-grant', { every: 3_600_000 }, { name: 'monthly-grant' });

async function probe() {
  const seen = new Set<string>();
  for (const t of Object.values(TOOLS)) for (const p of t.providers) {
    if (seen.has(p.id) || !p.probe || (p.needs && !config.secrets[p.needs])) continue;
    seen.add(p.id);
    if ((await health.coolingUntil(p.id)) <= Date.now()) continue; // only probe providers that are cooling down
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 10_000);
    try {
      for await (const _ of p.stream({ ...p.probe }, { key: config.secrets[p.needs ?? p.optional ?? ''], signal: ac.signal })) break;
      await health.success(p.id);
      await db.healthLog(p.id, 'recovered', 'probe ok');
    } catch (e: any) {
      await db.healthLog(p.id, 'probe_fail', e.message);
    } finally { clearTimeout(timer); }
  }
}

new Worker('contract', async (job) => {
  if (job.name === 'health-probe') return probe();
  if (job.name === 'usage-rollup') return db.rollup();
  if (job.name === 'monthly-grant') return db.monthlyGrant();
}, { connection: connect(config.redisUrl) });

console.log('contract worker: health-probe 60s, usage-rollup 1h, monthly-grant 1h');
