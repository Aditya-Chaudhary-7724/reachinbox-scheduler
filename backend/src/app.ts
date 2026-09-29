import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authRouter } from './routes/auth';
import { BULL_BOARD_PATH, createBullBoardRouter } from './routes/bullBoard';
import { healthRouter } from './routes/health';
import { apiRouter } from './routes/index';
import { logger } from './utils/logger';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
  app.use(express.json({ limit: '5mb' }));
  app.use(cookieParser());

  app.use(healthRouter);
  app.use('/auth', authRouter);
  app.use('/api', apiRouter);
  app.use(BULL_BOARD_PATH, createBullBoardRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
