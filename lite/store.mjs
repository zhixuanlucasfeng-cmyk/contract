// Master keys, credits and usage in one SQLite file. Keys are stored as SHA-256 hashes; the full key is shown once.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const newKey = () => 'ct_' + [...randomBytes(32)].map((b) => ALPHA[b % ALPHA.length]).join('');
const hash = (k) => createHash('sha256').update(k).digest('hex');

export function openStore(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    create table if not exists keys (
      id integer primary key, hash text unique not null, hint text not null, name text not null,
      credits integer not null default 1000, per_minute integer not null default 60, ip_allow text not null default '',
      created text not null default (datetime('now')), revoked integer not null default 0);
    create table if not exists usage (
      id integer primary key, key_id integer not null references keys(id), tool text not null, provider text,
      ok integer not null, ms integer not null, credits integer not null, failed_over text not null default '[]',
      at text not null default (datetime('now')));
    create index if not exists usage_key_at on usage(key_id, at);`);

  const create = ({ name = 'default', credits = 1000, perMinute = 60, ipAllow = '' } = {}) => {
    const key = newKey();
    db.prepare('insert into keys(hash, hint, name, credits, per_minute, ip_allow) values (?, ?, ?, ?, ?, ?)').run(hash(key), key.slice(0, 7) + '…' + key.slice(-4), name, credits, perMinute, ipAllow);
    return key;
  };
  const find = (key) => (key?.startsWith('ct_') ? db.prepare('select * from keys where hash = ? and revoked = 0').get(hash(key)) : undefined);
  // Rotate: same account (credits, usage), new secret.
  const rotate = (id) => { const key = newKey(); db.prepare('update keys set hash = ?, hint = ? where id = ?').run(hash(key), key.slice(0, 7) + '…' + key.slice(-4), id); return key; };
  const list = () => db.prepare('select id, hint, name, credits, per_minute, ip_allow, created, revoked from keys order by id').all();
  const charge = (id, n) => db.prepare('update keys set credits = credits - ? where id = ?').run(n, id);
  const topUp = (id, n) => db.prepare('update keys set credits = credits + ? where id = ?').run(n, id);
  const record = (r) => db.prepare('insert into usage(key_id, tool, provider, ok, ms, credits, failed_over) values (?, ?, ?, ?, ?, ?, ?)')
    .run(r.keyId, r.tool, r.provider ?? null, r.ok ? 1 : 0, r.ms, r.credits, JSON.stringify(r.failedOver ?? []));
  const usage = (id) => ({
    byDay: db.prepare(`select substr(at, 1, 10) day, tool, count(*) calls, sum(credits) credits, sum(ok = 0) errors from usage where key_id = ? group by day, tool order by day desc limit 90`).all(id),
    recent: db.prepare('select tool, provider, ok, ms, credits, failed_over, at from usage where key_id = ? order by id desc limit 20').all(id),
    used: db.prepare('select coalesce(sum(credits), 0) n from usage where key_id = ?').get(id).n,
  });
  return { create, find, rotate, list, charge, topUp, record, usage, close: () => db.close() };
}

// Per-key sliding one-minute window. ponytail: in-memory, per process; use Redis when running several instances.
export function rateLimiter() {
  const hits = new Map();
  return (id, perMinute, t = Date.now()) => {
    const h = (hits.get(id) ?? []).filter((x) => x > t - 60000);
    if (h.length >= perMinute) { hits.set(id, h); return false; }
    h.push(t); hits.set(id, h); return true;
  };
}
