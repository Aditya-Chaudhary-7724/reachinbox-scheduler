import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, sessionCookieOptions } from '../src/services/auth';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe('sessionCookieOptions', () => {
  it('keeps SameSite=Lax without Secure outside production (localhost development)', () => {
    for (const nodeEnv of ['development', 'test'] as const) {
      expect(sessionCookieOptions(nodeEnv)).toEqual({
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/',
        maxAge: SEVEN_DAYS_MS,
      });
    }
  });

  it('uses SameSite=None + Secure in production for cross-site dashboard requests', () => {
    expect(sessionCookieOptions('production')).toEqual({
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
      maxAge: SEVEN_DAYS_MS,
    });
  });

  it('defaults to the configured NODE_ENV and never sets a Domain attribute', () => {
    expect(sessionCookieOptions()).toEqual(sessionCookieOptions('test'));
    expect(sessionCookieOptions('production')).not.toHaveProperty('domain');
  });
});

/** Set-Cookie headers produced by Express for login (set) and logout (clear) with these options. */
async function setCookieHeaders(nodeEnv: 'development' | 'production') {
  const app = express();
  app.get('/login', (_req, res) => {
    res.cookie(SESSION_COOKIE, 'token', sessionCookieOptions(nodeEnv));
    res.end();
  });
  app.get('/logout', (_req, res) => {
    const { maxAge: _maxAge, ...options } = sessionCookieOptions(nodeEnv);
    res.clearCookie(SESSION_COOKIE, options);
    res.end();
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = (await fetch(`${base}/login`)).headers.get('set-cookie') ?? '';
    const logout = (await fetch(`${base}/logout`)).headers.get('set-cookie') ?? '';
    return { login, logout };
  } finally {
    server.close();
  }
}

describe('Set-Cookie header sent to the browser', () => {
  it('production: SameSite=None; Secure; HttpOnly on both login and logout, no Domain', async () => {
    const { login, logout } = await setCookieHeaders('production');
    for (const header of [login, logout]) {
      expect(header).toMatch(/^session=/);
      expect(header).toContain('SameSite=None');
      expect(header).toContain('Secure');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('Path=/');
      expect(header).not.toMatch(/Domain=/i);
    }
    expect(login).toContain('Max-Age=604800');
  });

  it('development: SameSite=Lax without Secure, as before', async () => {
    const { login, logout } = await setCookieHeaders('development');
    for (const header of [login, logout]) {
      expect(header).toContain('SameSite=Lax');
      expect(header).not.toContain('Secure');
      expect(header).toContain('HttpOnly');
      expect(header).not.toMatch(/Domain=/i);
    }
  });
});
