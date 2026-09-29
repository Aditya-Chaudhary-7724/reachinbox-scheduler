import { Worker } from 'bullmq';
import { env } from './config/env';
import { prisma } from './db/prisma';
import { createRedisConnection, redis } from './queue/connection';
import { processEmailJob } from './queue/processor';
import { EMAIL_QUEUE_NAME, emailQueue, type EmailJobData } from './queue/queue';
import { reconcilePendingEmails } from './queue/reconcile';
import { closeTransporters } from './services/mailer';
import { logger } from './utils/logger';

async function main() {
  const workerConnection = createRedisConnection();

  const worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processEmailJob, {
    connection: workerConnection,
    concurrency: env.WORKER_CONCURRENCY,
    // Global (Redis-backed) limiter: at most 1 job starts per MIN_SEND_INTERVAL_MS across
    // ALL worker processes, which enforces the minimum gap between individual sends.
    limiter: { max: 1, duration: env.MIN_SEND_INTERVAL_MS },
  });

  worker.on('failed', (job, err) => {
    logger.warn(
      { jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message },
      'Job failed',
    );
  });
  worker.on('error', (err) => logger.error({ err }, 'Worker error'));

  logger.info(
    { concurrency: env.WORKER_CONCURRENCY, minSendIntervalMs: env.MIN_SEND_INTERVAL_MS },
    'Worker started',
  );

  await reconcilePendingEmails().catch((err: unknown) =>
    logger.error({ err }, 'Boot reconciliation failed'),
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down worker (waiting for active jobs)');
    await worker.close();
    closeTransporters();
    await Promise.allSettled([
      emailQueue.close(),
      workerConnection.quit(),
      redis.quit(),
      prisma.$disconnect(),
    ]);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
