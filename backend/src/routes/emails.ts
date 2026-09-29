import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../middleware/auth';
import { listEmails } from '../services/email';
import { searchEmails } from '../services/search';
import { asyncHandler } from '../utils/asyncHandler';

export const emailsRouter = Router();

const listQuerySchema = z.object({
  status: z.enum(['scheduled', 'sent']).default('scheduled'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

emailsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = listQuerySchema.parse(req.query);
    res.json(await listEmails(user.id, query.status, query.page, query.limit));
  }),
);

const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'q is required').max(200),
  status: z.enum(['scheduled', 'sent']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

emailsRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = searchQuerySchema.parse(req.query);
    res.json(await searchEmails({ userId: user.id, ...query }));
  }),
);
