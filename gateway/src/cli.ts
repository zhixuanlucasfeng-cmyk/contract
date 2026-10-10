// npm run cli -- user create you@example.com [plan]   |  key create <userId>  |  topup <userId> <credits>  |  users
import { openDb } from './db.js';
import { config } from './config.js';

const db = openDb(config.databaseUrl);
const [cmd, sub, ...a] = process.argv.slice(2);
if (cmd === 'user' && sub === 'create') { const u = await db.createUser(a[0], a[1] ?? 'basic'); console.log({ user: u.id, plan: u.plan_id, credits: u.credits, key: await db.createKey(u.id) }); }
else if (cmd === 'key' && sub === 'create') console.log(await db.createKey(Number(a[0])));
else if (cmd === 'topup') { await db.topUp(Number(sub), Number(a[0])); console.log(await db.balance(Number(sub))); }
else if (cmd === 'users') console.table(await db.users());
else console.error('usage: user create <email> [basic|pro|enterprise] | key create <userId> | topup <userId> <credits> | users');
await db.close();
