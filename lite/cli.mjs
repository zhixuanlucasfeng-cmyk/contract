#!/usr/bin/env node
// contract-lite serve | mcp --key ct_… | key create [--name n] [--credits n] | key list | key topup <id> <n>
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startServer } from './server.mjs';
import { startMcp } from './mcp.mjs';
import { openStore } from './store.mjs';

const HOME = process.env.CONTRACT_HOME || join(homedir(), '.contract-lite');
const file = join(HOME, 'config.json');
const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const SECRET_NAMES = ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'FIRECRAWL_API_KEY', 'JINA_API_KEY'];
const config = {
  port: Number(process.env.PORT || cfg.port || 7070),
  host: process.env.HOST || cfg.host || '127.0.0.1',
  db: join(HOME, 'contract.db'),
  // Upstream provider keys live only on the gateway: config.json "secrets", or environment variables.
  secrets: { ...cfg.secrets, ...Object.fromEntries(SECRET_NAMES.filter((n) => process.env[n]).map((n) => [n, process.env[n]])) },
  faults: { ...cfg.faults, ...(process.env.CONTRACT_FAULTS ? JSON.parse(process.env.CONTRACT_FAULTS) : {}) },
  settings: cfg.settings ?? {},
};

const [cmd, sub, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

if (cmd === 'serve') {
  await startServer(config);
  console.error(`contract-lite → http://${config.host}:${config.port}  (dashboard: /dashboard)`);
} else if (cmd === 'mcp') {
  const key = flag('key', process.env.CONTRACT_KEY);
  if (!key) { console.error('usage: contract-lite mcp --key ct_…  [--url http://127.0.0.1:7070]'); process.exit(1); }
  await startMcp({ url: flag('url', process.env.CONTRACT_URL || `http://127.0.0.1:${config.port}`), key });
} else if (cmd === 'key') {
  const store = openStore(config.db);
  if (sub === 'create') console.log(store.create({ name: flag('name', 'default'), credits: Number(flag('credits', 1000)) }));
  else if (sub === 'list') console.table(store.list());
  else if (sub === 'topup') { store.topUp(Number(rest[0]), Number(rest[1])); console.table(store.list()); }
  else console.error('usage: contract-lite key create|list|topup <id> <credits>');
} else {
  console.error('usage: contract-lite serve | mcp --key ct_… | key create|list|topup');
  process.exit(1);
}
