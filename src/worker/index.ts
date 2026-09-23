import { Worker, type Job } from 'bullmq';
import { pool } from '../db/pool.js';
import { log } from '../lib/log.js';
import { bullConnection } from '../lib/redis.js';
import { queue, type EntitlementJob, type FanoutJob, type PushJob, type QuestJob } from '../lib/queues.js';
import { cleanup, expireLapsedSubscriptions, handleEntitlement, handleFanout, handleQuest, streakResets, weeklyTop } from './jobs.js';
import { handlePush } from './push.js';

const workers = [
  new Worker<PushJob>('push', (j) => handlePush(j.data), { connection: bullConnection(), concurrency: 20 }),
  new Worker<QuestJob>('quests', (j) => handleQuest(j.data), { connection: bullConnection(), concurrency: 10 }),
  new Worker<FanoutJob>('showcase-fanout', (j) => handleFanout(j.data), { connection: bullConnection(), concurrency: 5 }),
  new Worker<EntitlementJob>('entitlement-sync', (j) => handleEntitlement(j.data), { connection: bullConnection(), concurrency: 5 }),
  new Worker('maintenance', async (j: Job) => {
    switch (j.name) {
      case 'weekly-top': return weeklyTop();
      case 'streaks': return streakResets();
      case 'expire-subscriptions': return expireLapsedSubscriptions();
      case 'cleanup': return cleanup();
    }
  }, { connection: bullConnection(), concurrency: 1 }),
];

for (const w of workers) {
  // After 5 attempts a job stays in the failed set (the dead-letter queue) and we alert.
  w.on('failed', (job, err) => {
    const final = job && job.attemptsMade >= (job.opts.attempts ?? 1);
    log[final ? 'error' : 'warn']({ queue: w.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, final ? 'job dead-lettered' : 'job failed, will retry');
  });
}

// Cron schedules (idempotent: upsert by scheduler id).
const m = queue('maintenance');
await m.upsertJobScheduler('weekly-top', { pattern: '0 0 * * 1', tz: 'UTC' }, { name: 'weekly-top' });
await m.upsertJobScheduler('streaks', { pattern: '5 * * * *' }, { name: 'streaks' });
await m.upsertJobScheduler('expire-subscriptions', { pattern: '15 * * * *' }, { name: 'expire-subscriptions' });
await m.upsertJobScheduler('cleanup', { pattern: '30 3 * * *', tz: 'UTC' }, { name: 'cleanup' });

log.info('worker running: push, quests, showcase-fanout, entitlement-sync, maintenance');

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await Promise.all(workers.map((w) => w.close()));
    await pool.end();
    process.exit(0);
  });
}
