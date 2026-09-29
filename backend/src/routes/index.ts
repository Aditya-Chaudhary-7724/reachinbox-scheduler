import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { campaignsRouter } from './campaigns';
import { emailsRouter } from './emails';
import { metaRouter } from './meta';
import { slackCallbackRouter, slackRouter } from './slack';

/** Everything under /api requires an authenticated user, except the Slack OAuth callback. */
export const apiRouter = Router();
// The Slack OAuth callback authenticates via its signed state, not the session cookie.
apiRouter.use('/slack', slackCallbackRouter);
apiRouter.use(requireAuth);
apiRouter.use('/campaigns', campaignsRouter);
apiRouter.use('/emails', emailsRouter);
apiRouter.use(metaRouter);
apiRouter.use('/slack', slackRouter);
