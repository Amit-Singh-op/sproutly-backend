/**
 * All-in-one: REST API + Socket.IO realtime on ONE port, plus the BullMQ worker, in one process.
 * For a single hosted service (e.g. Render free tier: no background workers, one URL).
 * The app then uses the same base URL for both EXPO_PUBLIC_API_URL (+/v1) and EXPO_PUBLIC_RT_URL.
 * Scale-out later by running api / realtime / worker as separate services instead.
 */
import { config } from './config.js';
import { pool } from './db/pool.js';
import { log } from './lib/log.js';
import { buildApp } from './api/app.js';
import { createRealtime } from './realtime/server.js';

const app = await buildApp();
// Socket.IO takes /socket.io/* on the same HTTP server; Fastify keeps every other route (incl. /healthz).
const { io } = createRealtime(app.server);
await app.listen({ port: config.apiPort, host: '0.0.0.0' });
log.info(`api + realtime listening on :${config.apiPort}`);

await import('./worker/index.js');

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    io.close();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
