import type { User } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      user?: User;
    }
  }
}

export {};
