/**
 * Removes everything a load test left behind for one (load-test) user: queued jobs,
 * search documents, rows, and the Redis rate-limit state that user's emails created.
 *
 * Rate-limit counters are keyed by sender (shared with real users), so they are never
 * deleted wholesale. Only the load test's own share is removed:
 *  - rl:notified:{userId}:*          user-scoped alert guards → deleted
 *  - rl:defer:{sender|global}:{hour} deferral slot counters   → deleted only for windows in
 *                                     which no other user still has a deferred email
 *  - rl:{sender|global}:{hour}       current-hour quota      → decremented by the number of
 *                                     load-test emails sent this hour (never below 0)
 */
import { EmailStatus } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { redis } from '../queue/connection';
import { emailQueue } from '../queue/queue';
import {
  deferKey,
  hourWindow,
  hourWindowAt,
  quotaKey,
  type HourWindow,
  type Scope,
} from '../queue/rateLimiter';
import { esClient } from '../services/search';

// Decrement without going negative; drop the key when it reaches 0.
const DECREMENT_FLOOR_ZERO_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 0 then return 0 end
local next = math.max(current - tonumber(ARGV[1]), 0)
if next == 0 then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], next, 'KEEPTTL') end
return next
`;

export interface LoadTestCleanupResult {
  emails: number;
  jobsRemoved: number;
  notifiedKeysDeleted: number;
  deferKeysDeleted: string[];
  deferKeysKept: string[];
  quotaReturned: number;
}

async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return keys;
}

/** Does any *other* user still hold a deferred slot in this scope/window? */
async function othersDeferredIn(userId: string, scope: Scope, window: HourWindow) {
  const count = await prisma.email.count({
    where: {
      userId: { not: userId },
      status: EmailStatus.RATE_LIMITED,
      scheduledAt: { gte: window.start, lt: window.end },
      ...(scope.kind === 'sender' ? { senderId: scope.senderId } : {}),
    },
  });
  return count > 0;
}

export async function cleanupLoadTestData(
  userId: string,
  now = Date.now(),
): Promise<LoadTestCleanupResult> {
  const emails = await prisma.email.findMany({
    where: { userId },
    select: { id: true, senderId: true, status: true, scheduledAt: true, sentAt: true },
  });
  const current = hourWindowAt(now);

  // 1. Queued jobs.
  let jobsRemoved = 0;
  for (const { id } of emails) {
    const job = await emailQueue.getJob(id);
    if (job) {
      await job.remove();
      jobsRemoved++;
    }
  }

  // 2. Alert guards (user-scoped).
  const notifiedKeys = await scanKeys(`rl:notified:${userId}:*`);
  if (notifiedKeys.length > 0) await redis.del(...notifiedKeys);

  // 3. Deferral counters for future windows the load test reserved slots in.
  const senderIds = [...new Set(emails.map((e) => e.senderId))];
  const scopes: Scope[] = [
    ...senderIds.map((senderId) => ({ kind: 'sender' as const, senderId })),
    { kind: 'global' },
  ];
  const lastDeferred = Math.max(
    0,
    ...emails
      .filter((e) => e.status === EmailStatus.RATE_LIMITED)
      .map((e) => e.scheduledAt.getTime()),
  );
  const deferKeysDeleted: string[] = [];
  const deferKeysKept: string[] = [];
  if (lastDeferred > 0) {
    const lastIndex = hourWindowAt(lastDeferred).index;
    for (let index = current.index + 1; index <= lastIndex; index++) {
      const window = hourWindow(index);
      for (const scope of scopes) {
        const key = deferKey(scope, window);
        if (!(await redis.exists(key))) continue;
        if (await othersDeferredIn(userId, scope, window)) deferKeysKept.push(key);
        else {
          await redis.del(key);
          deferKeysDeleted.push(key);
        }
      }
    }
  }

  // 4. Give back the current hour's quota consumed by load-test sends.
  const sentThisHour = emails.filter(
    (e) =>
      e.status === EmailStatus.SENT &&
      e.sentAt &&
      e.sentAt >= current.start &&
      e.sentAt < current.end,
  );
  const perSender = new Map<string, number>();
  for (const e of sentThisHour) perSender.set(e.senderId, (perSender.get(e.senderId) ?? 0) + 1);
  for (const [senderId, n] of perSender) {
    await redis.eval(
      DECREMENT_FLOOR_ZERO_LUA,
      1,
      quotaKey({ kind: 'sender', senderId }, current),
      n,
    );
  }
  if (sentThisHour.length > 0) {
    await redis.eval(
      DECREMENT_FLOOR_ZERO_LUA,
      1,
      quotaKey({ kind: 'global' }, current),
      sentThisHour.length,
    );
  }

  // 5. Search documents and rows (campaigns and emails cascade from the user).
  await esClient
    .deleteByQuery({ index: env.ELASTICSEARCH_INDEX, query: { term: { userId } }, refresh: true })
    .catch(() => undefined);
  await prisma.user.delete({ where: { id: userId } });

  return {
    emails: emails.length,
    jobsRemoved,
    notifiedKeysDeleted: notifiedKeys.length,
    deferKeysDeleted,
    deferKeysKept,
    quotaReturned: sentThisHour.length,
  };
}
