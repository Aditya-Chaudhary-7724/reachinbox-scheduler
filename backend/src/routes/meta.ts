import { Router } from 'express';
import { prisma } from '../db/prisma';
import { currentUser } from '../middleware/auth';
import { getStats } from '../services/email';
import { asyncHandler } from '../utils/asyncHandler';

/** Small read-only endpoints: senders and per-status counts. */
export const metaRouter = Router();

metaRouter.get(
  '/senders',
  asyncHandler(async (_req, res) => {
    const senders = await prisma.sender.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, email: true },
    });
    res.json({ items: senders });
  }),
);

metaRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const byStatus = await getStats(user.id);
    res.json({
      byStatus,
      scheduled: byStatus.SCHEDULED + byStatus.SENDING + byStatus.RATE_LIMITED,
      sent: byStatus.SENT + byStatus.FAILED,
    });
  }),
);
