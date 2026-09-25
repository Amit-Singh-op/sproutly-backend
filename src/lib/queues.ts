import { Queue, type JobsOptions } from 'bullmq';
import { bullConnection } from './redis.js';

/** Queue names (doc section 10). Every job id is derived from its triggering event, so enqueueing twice is a no-op. */
export const QUEUES = ['push', 'quests', 'showcase-fanout', 'entitlement-sync', 'maintenance'] as const;
export type QueueName = (typeof QUEUES)[number];

export const JOB_DEFAULTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: false, // failed jobs stay as the dead-letter record
};

const cache = new Map<QueueName, Queue>();
export function queue(name: QueueName): Queue {
  let qu = cache.get(name);
  if (!qu) {
    qu = new Queue(name, { connection: bullConnection(), defaultJobOptions: JOB_DEFAULTS });
    cache.set(name, qu);
  }
  return qu;
}

export type PushJob =
  | { kind: 'message'; messageId: string }
  | { kind: 'cheer'; postId: string; fromUserId: string }
  | { kind: 'invite'; inviteId: string }
  | { kind: 'level'; userId: string; level: number }
  | { kind: 'guestbook'; entryId: string };
export type QuestJob = { kind: 'message.sent'; messageId: string } | { kind: 'room.visit'; ownerId: string; visitorId: string };
export type FanoutJob = { postId: string };
export type EntitlementJob = { userId: string; reason: 'upgrade' | 'downgrade' };

/** BullMQ rejects custom job ids containing ":" (its key separator). */
const jobId = (id: string) => id.replace(/:/g, '_');

export const enqueue = {
  push: (id: string, data: PushJob) => queue('push').add(data.kind, data, { jobId: jobId(id) }),
  quests: (id: string, data: QuestJob) => queue('quests').add(data.kind, data, { jobId: jobId(id) }),
  fanout: (data: FanoutJob) => queue('showcase-fanout').add('fanout', data, { jobId: jobId(`fanout:${data.postId}`) }),
  entitlement: (id: string, data: EntitlementJob) => queue('entitlement-sync').add(data.reason, data, { jobId: jobId(id) }),
};
