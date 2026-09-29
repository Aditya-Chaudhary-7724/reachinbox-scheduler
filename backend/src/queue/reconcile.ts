import { EmailStatus } from '@prisma/client';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { redis } from './connection';
import { emailQueue, enqueueEmails, type EmailToEnqueue } from './queue';

const BATCH_SIZE = 500;
const LOCK_KEY = 'reconcile:lock';
const LOCK_TTL_SECONDS = 120;

/**
 * Boot-time reconciliation (runs once per process start; not a scheduler).
 *
 * Every pending row in Postgres must have a live BullMQ job. If Redis lost data (or the
 * enqueue after a campaign commit failed), jobs are recreated with the same jobId and
 * the remaining delay. This cannot cause a double send: jobId = emailId dedupes in
 * Redis, and the atomic claim in Postgres gates every actual send.
 */
export async function reconcilePendingEmails(): Promise<{ checked: number; requeued: number }> {
  // API and worker both reconcile on boot; a short lock avoids doing the work twice.
  const acquired = await redis.set(LOCK_KEY, String(process.pid), 'EX', LOCK_TTL_SECONDS, 'NX');
  if (!acquired) {
    logger.info('Reconciliation already running in another process; skipping');
    return { checked: 0, requeued: 0 };
  }

  let checked = 0;
  let requeued = 0;
  let cursor: string | undefined;
  try {
    for (;;) {
      const rows = await prisma.email.findMany({
        where: {
          status: { in: [EmailStatus.SCHEDULED, EmailStatus.RATE_LIMITED, EmailStatus.SENDING] },
        },
        select: { id: true, scheduledAt: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]?.id;
      checked += rows.length;

      const missing = await findRowsWithoutLiveJob(rows);
      if (missing.length > 0) {
        await enqueueEmails(missing);
        requeued += missing.length;
      }
      if (rows.length < BATCH_SIZE) break;
    }
  } finally {
    await redis.del(LOCK_KEY);
  }

  logger.info({ checked, requeued }, 'Boot reconciliation complete');
  return { checked, requeued };
}

async function findRowsWithoutLiveJob(rows: EmailToEnqueue[]): Promise<EmailToEnqueue[]> {
  const results = await Promise.all(
    rows.map(async (row) => {
      const job = await emailQueue.getJob(row.id);
      if (!job) return row;
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') {
        // The job finished but the row is still pending (e.g. crash between job
        // completion and the DB write). Replace it so the email is retried.
        await job.remove();
        return row;
      }
      return null;
    }),
  );
  return results.filter((r): r is EmailToEnqueue => r !== null);
}
