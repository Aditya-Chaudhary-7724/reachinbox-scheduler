import type { Request } from 'express';
import { prisma } from '../db/prisma';
import { SESSION_COOKIE, verifyToken } from '../services/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { unauthorized } from '../utils/errors';

/**
 * Browsers authenticate with the httpOnly session cookie. A `Bearer` header carrying
 * the same session JWT is also accepted, which keeps curl/.http testing simple.
 */
function extractToken(req: Request): string | undefined {
  const cookie: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof cookie === 'string' && cookie) return cookie;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  return undefined;
}

export const requireAuth = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw unauthorized();
  const userId = verifyToken(token, 'session');
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw unauthorized('User no longer exists');
  req.user = user;
  next();
});

/** Narrowing helper for handlers mounted behind requireAuth. */
export function currentUser(req: Request) {
  if (!req.user) throw unauthorized();
  return req.user;
}
