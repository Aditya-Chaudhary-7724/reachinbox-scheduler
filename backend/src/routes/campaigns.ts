import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { createCampaign } from '../services/scheduler';
import { asyncHandler } from '../utils/asyncHandler';
import { normalizeLeads } from '../utils/emails';
import { badRequest } from '../utils/errors';

export const campaignsRouter = Router();

const MAX_LEADS = 10_000;

export const createCampaignSchema = z.object({
  subject: z.string().trim().min(1, 'Subject is required').max(998),
  body: z.string().trim().min(1, 'Body is required').max(100_000),
  leads: z.array(z.string()).min(1, 'At least one lead is required').max(MAX_LEADS),
  startTime: z.string().datetime({ offset: true }),
  delayBetweenMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1000),
  hourlyLimit: z.number().int().min(1).max(100_000),
  // Optional: send every email from this sender instead of round-robin across all senders.
  senderId: z.string().uuid().optional(),
});

type CreateCampaignBody = z.infer<typeof createCampaignSchema>;

campaignsRouter.post(
  '/',
  validateBody(createCampaignSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = req.body as CreateCampaignBody;

    const leads = normalizeLeads(body.leads);
    if (leads.valid.length === 0) {
      throw badRequest('No valid email addresses in leads', { invalid: leads.invalid });
    }

    const { campaign, emails } = await createCampaign({
      userId: user.id,
      subject: body.subject,
      body: body.body,
      leads: leads.valid,
      startTime: new Date(body.startTime),
      delayBetweenMs: body.delayBetweenMs,
      hourlyLimit: body.hourlyLimit,
      senderId: body.senderId,
    });

    const first = emails[0];
    const last = emails[emails.length - 1];
    res.status(201).json({
      campaign: {
        id: campaign.id,
        subject: campaign.subject,
        startTime: campaign.startTime.toISOString(),
        delayBetweenMs: campaign.delayBetweenMs,
        hourlyLimit: campaign.hourlyLimit,
        totalEmails: campaign.totalEmails,
        createdAt: campaign.createdAt.toISOString(),
      },
      scheduled: emails.length,
      invalid: leads.invalid,
      duplicatesRemoved: leads.duplicates,
      firstScheduledAt: first?.scheduledAt.toISOString() ?? null,
      lastScheduledAt: last?.scheduledAt.toISOString() ?? null,
    });
  }),
);
