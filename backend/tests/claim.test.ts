import { EmailStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma';
import { redis } from '../src/queue/connection';
import { claimEmail } from '../src/services/email';

let userId: string;
let senderId: string;
let campaignId: string;

async function createEmail(overrides: Partial<{ status: EmailStatus; scheduledAt: Date }> = {}) {
  const scheduledAt = overrides.scheduledAt ?? new Date(Date.now() - 1000);
  return prisma.email.create({
    data: {
      campaignId,
      userId,
      senderId,
      toAddress: `lead-${Math.random().toString(36).slice(2)}@example.com`,
      subject: 's',
      body: 'b',
      scheduledAt,
      originalScheduledAt: scheduledAt,
      status: overrides.status ?? EmailStatus.SCHEDULED,
    },
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { googleId: `test-${Date.now()}`, email: 'claim@test.dev', name: 'Claim Test' },
  });
  const sender = await prisma.sender.create({
    data: {
      name: 'Test Sender',
      email: `sender-${Date.now()}@test.dev`,
      smtpHost: 'localhost',
      smtpPort: 587,
      smtpUser: 'u',
      smtpPass: 'p',
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      subject: 's',
      body: 'b',
      startTime: new Date(),
      delayBetweenMs: 0,
      hourlyLimit: 10,
      totalEmails: 0,
    },
  });
  userId = user.id;
  senderId = sender.id;
  campaignId = campaign.id;
});

beforeEach(async () => {
  await prisma.email.deleteMany({ where: { campaignId } });
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
  await prisma.sender.delete({ where: { id: senderId } });
  await prisma.$disconnect();
  await redis.quit();
});

describe('claimEmail (atomic idempotent claim)', () => {
  it('lets exactly one of many concurrent claims win', async () => {
    const email = await createEmail();
    const results = await Promise.all(Array.from({ length: 10 }, () => claimEmail(email.id)));

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(row.status).toBe(EmailStatus.SENDING);
    expect(row.attempts).toBe(1);
  });

  it('never claims an email that is already SENT or FAILED', async () => {
    const sent = await createEmail({ status: EmailStatus.SENT });
    const failed = await createEmail({ status: EmailStatus.FAILED });
    expect(await claimEmail(sent.id)).toBeNull();
    expect(await claimEmail(failed.id)).toBeNull();
  });

  it('does not claim an email before its scheduledAt', async () => {
    const future = await createEmail({ scheduledAt: new Date(Date.now() + 60_000) });
    expect(await claimEmail(future.id)).toBeNull();
  });

  it('claims RATE_LIMITED emails once they are due', async () => {
    const email = await createEmail({ status: EmailStatus.RATE_LIMITED });
    expect(await claimEmail(email.id)).not.toBeNull();
  });

  it('reclaims a SENDING row only after it is stale', async () => {
    const email = await createEmail();
    expect(await claimEmail(email.id)).not.toBeNull();
    // Fresh SENDING claim: another worker is mid-send.
    expect(await claimEmail(email.id)).toBeNull();

    // Pretend the claiming worker crashed long ago.
    await prisma.$executeRaw`UPDATE "Email" SET "updatedAt" = ${new Date(Date.now() - 24 * 3600_000)} WHERE id = ${email.id}`;
    const reclaimed = await claimEmail(email.id);
    expect(reclaimed?.attempts).toBe(2);
  });
});
