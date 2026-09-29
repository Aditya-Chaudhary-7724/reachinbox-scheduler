import { Router } from 'express';
import { env } from '../config/env';
import { currentUser } from '../middleware/auth';
import {
  buildSlackAuthorizeUrl,
  completeSlackOAuth,
  disconnectSlack,
  getSlackStatus,
  sendTestMessage,
} from '../services/slack';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../utils/logger';

/** Authenticated Slack endpoints (mounted under /api/slack, behind requireAuth). */
export const slackRouter = Router();

/**
 * Browsers navigate here directly (the session cookie is sent on top-level GETs) and are
 * redirected to Slack. `?redirect=false` returns the URL as JSON instead.
 */
slackRouter.get('/connect', (req, res) => {
  const url = buildSlackAuthorizeUrl(currentUser(req).id);
  if (req.query.redirect === 'false') {
    res.json({ url });
    return;
  }
  res.redirect(url);
});

slackRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    res.json(await getSlackStatus(currentUser(req).id));
  }),
);

slackRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    await disconnectSlack(currentUser(req).id);
    res.status(204).end();
  }),
);

slackRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    await sendTestMessage(user.id, user.name);
    res.json({ ok: true });
  }),
);

/**
 * Public OAuth callback (mounted before requireAuth). It is reached via the HTTPS tunnel
 * host, where the dashboard cookie is absent; the signed `state` identifies the user.
 */
export const slackCallbackRouter = Router();

slackCallbackRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error } = req.query;
    const done = (result: string) =>
      res.redirect(`${env.FRONTEND_URL}/dashboard?slack=${encodeURIComponent(result)}`);

    if (typeof error === 'string') return done(error === 'access_denied' ? 'denied' : 'error');
    if (typeof code !== 'string' || typeof state !== 'string') return done('error');

    try {
      const conn = await completeSlackOAuth(code, state);
      logger.info({ userId: conn.userId, team: conn.teamName }, 'Slack connected');
      done('connected');
    } catch (err) {
      logger.warn({ err }, 'Slack OAuth callback failed');
      done('error');
    }
  }),
);
