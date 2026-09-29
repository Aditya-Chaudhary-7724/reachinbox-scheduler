import { DelayedError, type Job } from 'bullmq';
import { EmailStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma';
import { redis } from '../src/queue/connection';
import { processEmailJob } from '../src/queue/processor';
import type { EmailJobData } from '../src/queue/queue';
import { hourWindowAt } from '../src/queue/rateLimiter';
import { signToken } from '../src/services/auth';
import { esClient } from '../src/services/search';
import { completeSlackOAuth } from '../src/services/slack';
import { createFixtures, startSlackStub } from './helpers';

/** Minimal stand-in for a BullMQ Job that records moveToDelayed calls. */
function fakeJob(emailId: string) {
  const delayedTo: number[] = [];
  const job = {
    data: { emailId },
    opts: { attempts: 3 },
    attemptsMade: 0,
    moveToDelayed: async (ts: number) => {
      delayedTo.push(ts);
    },
  } as unknown as Job<EmailJobData>;
  return { job, delayedTo };
}

let stub: Awaited<ReturnType<typeof startSlackStub>>;

beforeAll(async () => {
  stub = await startSlackStub();
});

beforeEach(() => {
  stub.requests.length = 0;
});

afterAll(async () => {
  await stub.close();
  await redis.quit();
  await prisma.$disconnect();
  await esClient.close();
});

describe('processEmailJob with hourly limits (MOCK_SMTP)', () => {
  it('sends up to the limit, then defers in order to the next hour and alerts Slack once', async () => {
    const fx = await createFixtures(2); // campaign hourlyLimit = 2
    await completeSlackOAuth('good-code', signToken(fx.user.id, 'slack_state', 600));
    const emails = [];
    for (let i = 0; i < 5; i++) emails.push(await fx.createEmail());

    const outcomes: string[] = [];
    const delays: number[][] = [];
    for (const email of emails) {
      const { job, delayedTo } = fakeJob(email.id);
      try {
        outcomes.push(await processEmailJob(job, 'token'));
      } catch (err) {
        outcomes.push(err instanceof DelayedError ? 'delayed' : 'error');
      }
      delays.push(delayedTo);
    }

    expect(outcomes).toEqual(['sent', 'sent', 'delayed', 'delayed', 'delayed']);

    const nextHour = hourWindowAt(Date.now()).end.getTime();
    const deferredRuns = delays.slice(2).map((d) => d[0]);
    // Next hour holds `limit` (2) slots spaced by the 1s test interval; the third rolls over.
    expect(deferredRuns).toEqual([nextHour, nextHour + 1000, nextHour + 3600_000]);

    const rows = await prisma.email.findMany({
      where: { campaignId: fx.campaign.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual([
      EmailStatus.SENT,
      EmailStatus.SENT,
      EmailStatus.RATE_LIMITED,
      EmailStatus.RATE_LIMITED,
      EmailStatus.RATE_LIMITED,
    ]);
    expect(rows[2]?.scheduledAt.getTime()).toBe(nextHour);
    // originalScheduledAt keeps the user's requested time.
    expect(rows[2]?.originalScheduledAt.getTime()).toBe(emails[2]?.scheduledAt.getTime());

    // Exactly one Slack alert for this sender and window, with the useful details.
    const posts = stub.webhookPosts();
    expect(posts).toHaveLength(1);
    const text = (JSON.parse(posts[0]?.body ?? '{}') as { text: string }).text;
    expect(text).toContain(fx.sender.email);
    expect(text).toContain('2 emails/hour');
    expect(text).toContain('3 email(s) deferred');

    // A deferred job re-fired before its new time is pushed back, not sent.
    const early = fakeJob(emails[2]!.id);
    await expect(processEmailJob(early.job, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(early.delayedTo).toEqual([nextHour]);

    await fx.cleanup();
  });

  it('defers normally and skips Slack when the user has not connected Slack', async () => {
    const fx = await createFixtures(1);
    const [a, b] = [await fx.createEmail(), await fx.createEmail()];
    expect(await processEmailJob(fakeJob(a.id).job, 'token')).toBe('sent');
    await expect(processEmailJob(fakeJob(b.id).job, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect((await prisma.email.findUniqueOrThrow({ where: { id: b.id } })).status).toBe(
      EmailStatus.RATE_LIMITED,
    );
    expect(stub.webhookPosts()).toHaveLength(0);
    await fx.cleanup();
  });

  it('records a sent email with message id and does not resend it', async () => {
    const fx = await createFixtures();
    const email = await fx.createEmail();
    expect(await processEmailJob(fakeJob(email.id).job, 'token')).toBe('sent');
    const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(row.messageId).toBe(`<${email.id}@reachinbox.local>`);
    expect(row.sentAt).not.toBeNull();
    expect(await processEmailJob(fakeJob(email.id).job, 'token')).toBe('skipped');
    await fx.cleanup();
  });
});
