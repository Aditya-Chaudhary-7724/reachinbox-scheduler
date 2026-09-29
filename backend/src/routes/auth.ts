import crypto from 'node:crypto';
import { Router } from 'express';
import { env } from '../config/env';
import { currentUser, requireAuth } from '../middleware/auth';
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  buildGoogleAuthUrl,
  completeGoogleLogin,
  sessionCookieOptions,
  signSessionToken,
} from '../services/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../utils/logger';

export const authRouter = Router();

const STATE_TTL_MS = 10 * 60 * 1000;

authRouter.get('/google', (_req, res) => {
  // CSRF protection: random state stored in a short-lived cookie and echoed back by Google.
  const state = crypto.randomBytes(24).toString('hex');
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: STATE_TTL_MS,
    path: '/auth/google',
  });
  res.redirect(buildGoogleAuthUrl(state));
});

authRouter.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    const failRedirect = (reason: string) => {
      res.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth/google' });
      res.redirect(`${env.FRONTEND_URL}/login?error=${encodeURIComponent(reason)}`);
    };

    const { code, state, error } = req.query;
    const expectedState: unknown = req.cookies?.[OAUTH_STATE_COOKIE];
    if (typeof error === 'string') return failRedirect(error);
    if (typeof code !== 'string' || typeof state !== 'string') return failRedirect('missing_code');
    if (typeof expectedState !== 'string' || expectedState !== state) {
      return failRedirect('invalid_state');
    }

    try {
      const user = await completeGoogleLogin(code);
      res.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth/google' });
      res.cookie(SESSION_COOKIE, signSessionToken(user.id), sessionCookieOptions());
      logger.info({ userId: user.id }, 'User signed in with Google');
      res.redirect(`${env.FRONTEND_URL}/dashboard`);
    } catch (err) {
      logger.warn({ err }, 'Google OAuth callback failed');
      failRedirect('oauth_failed');
    }
  }),
);

authRouter.get('/me', requireAuth, (req, res) => {
  const user = currentUser(req);
  res.json({ id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl });
});

authRouter.post('/logout', (_req, res) => {
  const { maxAge: _maxAge, ...cookieOptions } = sessionCookieOptions();
  res.clearCookie(SESSION_COOKIE, cookieOptions);
  res.status(204).end();
});
