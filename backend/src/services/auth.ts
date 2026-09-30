import type { CookieOptions } from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import type { User } from '@prisma/client';
import { env, type Env } from '../config/env';
import { prisma } from '../db/prisma';
import { serviceUnavailable, unauthorized } from '../utils/errors';

export const SESSION_COOKIE = 'session';
export const OAUTH_STATE_COOKIE = 'oauth_state';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

type TokenType = 'session' | 'slack_state';

interface TokenPayload {
  sub: string;
  typ: TokenType;
}

/** Signs a JWT whose `typ` claim prevents one kind of token being replayed as another. */
export function signToken(userId: string, typ: TokenType, expiresInSeconds: number): string {
  const payload: TokenPayload = { sub: userId, typ };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: expiresInSeconds });
}

export function verifyToken(token: string, typ: TokenType): string {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'object' && decoded.typ === typ && typeof decoded.sub === 'string') {
      return decoded.sub;
    }
  } catch {
    // fall through
  }
  throw unauthorized('Invalid or expired token');
}

export function signSessionToken(userId: string): string {
  return signToken(userId, 'session', SESSION_TTL_SECONDS);
}

/**
 * In production the dashboard and API live on different sites (separate *.up.railway.app
 * domains), so the session cookie must be SameSite=None to be sent on the dashboard's
 * credentialed requests; browsers only accept SameSite=None together with Secure.
 * Local development keeps SameSite=Lax over plain http://localhost.
 */
export function sessionCookieOptions(nodeEnv: Env['NODE_ENV'] = env.NODE_ENV): CookieOptions {
  const production = nodeEnv === 'production';
  return {
    httpOnly: true,
    sameSite: production ? 'none' : 'lax',
    secure: production,
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}

function googleClient(): OAuth2Client {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw serviceUnavailable('Google OAuth is not configured (GOOGLE_CLIENT_ID/SECRET)');
  }
  return new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CALLBACK_URL);
}

export function buildGoogleAuthUrl(state: string): string {
  return googleClient().generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
    state,
  });
}

/** Exchanges the authorization code, verifies the ID token and upserts the user. */
export async function completeGoogleLogin(code: string): Promise<User> {
  const client = googleClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw unauthorized('Google did not return an ID token');

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });
  const profile = ticket.getPayload();
  if (!profile?.sub || !profile.email || profile.email_verified === false) {
    throw unauthorized('Google account has no verified email');
  }

  const data = {
    email: profile.email.toLowerCase(),
    name: profile.name ?? profile.email,
    avatarUrl: profile.picture ?? null,
  };
  return prisma.user.upsert({
    where: { googleId: profile.sub },
    update: data,
    create: { googleId: profile.sub, ...data },
  });
}
