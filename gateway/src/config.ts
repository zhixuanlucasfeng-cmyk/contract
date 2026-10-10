import { SECRET_NAMES } from './registry.js';
import type { Settings } from './engine.js';

const envJson = <T>(name: string, fallback: T): T => { try { return process.env[name] ? JSON.parse(process.env[name]!) : fallback; } catch { return fallback; } };

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://contract:contract@localhost:5432/contract',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  adminToken: process.env.ADMIN_TOKEN ?? '',
  // Upstream credentials live only in the gateway's environment, never with users.
  secrets: Object.fromEntries(SECRET_NAMES.map((n) => [n, process.env[n]])) as Record<string, string | undefined>,
  faults: envJson<Record<string, string>>('CONTRACT_FAULTS', {}),
  settings: envJson<Record<string, Partial<Settings>>>('CONTRACT_SETTINGS', {}),
  // Anomaly guard: this many bad keys from one IP within a minute blocks that IP for blockMinutes.
  authFailLimit: Number(process.env.AUTH_FAIL_LIMIT ?? 20),
  blockMinutes: Number(process.env.BLOCK_MINUTES ?? 10),
};
