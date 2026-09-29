import { z } from 'zod';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { decrypt, encrypt } from '../utils/crypto';
import { badRequest, serviceUnavailable } from '../utils/errors';
import { logger } from '../utils/logger';
import { signToken, verifyToken } from './auth';

const STATE_TTL_SECONDS = 10 * 60;
const HTTP_TIMEOUT_MS = 5000;

function slackConfig() {
  const { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_REDIRECT_URI, SLACK_TOKEN_ENC_KEY } = env;
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET || !SLACK_REDIRECT_URI || !SLACK_TOKEN_ENC_KEY) {
    throw serviceUnavailable(
      'Slack is not configured (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_REDIRECT_URI, SLACK_TOKEN_ENC_KEY)',
    );
  }
  return {
    clientId: SLACK_CLIENT_ID,
    clientSecret: SLACK_CLIENT_SECRET,
    redirectUri: SLACK_REDIRECT_URI,
    encKey: SLACK_TOKEN_ENC_KEY,
  };
}

function encryptionKey(): string {
  if (!env.SLACK_TOKEN_ENC_KEY) throw serviceUnavailable('SLACK_TOKEN_ENC_KEY is not set');
  return env.SLACK_TOKEN_ENC_KEY;
}

/**
 * The callback arrives on the public (ngrok) host where the dashboard's session cookie is
 * not present, so the user is identified by a signed, short-lived state token instead.
 */
export function buildSlackAuthorizeUrl(userId: string): string {
  const { clientId, redirectUri } = slackConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'incoming-webhook',
    redirect_uri: redirectUri,
    state: signToken(userId, 'slack_state', STATE_TTL_SECONDS),
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

const oauthAccessSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    team: z.object({ id: z.string(), name: z.string() }),
    incoming_webhook: z.object({ url: z.string().url(), channel: z.string() }),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/** Verifies state, exchanges the code (oauth.v2.access) and stores the encrypted webhook. */
export async function completeSlackOAuth(code: string, state: string) {
  const { clientId, clientSecret, redirectUri, encKey } = slackConfig();
  const userId = verifyToken(state, 'slack_state');

  const response = await fetch(`${env.SLACK_API_URL}/oauth.v2.access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const parsed = oauthAccessSchema.safeParse(await response.json());
  if (!parsed.success) throw badRequest('Unexpected response from Slack');
  if (!parsed.data.ok) throw badRequest(`Slack OAuth failed: ${parsed.data.error}`);

  const { team, incoming_webhook: hook } = parsed.data;
  const data = {
    teamId: team.id,
    teamName: team.name,
    channel: hook.channel,
    webhookUrl: encrypt(hook.url, encKey),
  };
  return prisma.slackConnection.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
}

export async function getSlackStatus(userId: string) {
  const conn = await prisma.slackConnection.findUnique({ where: { userId } });
  return conn
    ? { connected: true as const, teamName: conn.teamName, channel: conn.channel }
    : { connected: false as const, teamName: null, channel: null };
}

export async function disconnectSlack(userId: string): Promise<void> {
  await prisma.slackConnection.deleteMany({ where: { userId } });
}

interface SlackMessage {
  text: string;
  blocks?: unknown[];
}

async function postToWebhook(webhookUrl: string, message: SlackMessage): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Slack webhook responded ${response.status}: ${await response.text()}`);
  }
}

/**
 * Looks the connection up at send time, so connecting Slack later needs no restart.
 * Returns false (and never throws) when there is no connection or delivery fails.
 */
export async function notifyUser(userId: string, message: SlackMessage): Promise<boolean> {
  try {
    const conn = await prisma.slackConnection.findUnique({ where: { userId } });
    if (!conn) return false;
    await postToWebhook(decrypt(conn.webhookUrl, encryptionKey()), message);
    return true;
  } catch (err) {
    logger.warn({ err, userId }, 'Slack notification failed');
    return false;
  }
}

/** Like notifyUser, but surfaces errors so the test endpoint can report them. */
export async function sendTestMessage(userId: string, userName: string): Promise<void> {
  const conn = await prisma.slackConnection.findUnique({ where: { userId } });
  if (!conn) throw badRequest('Slack is not connected');
  await postToWebhook(decrypt(conn.webhookUrl, encryptionKey()), {
    text: `:wave: Test notification from ReachInbox Scheduler for ${userName}. Rate-limit alerts will appear in this channel.`,
  });
}

export interface RateLimitAlert {
  scope: string; // sender email, or "all senders (global limit)"
  limit: number;
  windowStart: Date;
  windowEnd: Date;
  deferredCount: number;
  nextWindowAt: Date;
}

export function formatRateLimitAlert(a: RateLimitAlert): SlackMessage {
  const hhmm = (d: Date) => d.toISOString().slice(11, 16);
  const text =
    `:warning: Hourly send limit reached for ${a.scope}: ${a.limit} emails/hour ` +
    `(window ${hhmm(a.windowStart)}–${hhmm(a.windowEnd)} UTC). ` +
    `${a.deferredCount} email(s) deferred; sending resumes at ${a.nextWindowAt.toISOString()}.`;
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Hourly send limit reached' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Sender:*\n${a.scope}` },
          { type: 'mrkdwn', text: `*Limit:*\n${a.limit} / hour` },
          {
            type: 'mrkdwn',
            text: `*Window (UTC):*\n${hhmm(a.windowStart)}–${hhmm(a.windowEnd)}`,
          },
          { type: 'mrkdwn', text: `*Deferred:*\n${a.deferredCount} email(s)` },
          {
            type: 'mrkdwn',
            text: `*Next window:*\n<!date^${Math.floor(a.nextWindowAt.getTime() / 1000)}^{date_short_pretty} {time}|${a.nextWindowAt.toISOString()}>`,
          },
        ],
      },
    ],
  };
}
