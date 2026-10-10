import { openDb } from './db.js';
import { connect } from './redis.js';
import { buildServer } from './server.js';
import { config } from './config.js';

const db = openDb(config.databaseUrl);
const redis = connect(config.redisUrl);
const { app } = buildServer(db, redis);
await app.listen({ port: config.port, host: config.host });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); await db.close(); redis.disconnect(); process.exit(0); });
