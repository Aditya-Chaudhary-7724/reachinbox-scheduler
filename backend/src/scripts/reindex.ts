/** Rebuilds the Elasticsearch index from Postgres (the source of truth). */
import { prisma } from '../db/prisma';
import { esClient, indexEmails, recreateSearchIndex } from '../services/search';
import { logger } from '../utils/logger';

const BATCH_SIZE = 500;

async function main() {
  await recreateSearchIndex();
  let cursor: string | undefined;
  let total = 0;
  for (;;) {
    const batch = await prisma.email.findMany({
      include: { sender: { select: { email: true } } },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (batch.length === 0) break;
    await indexEmails(batch);
    total += batch.length;
    cursor = batch[batch.length - 1]?.id;
  }
  logger.info({ total }, 'Reindex complete');
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'Reindex failed');
    process.exitCode = 1;
  })
  .finally(() => void Promise.allSettled([prisma.$disconnect(), esClient.close()]));
