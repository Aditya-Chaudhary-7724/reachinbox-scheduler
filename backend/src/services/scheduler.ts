import crypto from 'node:crypto';
import { EmailStatus } from '@prisma/client';
import { prisma } from '../db/prisma';
import { enqueueEmails } from '../queue/queue';
import { indexCampaignEmails } from './search';
import { AppError, badRequest } from '../utils/errors';
import { logger } from '../utils/logger';
import { assignRoundRobin, computeScheduledTimes } from '../utils/schedule';

export interface CreateCampaignInput {
  userId: string;
  subject: string;
  body: string;
  leads: string[]; // already normalized + de-duplicated
  startTime: Date;
  delayBetweenMs: number;
  hourlyLimit: number;
  /** When set, every email uses this sender; otherwise senders are assigned round-robin. */
  senderId?: string;
}

export async function createCampaign(input: CreateCampaignInput) {
  const senders = await prisma.sender.findMany({
    where: input.senderId ? { id: input.senderId } : undefined,
    orderBy: { createdAt: 'asc' },
  });
  if (input.senderId && senders.length === 0) {
    throw badRequest('The selected sender does not exist.');
  }
  if (senders.length === 0) {
    throw badRequest('No senders configured. Run `npm run seed` in the backend.');
  }

  // A start time in the past means "send now".
  const startTime = new Date(Math.max(input.startTime.getTime(), Date.now()));
  const times = computeScheduledTimes(startTime, input.leads.length, input.delayBetweenMs);
  const campaignId = crypto.randomUUID();

  const emails = input.leads.map((toAddress, i) => {
    const scheduledAt = times[i] as Date;
    return {
      id: crypto.randomUUID(),
      campaignId,
      userId: input.userId,
      senderId: assignRoundRobin(senders, i).id,
      toAddress,
      subject: input.subject,
      body: input.body,
      scheduledAt,
      originalScheduledAt: scheduledAt,
      status: EmailStatus.SCHEDULED,
    };
  });

  // Campaign + all emails commit atomically; jobs are only enqueued after commit, so a
  // worker can never pick up a job whose row does not exist yet.
  const campaign = await prisma.$transaction(
    async (tx) => {
      const created = await tx.campaign.create({
        data: {
          id: campaignId,
          userId: input.userId,
          subject: input.subject,
          body: input.body,
          startTime,
          delayBetweenMs: input.delayBetweenMs,
          hourlyLimit: input.hourlyLimit,
          totalEmails: emails.length,
        },
      });
      await tx.email.createMany({ data: emails });
      return created;
    },
    { timeout: 60_000 },
  );

  try {
    await enqueueEmails(emails);
  } catch (err) {
    // Rows are durable; boot reconciliation will enqueue them once Redis is reachable.
    logger.error({ err, campaignId }, 'Campaign saved but enqueueing failed');
    throw new AppError(
      503,
      'Campaign saved but could not be queued. It will be queued automatically when the worker restarts.',
      'QUEUE_UNAVAILABLE',
    );
  }

  // Search indexing is best-effort and must not delay or fail the request.
  void indexCampaignEmails(campaignId);

  logger.info({ campaignId, emails: emails.length }, 'Campaign scheduled');
  return { campaign, emails };
}
