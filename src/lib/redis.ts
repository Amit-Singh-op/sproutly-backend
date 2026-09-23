import { Redis } from 'ioredis';
import { config } from '../config.js';

/** General-purpose client (cache, rate limits, presence, typing). */
export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });

/** BullMQ needs its own connections with maxRetriesPerRequest = null. */
export const bullConnection = () => new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
