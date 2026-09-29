import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db/prisma';
import { redis } from '../src/queue/connection';
import { emailQueue } from '../src/queue/queue';
import { signSessionToken, signToken } from '../src/services/auth';
import {
  buildSlackAuthorizeUrl,
  completeSlackOAuth,
  getSlackStatus,
  notifyUser,
} from '../src/services/slack';
import { createFixtures, startSlackStub } from './helpers';

let stub: Awaited<ReturnType<typeof startSlackStub>>;
let fx: Awaited<ReturnType<typeof createFixtures>>;
let server: Server;
let api: string;

beforeAll(async () => {
  stub = await startSlackStub();
  fx = await createFixtures();
  server = createApp().listen(0);
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  stub.requests.length = 0;
  stub.state.webhookStatus = 200;
  await prisma.slackConnection.deleteMany({ where: { userId: fx.user.id } });
});

afterAll(async () => {
  server.close();
  await stub.close();
  await fx.cleanup();
  await emailQueue.close();
  await redis.quit();
  await prisma.$disconnect();
});

describe('Slack OAuth', () => {
  it('builds an authorize URL with the incoming-webhook scope and a signed state', () => {
    const url = new URL(buildSlackAuthorizeUrl(fx.user.id));
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('scope')).toBe('incoming-webhook');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://example.ngrok.app/api/slack/callback',
    );
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('exchanges the code and stores the webhook encrypted', async () => {
    const state = signToken(fx.user.id, 'slack_state', 600);
    await completeSlackOAuth('good-code', state);

    const exchange = stub.requests.find((r) => r.path === '/api/oauth.v2.access');
    const form = new URLSearchParams(exchange?.body);
    expect(form.get('client_id')).toBe('test-client-id');
    expect(form.get('redirect_uri')).toBe('https://example.ngrok.app/api/slack/callback');

    const row = await prisma.slackConnection.findUniqueOrThrow({ where: { userId: fx.user.id } });
    expect(row.webhookUrl).not.toContain('hooks');
    expect(await getSlackStatus(fx.user.id)).toEqual({
      connected: true,
      teamName: 'Acme Workspace',
      channel: '#alerts',
    });
  });

  it('rejects a session token used as OAuth state', async () => {
    await expect(completeSlackOAuth('good-code', signSessionToken(fx.user.id))).rejects.toThrow();
  });

  it('callback route redirects to the dashboard with the result', async () => {
    const state = signToken(fx.user.id, 'slack_state', 600);
    const ok = await fetch(`${api}/api/slack/callback?code=good-code&state=${state}`, {
      redirect: 'manual',
    });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('http://localhost:5173/dashboard?slack=connected');

    const bad = await fetch(`${api}/api/slack/callback?code=bad-code&state=${state}`, {
      redirect: 'manual',
    });
    expect(bad.headers.get('location')).toBe('http://localhost:5173/dashboard?slack=error');

    const denied = await fetch(`${api}/api/slack/callback?error=access_denied`, {
      redirect: 'manual',
    });
    expect(denied.headers.get('location')).toBe('http://localhost:5173/dashboard?slack=denied');
  });

  it('status, test message and disconnect work through the authenticated API', async () => {
    await completeSlackOAuth('good-code', signToken(fx.user.id, 'slack_state', 600));
    const auth = { Authorization: `Bearer ${signSessionToken(fx.user.id)}` };

    const test = await fetch(`${api}/api/slack/test`, { method: 'POST', headers: auth });
    expect(test.status).toBe(200);
    expect(stub.webhookPosts()).toHaveLength(1);

    const del = await fetch(`${api}/api/slack`, { method: 'DELETE', headers: auth });
    expect(del.status).toBe(204);
    const status = (await (await fetch(`${api}/api/slack/status`, { headers: auth })).json()) as {
      connected: boolean;
    };
    expect(status.connected).toBe(false);
  });
});

describe('notifyUser', () => {
  it('posts to the stored webhook', async () => {
    await completeSlackOAuth('good-code', signToken(fx.user.id, 'slack_state', 600));
    expect(await notifyUser(fx.user.id, { text: 'hello' })).toBe(true);
    const posts = stub.webhookPosts();
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? '{}')).toEqual({ text: 'hello' });
  });

  it('skips silently when Slack is not connected', async () => {
    expect(await notifyUser(fx.user.id, { text: 'hello' })).toBe(false);
    expect(stub.webhookPosts()).toHaveLength(0);
  });

  it('never throws when Slack returns an error', async () => {
    await completeSlackOAuth('good-code', signToken(fx.user.id, 'slack_state', 600));
    stub.state.webhookStatus = 404;
    await expect(notifyUser(fx.user.id, { text: 'hello' })).resolves.toBe(false);
  });
});
