import { Redis } from 'ioredis';
import { config } from '../config.js';

/** General-purpose client (cache, rate limits, presence, typing). */
// Fail fast: if Redis is unreachable, requests error within seconds (and it's logged) instead of hanging.
export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, connectTimeout: 5_000, commandTimeout: 5_000 });
redis.on('error', (err) => console.warn('[redis]', err.message));

/** BullMQ needs its own connections with maxRetriesPerRequest = null. */
export const bullConnection = () => new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
