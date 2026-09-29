import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Router } from 'express';
import basicAuth from 'express-basic-auth';
import { env } from '../config/env';
import { emailQueue } from '../queue/queue';

export const BULL_BOARD_PATH = '/admin/queues';

export function createBullBoardRouter(): Router {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);
  createBullBoard({ queues: [new BullMQAdapter(emailQueue)], serverAdapter });

  const router = Router();
  router.use(
    basicAuth({
      users: { [env.BULL_BOARD_USER]: env.BULL_BOARD_PASS },
      challenge: true,
      realm: 'bull-board',
    }),
  );
  router.use(serverAdapter.getRouter());
  return router;
}
