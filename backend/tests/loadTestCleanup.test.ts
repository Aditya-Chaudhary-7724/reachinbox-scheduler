import { EmailStatus } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma';
import { redis } from '../src/queue/connection';
import { emailQueue } from '../src/queue/queue';
import { deferKey, hourWindow, hourWindowAt, quotaKey } from '../src/queue/rateLimiter';
import { cleanupLoadTestData } from '../src/scripts/loadTestCleanup';
import { esClient } from '../src/services/search';
import { createFixtures, uid } from './helpers';

beforeEach(async () => {
  await redis.flushdb(); // DB 15 is reserved for tests
});

afterAll(async () => {
  await emailQueue.close();
  await redis.quit();
  await esClient.close();
  await prisma.$disconnect();
});

describe('cleanupLoadTestData', () => {
  it('removes only the load test’s share of shared rate-limit state', async () => {
    const now = Date.now();
    const w0 = hourWindowAt(now);
    const w1 = hourWindow(w0.index + 1);
    const w2 = hourWindow(w0.index + 2);

    const loadTest = await createFixtures();
    const realUser = await createFixtures();
    const shared = { kind: 'sender' as const, senderId: loadTest.sender.id };
    const unrelated = { kind: 'sender' as const, senderId: realUser.sender.id };

    // Load test: 2 sent this hour, deferred emails in w1 and w2 (all on the shared sender).
    await loadTest.createEmail({ status: EmailStatus.SENT });
    await loadTest.createEmail({ status: EmailStatus.SENT });
    await prisma.email.updateMany({
      where: { userId: loadTest.user.id },
      data: { sentAt: new Date(now) },
    });
    await loadTest.createEmail({ status: EmailStatus.RATE_LIMITED, scheduledAt: w1.start });
    const queued = await loadTest.createEmail({
      status: EmailStatus.RATE_LIMITED,
      scheduledAt: w2.start,
    });
    await emailQueue.add('send-email', { emailId: queued.id }, { jobId: queued.id, delay: 60_000 });

    // A real user also has an email deferred into w2 on the same sender.
    await prisma.email.create({
      data: {
        campaignId: realUser.campaign.id,
        userId: realUser.user.id,
        senderId: loadTest.sender.id,
        toAddress: `real-${uid()}@example.com`,
        subject: 's',
        body: 'b',
        scheduledAt: new Date(w2.start.getTime() + 2000),
        originalScheduledAt: new Date(now),
        status: EmailStatus.RATE_LIMITED,
      },
    });

    await redis.set(quotaKey(shared, w0), 5); // 2 load test + 3 real sends
    await redis.set(quotaKey({ kind: 'global' }, w0), 5);
    await redis.set(deferKey(shared, w1), 4);
    await redis.set(deferKey(shared, w2), 7);
    await redis.set(deferKey({ kind: 'global' }, w1), 3);
    await redis.set(deferKey(unrelated, w1), 9);
    await redis.set(`rl:notified:${loadTest.user.id}:${shared.senderId}:${w0.key}`, 1);
    await redis.set(`rl:notified:${realUser.user.id}:${shared.senderId}:${w0.key}`, 1);

    const result = await cleanupLoadTestData(loadTest.user.id, now);

    expect(result).toMatchObject({
      emails: 4,
      jobsRemoved: 1,
      notifiedKeysDeleted: 1,
      quotaReturned: 2,
    });
    expect(result.deferKeysDeleted.sort()).toEqual(
      [deferKey(shared, w1), deferKey({ kind: 'global' }, w1)].sort(),
    );
    // w2 still holds the real user's slot, so its counter must survive.
    expect(result.deferKeysKept).toEqual([deferKey(shared, w2)]);

    expect(await redis.get(deferKey(shared, w1))).toBeNull();
    expect(await redis.get(deferKey(shared, w2))).toBe('7');
    expect(await redis.get(deferKey(unrelated, w1))).toBe('9');
    expect(await redis.get(quotaKey(shared, w0))).toBe('3');
    expect(await redis.get(quotaKey({ kind: 'global' }, w0))).toBe('3');
    expect(await redis.exists(`rl:notified:${loadTest.user.id}:${shared.senderId}:${w0.key}`)).toBe(
      0,
    );
    expect(await redis.exists(`rl:notified:${realUser.user.id}:${shared.senderId}:${w0.key}`)).toBe(
      1,
    );
    expect(await emailQueue.getJob(queued.id)).toBeUndefined();

    expect(await prisma.user.findUnique({ where: { id: loadTest.user.id } })).toBeNull();
    expect(await prisma.email.count({ where: { userId: realUser.user.id } })).toBe(1);

    await prisma.email.deleteMany({ where: { senderId: loadTest.sender.id } });
    await prisma.sender.delete({ where: { id: loadTest.sender.id } });
    await realUser.cleanup();
  });

  it('never drives a quota counter below zero', async () => {
    const now = Date.now();
    const w0 = hourWindowAt(now);
    const fx = await createFixtures();
    await fx.createEmail({ status: EmailStatus.SENT });
    await fx.createEmail({ status: EmailStatus.SENT });
    await prisma.email.updateMany({
      where: { userId: fx.user.id },
      data: { sentAt: new Date(now) },
    });
    const key = quotaKey({ kind: 'sender', senderId: fx.sender.id }, w0);
    await redis.set(key, 1);

    await cleanupLoadTestData(fx.user.id, now);

    expect(await redis.get(key)).toBeNull();
    await prisma.sender.delete({ where: { id: fx.sender.id } });
  });
});
