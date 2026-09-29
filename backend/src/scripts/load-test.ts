/**
 * Load test: schedules a large campaign whose leads are all due at (almost) the same
 * moment, with a low hourly limit, to demonstrate deferral into later hour windows.
 *
 * Run the worker in mock mode first, so nothing touches Ethereal:
 *   MOCK_SMTP=true MIN_SEND_INTERVAL_MS=50 npm run dev:worker
 *
 *   npm run load-test -- --count 1200 --hourly-limit 50 --watch
 *   npm run load-test -- --cleanup          # delete load-test data and its queued jobs
 *
 * Progress is observed by re-reading Postgres every few seconds; that is reporting only,
 * all scheduling is done by BullMQ delayed jobs.
 */
import { parseArgs } from 'node:util';
import { EmailStatus } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { redis } from '../queue/connection';
import { emailQueue } from '../queue/queue';
import { effectiveHourlyLimit, hourWindowAt } from '../queue/rateLimiter';
import { esClient } from '../services/search';
import { createCampaign } from '../services/scheduler';

const LOAD_TEST_GOOGLE_ID = 'loadtest:reachinbox';
const out = (line = '') => process.stdout.write(`${line}\n`);

const { values: args } = parseArgs({
  options: {
    count: { type: 'string', default: '1200' },
    'hourly-limit': { type: 'string', default: '50' },
    'start-in': { type: 'string', default: '5' }, // seconds
    'delay-ms': { type: 'string', default: '0' },
    watch: { type: 'boolean', default: false },
    'watch-timeout': { type: 'string', default: '900' }, // seconds
    cleanup: { type: 'boolean', default: false },
  },
});

async function loadTestUser() {
  return prisma.user.upsert({
    where: { googleId: LOAD_TEST_GOOGLE_ID },
    update: {},
    create: {
      googleId: LOAD_TEST_GOOGLE_ID,
      email: 'loadtest@reachinbox.local',
      name: 'Load Test',
    },
  });
}

async function cleanup() {
  const user = await loadTestUser();
  const ids = await prisma.email.findMany({ where: { userId: user.id }, select: { id: true } });
  let removed = 0;
  for (const { id } of ids) {
    const job = await emailQueue.getJob(id);
    if (job) {
      await job.remove();
      removed++;
    }
  }
  await esClient
    .deleteByQuery({
      index: env.ELASTICSEARCH_INDEX,
      query: { term: { userId: user.id } },
      refresh: true,
    })
    .catch(() => undefined);
  await prisma.user.delete({ where: { id: user.id } }); // cascades campaigns + emails
  out(`Removed ${ids.length} load-test emails and ${removed} queued jobs.`);
}

async function report(userId: string, campaignId: string, limit: number) {
  const byStatus = await prisma.email.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { _all: true },
  });
  const counts = Object.fromEntries(byStatus.map((g) => [g.status, g._count._all]));

  // Invariant 1: no sender exceeded its effective limit in any UTC hour.
  const perSenderHour = await prisma.$queryRaw<
    { email: string; hour: Date; sent: bigint }[]
  >`SELECT s.email, date_trunc('hour', e."sentAt") AS hour, COUNT(*) AS sent
    FROM "Email" e JOIN "Sender" s ON s.id = e."senderId"
    WHERE e."userId" = ${userId} AND e.status = 'SENT'
    GROUP BY 1, 2 ORDER BY 2, 1`;

  // Where deferred emails landed.
  const deferredByHour = await prisma.$queryRaw<{ hour: Date; emails: bigint }[]>`
    SELECT date_trunc('hour', "scheduledAt") AS hour, COUNT(*) AS emails
    FROM "Email" WHERE "campaignId" = ${campaignId} AND status = 'RATE_LIMITED'
    GROUP BY 1 ORDER BY 1`;

  // Invariant 2: every SENT email was claimed exactly once.
  const [dupes] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM "Email" WHERE "campaignId" = ${campaignId} AND status = 'SENT' AND attempts <> 1`;

  return { counts, perSenderHour, deferredByHour, reclaimed: Number(dupes?.n ?? 0), limit };
}

function printReport(r: Awaited<ReturnType<typeof report>>) {
  out(`Status counts: ${JSON.stringify(r.counts)}`);
  out('Sent per sender per UTC hour:');
  for (const row of r.perSenderHour) {
    const flag = Number(row.sent) > r.limit ? '  <-- OVER LIMIT' : '';
    out(`  ${row.hour.toISOString().slice(0, 13)}:00  ${row.email}  ${row.sent}${flag}`);
  }
  out('Deferred (RATE_LIMITED) emails by target hour:');
  for (const row of r.deferredByHour) {
    out(`  ${row.hour.toISOString().slice(0, 13)}:00  ${row.emails}`);
  }
  out(`Sent emails with attempts != 1: ${r.reclaimed}`);
}

async function main() {
  if (args.cleanup) return cleanup();

  const count = Number(args.count);
  const hourlyLimit = Number(args['hourly-limit']);
  const user = await loadTestUser();
  const senders = await prisma.sender.count();
  const limit = effectiveHourlyLimit(hourlyLimit, env.MAX_EMAILS_PER_HOUR_PER_SENDER);
  const perHour = Math.min(senders * limit, env.MAX_EMAILS_PER_HOUR ?? Infinity);

  const leads = Array.from({ length: count }, (_, i) => `lead${i + 1}@loadtest.example`);
  const startTime = new Date(Date.now() + Number(args['start-in']) * 1000);
  const { campaign } = await createCampaign({
    userId: user.id,
    subject: `Load test ${new Date().toISOString()}`,
    body: 'Load test email body.',
    leads,
    startTime,
    delayBetweenMs: Number(args['delay-ms']),
    hourlyLimit,
  });

  const window = hourWindowAt(Date.now());
  out(`Campaign ${campaign.id}: ${count} emails due at ${startTime.toISOString()}`);
  out(
    `Senders: ${senders} x ${limit}/hour = ${perHour}/hour capacity. ` +
      `Expect <= ${perHour} sent before ${window.end.toISOString()} (less if senders already sent this hour), ` +
      `the rest deferred across ~${Math.ceil(count / perHour) - 1} later hour window(s).`,
  );
  out('Make sure a worker is running (MOCK_SMTP=true recommended).');

  if (!args.watch) return;

  const deadline = Date.now() + Number(args['watch-timeout']) * 1000;
  let last = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    // Done once nothing is due-but-unprocessed: every email is SENT/FAILED or waiting for a future slot.
    const outstanding = await prisma.email.count({
      where: {
        campaignId: campaign.id,
        OR: [
          { status: { in: [EmailStatus.SCHEDULED, EmailStatus.SENDING] } },
          { status: EmailStatus.RATE_LIMITED, scheduledAt: { lte: new Date() } },
        ],
      },
    });
    const r = await report(user.id, campaign.id, limit);
    const line = JSON.stringify(r.counts);
    if (line !== last) out(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    last = line;
    if (outstanding === 0 || Date.now() > deadline) {
      out();
      printReport(r);
      break;
    }
  }
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(
    () =>
      void Promise.allSettled([
        emailQueue.close(),
        redis.quit(),
        prisma.$disconnect(),
        esClient.close(),
      ]),
  );
