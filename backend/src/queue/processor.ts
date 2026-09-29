import { DelayedError, type Job } from 'bullmq';
import { EmailStatus } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { claimEmail, markFailed, markSent, releaseForRetry } from '../services/email';
import { sendMail } from '../services/mailer';
import { logger } from '../utils/logger';
import type { EmailJobData } from './queue';

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

  const sender = await prisma.sender.findUniqueOrThrow({ where: { id: email.senderId } });

  // 2. Send. The Message-ID is derived from emailId so a rare duplicate is identifiable.
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
    throw err;
  }

  // 3. Record success.
  await markSent(email.id, result);
  logger.info(
    { emailId, to: email.toAddress, sender: sender.email, previewUrl: result.previewUrl },
    'Email sent',
  );
  return 'sent';
}
