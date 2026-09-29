import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { campaignsRouter } from './campaigns';
import { emailsRouter } from './emails';
import { metaRouter } from './meta';

/** Everything under /api requires an authenticated user. */
export const apiRouter = Router();
apiRouter.use(requireAuth);
apiRouter.use('/campaigns', campaignsRouter);
apiRouter.use('/emails', emailsRouter);
apiRouter.use(metaRouter);
