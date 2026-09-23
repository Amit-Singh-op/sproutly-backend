import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { log } from '../lib/log.js';
import { createRealtime } from './server.js';

const { io, httpServer } = createRealtime();
httpServer.listen(config.rtPort, () => log.info(`realtime listening on :${config.rtPort}`));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    io.close();
    await pool.end();
    process.exit(0);
  });
}
