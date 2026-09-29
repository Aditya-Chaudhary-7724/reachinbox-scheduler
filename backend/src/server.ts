import { env } from './config/env';
import { createApp } from './app';
import { prisma } from './db/prisma';
import { redis } from './queue/connection';
import { emailQueue } from './queue/queue';
import { reconcilePendingEmails } from './queue/reconcile';
import { ensureSearchIndex } from './services/search';
import { logger } from './utils/logger';

async function main() {
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT}`);
  });

  ensureSearchIndex().catch((err: unknown) =>
    logger.error({ err }, 'Could not ensure Elasticsearch index; search is unavailable'),
  );

  // Runs once at boot; the Redis lock makes it a no-op if the worker is already doing it.
  reconcilePendingEmails().catch((err: unknown) =>
    logger.error({ err }, 'Boot reconciliation failed'),
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down API');
    server.close();
    await Promise.allSettled([emailQueue.close(), prisma.$disconnect(), redis.quit()]);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'API failed to start');
  process.exit(1);
});
