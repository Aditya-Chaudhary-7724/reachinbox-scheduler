import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma';
import { redis } from '../src/queue/connection';
import { emailQueue } from '../src/queue/queue';
import { createCampaignSchema } from '../src/routes/campaigns';
import { createCampaign } from '../src/services/scheduler';
import { esClient } from '../src/services/search';
import { createFixtures } from './helpers';

let owner: Awaited<ReturnType<typeof createFixtures>>;
let other: Awaited<ReturnType<typeof createFixtures>>;
const enqueued: string[] = [];

beforeAll(async () => {
  owner = await createFixtures();
  other = await createFixtures(); // provides a second sender in the pool
});

afterAll(async () => {
  await Promise.all(enqueued.map((id) => emailQueue.remove(id)));
  await owner.cleanup();
  await other.cleanup();
  await emailQueue.close();
  await redis.quit();
  await esClient.close();
  await prisma.$disconnect();
});

const input = (senderId?: string) => ({
  userId: owner.user.id,
  subject: 'Sender selection',
  body: 'Hello',
  leads: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'],
  startTime: new Date(Date.now() + 60 * 60 * 1000),
  delayBetweenMs: 1000,
  hourlyLimit: 50,
  senderId,
});

describe('campaign sender selection', () => {
  it('uses the selected sender for every email in the campaign', async () => {
    const { emails } = await createCampaign(input(other.sender.id));
    enqueued.push(...emails.map((e) => e.id));

    expect(emails).toHaveLength(4);
    expect(new Set(emails.map((e) => e.senderId))).toEqual(new Set([other.sender.id]));
    const rows = await prisma.email.findMany({ where: { id: { in: emails.map((e) => e.id) } } });
    expect(rows.every((r) => r.senderId === other.sender.id)).toBe(true);
  });

  it('rejects an unknown sender without creating anything', async () => {
    const before = await prisma.campaign.count({ where: { userId: owner.user.id } });
    await expect(createCampaign(input(crypto.randomUUID()))).rejects.toMatchObject({
      status: 400,
      message: 'The selected sender does not exist.',
    });
    expect(await prisma.campaign.count({ where: { userId: owner.user.id } })).toBe(before);
  });

  it('accepts an omitted senderId (round-robin) and rejects a malformed one', () => {
    const body = {
      subject: 's',
      body: 'b',
      leads: ['a@example.com'],
      startTime: new Date().toISOString(),
      delayBetweenMs: 0,
      hourlyLimit: 1,
    };
    expect(createCampaignSchema.safeParse(body).success).toBe(true);
    expect(createCampaignSchema.safeParse({ ...body, senderId: crypto.randomUUID() }).success).toBe(
      true,
    );
    expect(createCampaignSchema.safeParse({ ...body, senderId: 'not-a-uuid' }).success).toBe(false);
  });
});
