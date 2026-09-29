import { Router } from 'express';
import { prisma } from '../db/prisma';
import { redis } from '../queue/connection';
import { esClient } from '../services/search';

export const healthRouter = Router();

async function check(fn: () => Promise<unknown>): Promise<'ok' | 'down'> {
  try {
    await fn();
    return 'ok';
  } catch {
    return 'down';
  }
}

healthRouter.get('/health', async (_req, res) => {
  const [postgres, redisStatus, elasticsearch] = await Promise.all([
    check(() => prisma.$queryRaw`SELECT 1`),
    check(() => redis.ping()),
    check(() => esClient.ping()),
  ]);
  const services = { postgres, redis: redisStatus, elasticsearch };
  const ok = Object.values(services).every((s) => s === 'ok');
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', services });
});
