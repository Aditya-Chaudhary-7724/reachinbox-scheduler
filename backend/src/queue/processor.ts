import { DelayedError, type Job } from 'bullmq';
import { EmailStatus, type Sender } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import {
  claimEmail,
  countPendingBefore,
  markFailed,
  markRateLimited,
  markSent,
  releaseForRetry,
  type ClaimedEmail,
} from '../services/email';
import { sendMail } from '../services/mailer';
import { syncEmailToIndex } from '../services/search';
import { formatRateLimitAlert, notifyUser } from '../services/slack';
import { logger } from '../utils/logger';
import { redis } from './connection';
import type { EmailJobData } from './queue';
import {
  claimLimitNotification,
  consumeHourlyQuota,
  effectiveHourlyLimit,
  reserveDeferralSlot,
  type QuotaDecision,
} from './rateLimiter';

export type ProcessOutcome = 'sent' | 'skipped' | 'deferred';

/** Pushes the job back into the delayed set without consuming a retry attempt. */
async function deferJob(
  job: Job<EmailJobData>,
  token: string | undefined,
  runAt: number,
): Promise<never> {
  if (!token) throw new Error('Cannot defer a job without a lock token');
  await job.moveToDelayed(runAt, token);
  throw new DelayedError();
}

/**
 * Handles a job whose email could not be claimed. Never sends; decides whether the job
 * is done (already sent/failed/missing) or should be retried later.
 */
async function handleUnclaimed(
  job: Job<EmailJobData>,
  token: string | undefined,
): Promise<ProcessOutcome> {
  const { emailId } = job.data;
  const email = await prisma.email.findUnique({
    where: { id: emailId },
    select: { status: true, scheduledAt: true, updatedAt: true },
  });

  if (!email) {
    logger.warn({ emailId }, 'Email row not found; dropping job');
    return 'skipped';
  }

  switch (email.status) {
    case EmailStatus.SENT:
    case EmailStatus.FAILED:
      // Duplicate delivery of the job (e.g. re-enqueued by reconciliation): nothing to do.
      logger.info({ emailId, status: email.status }, 'Email already finalized; skipping');
      return 'skipped';
    case EmailStatus.SENDING: {
      // Another worker holds the claim, or one crashed mid-send. Check back once the claim
      // would be considered stale; claimEmail will then allow a reclaim.
      const runAt = email.updatedAt.getTime() + env.STALE_SENDING_MS + 1000;
      logger.warn({ emailId, runAt: new Date(runAt) }, 'Email is SENDING elsewhere; deferring');
      return deferJob(job, token, runAt);
    }
    case EmailStatus.SCHEDULED:
    case EmailStatus.RATE_LIMITED:
      // Job fired before the row's scheduledAt (e.g. the row was rescheduled): wait.
      logger.info({ emailId, scheduledAt: email.scheduledAt }, 'Email not due yet; deferring');
      return deferJob(job, token, email.scheduledAt.getTime());
  }
}

/**
 * The email hit an hourly limit: give it an ordered slot in the next window with room,
 * persist the new time, alert Slack (once per sender per window) and re-delay the job.
 */
async function deferForRateLimit(
  job: Job<EmailJobData>,
  token: string | undefined,
  email: ClaimedEmail,
  sender: Sender,
  decision: Extract<QuotaDecision, { allowed: false }>,
): Promise<never> {
  const deferral = await reserveDeferralSlot(redis, decision.deniedBy, decision.limit);
  await markRateLimited(email.id, deferral.runAt);
  void syncEmailToIndex(email.id);

  logger.info(
    {
      emailId: email.id,
      deniedBy: decision.deniedBy.kind,
      sender: sender.email,
      limit: decision.limit,
      runAt: deferral.runAt,
      slot: deferral.slot,
    },
    'Hourly limit reached; email deferred',
  );

  if (await claimLimitNotification(redis, email.userId, decision.deniedBy, decision.window)) {
    const isSender = decision.deniedBy.kind === 'sender';
    const deferredCount = await countPendingBefore(
      email.userId,
      isSender ? sender.id : undefined,
      decision.window.end,
    );
    const delivered = await notifyUser(
      email.userId,
      formatRateLimitAlert({
        scope: isSender ? sender.email : 'all senders (global limit)',
        limit: decision.limit,
        windowStart: decision.window.start,
        windowEnd: decision.window.end,
        // The email being deferred right now is no longer counted as pending.
        deferredCount: deferredCount + 1,
        nextWindowAt: decision.window.end,
      }),
    );
    logger.info({ userId: email.userId, delivered }, 'Rate-limit Slack notification processed');
  }

  return deferJob(job, token, deferral.runAt.getTime());
}

function isFinalAttempt(job: Job<EmailJobData>): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

export async function processEmailJob(
  job: Job<EmailJobData>,
  token?: string,
): Promise<ProcessOutcome> {
  const { emailId } = job.data;

  // 1. Atomic claim in Postgres: the only gate that allows a send.
  const email = await claimEmail(emailId);
  if (!email) return handleUnclaimed(job, token);
  void syncEmailToIndex(email.id);

  const [sender, campaign] = await Promise.all([
    prisma.sender.findUniqueOrThrow({ where: { id: email.senderId } }),
    prisma.campaign.findUniqueOrThrow({
      where: { id: email.campaignId },
      select: { hourlyLimit: true },
    }),
  ]);

  // 2. Hourly quota (Redis Lua, shared by all workers). Denied → defer, never drop.
  const decision = await consumeHourlyQuota(redis, {
    senderId: sender.id,
    senderLimit: effectiveHourlyLimit(campaign.hourlyLimit, env.MAX_EMAILS_PER_HOUR_PER_SENDER),
    globalLimit: env.MAX_EMAILS_PER_HOUR,
  });
  if (!decision.allowed) return deferForRateLimit(job, token, email, sender, decision);

  // 3. Send. The Message-ID is derived from emailId so a rare duplicate is identifiable.
  let result;
  try {
    result = await sendMail(sender, {
      emailId: email.id,
      to: email.toAddress,
      subject: email.subject,
      body: email.body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isFinalAttempt(job)) {
      await markFailed(email.id, message);
      logger.error({ emailId, err }, 'Send failed permanently');
    } else {
      await releaseForRetry(email.id, message);
      logger.warn({ emailId, attempt: job.attemptsMade + 1, err }, 'Send failed; will retry');
    }
    void syncEmailToIndex(email.id);
    throw err;
  }

  // 4. Record success.
  await markSent(email.id, result);
  void syncEmailToIndex(email.id);
  logger.info(
    { emailId, to: email.toAddress, sender: sender.email, previewUrl: result.previewUrl },
    'Email sent',
  );
  return 'sent';
}
