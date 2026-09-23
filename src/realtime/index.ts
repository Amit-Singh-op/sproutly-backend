import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { log } from '../lib/log.js';
import { createRealtime } from './server.js';

const { io, httpServer } = createRealtime();
httpServer.listen(config.RT_PORT, () => log.info(`realtime listening on :${config.RT_PORT}`));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    io.close();
    await pool.end();
    process.exit(0);
  });
}
