import { Queue, type JobsOptions } from 'bullmq';
import { env } from '../config/env';
import { redis } from './connection';

export const EMAIL_QUEUE_NAME = 'email-send';

/** Job payload is only the id: Postgres is the source of truth for everything else. */
export interface EmailJobData {
  emailId: string;
}

const ADD_BULK_CHUNK_SIZE = 500;

export const defaultJobOptions: JobsOptions = {
  attempts: env.JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: env.JOB_BACKOFF_MS },
  removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions,
});

export interface EmailToEnqueue {
  id: string;
  scheduledAt: Date;
}

/**
 * Enqueues one delayed job per email. jobId = emailId is the idempotency key:
 * BullMQ ignores an add whose jobId already exists, so re-enqueueing is always safe.
 */
export async function enqueueEmails(emails: EmailToEnqueue[], now = Date.now()): Promise<void> {
  for (let i = 0; i < emails.length; i += ADD_BULK_CHUNK_SIZE) {
    const chunk = emails.slice(i, i + ADD_BULK_CHUNK_SIZE);
    await emailQueue.addBulk(
      chunk.map((email) => ({
        name: 'send-email',
        data: { emailId: email.id },
        opts: { jobId: email.id, delay: Math.max(0, email.scheduledAt.getTime() - now) },
      })),
    );
  }
}
