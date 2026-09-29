import crypto from 'node:crypto';
import http from 'node:http';
import { EmailStatus } from '@prisma/client';
import { prisma } from '../src/db/prisma';

export const uid = () => crypto.randomUUID().slice(0, 8);

/** A user, a sender and a campaign with fresh ids, so Redis counters never collide between runs. */
export async function createFixtures(hourlyLimit = 100) {
  const user = await prisma.user.create({
    data: { googleId: `test-${uid()}`, email: `user-${uid()}@test.dev`, name: 'Test User' },
  });
  const sender = await prisma.sender.create({
    data: {
      name: 'Test Sender',
      email: `sender-${uid()}@test.dev`,
      smtpHost: 'localhost',
      smtpPort: 587,
      smtpUser: 'u',
      smtpPass: 'p',
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      subject: 'Quarterly update',
      body: 'Hello there',
      startTime: new Date(),
      delayBetweenMs: 0,
      hourlyLimit,
      totalEmails: 0,
    },
  });

  const createEmail = (
    overrides: Partial<{
      toAddress: string;
      subject: string;
      body: string;
      status: EmailStatus;
      scheduledAt: Date;
    }> = {},
  ) => {
    const scheduledAt = overrides.scheduledAt ?? new Date(Date.now() - 1000);
    return prisma.email.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        senderId: sender.id,
        toAddress: overrides.toAddress ?? `lead-${uid()}@example.com`,
        subject: overrides.subject ?? campaign.subject,
        body: overrides.body ?? campaign.body,
        scheduledAt,
        originalScheduledAt: scheduledAt,
        status: overrides.status ?? EmailStatus.SCHEDULED,
      },
    });
  };

  const cleanup = async () => {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.sender.delete({ where: { id: sender.id } });
  };

  return { user, sender, campaign, createEmail, cleanup };
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

/**
 * A real HTTP server standing in for slack.com: answers oauth.v2.access and records what
 * is POSTed to the incoming-webhook path. Webhook status can be changed per test.
 */
export async function startSlackStub(port = 4599) {
  const requests: RecordedRequest[] = [];
  const state = { webhookStatus: 200 };
  const webhookUrl = `http://127.0.0.1:${port}/hooks/T123/B456/secret`;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const path = req.url ?? '';
      requests.push({ method: req.method ?? '', path, body });
      if (path === '/api/oauth.v2.access') {
        const params = new URLSearchParams(body);
        const ok = params.get('code') === 'good-code';
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            ok
              ? {
                  ok: true,
                  team: { id: 'T123', name: 'Acme Workspace' },
                  incoming_webhook: { url: webhookUrl, channel: '#alerts' },
                }
              : { ok: false, error: 'invalid_code' },
          ),
        );
        return;
      }
      if (path.startsWith('/hooks/')) {
        res.statusCode = state.webhookStatus;
        res.end(state.webhookStatus === 200 ? 'ok' : 'invalid_token');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    requests,
    state,
    webhookUrl,
    webhookPosts: () => requests.filter((r) => r.path.startsWith('/hooks/')),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
