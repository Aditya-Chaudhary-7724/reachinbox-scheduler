import IORedis, { type Redis } from 'ioredis';
import { env } from '../config/env';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on connections used by workers
 * (blocking commands must not be retried/aborted by ioredis).
 */
export function createRedisConnection(): Redis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

/** Shared connection for queues, rate limiting and health checks within one process. */
export const redis = createRedisConnection();
