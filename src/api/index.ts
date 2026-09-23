import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { startKeepAlive } from '../lib/keepalive.js';
import { log } from '../lib/log.js';
import { buildApp } from './app.js';

const app = await buildApp();
await app.listen({ port: config.apiPort, host: '0.0.0.0' });
log.info(`api listening on :${config.apiPort}`);
startKeepAlive();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
