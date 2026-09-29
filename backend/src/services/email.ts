import { EmailStatus, Prisma, type Email } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../db/prisma';

/** Grace period so a job firing a few ms before its scheduledAt is still claimable. */
const DUE_TOLERANCE_MS = 1000;

export type ClaimedEmail = Pick<
  Email,
  'id' | 'campaignId' | 'userId' | 'senderId' | 'toAddress' | 'subject' | 'body' | 'attempts'
>;

/**
 * Atomically claims an email for sending. Only one caller can win: the UPDATE's
 * WHERE clause is evaluated under a row lock, so concurrent workers (or a duplicate
 * job) see 0 rows returned and must not send.
 *
 * Claimable rows are:
 *  - SCHEDULED / RATE_LIMITED rows that are due, or
 *  - SENDING rows whose last update is older than STALE_SENDING_MS (the worker that
 *    claimed them crashed mid-send). Reclaiming those is the one at-least-once edge case.
 */
export async function claimEmail(emailId: string, now = new Date()): Promise<ClaimedEmail | null> {
  const dueBy = new Date(now.getTime() + DUE_TOLERANCE_MS);
  const staleBefore = new Date(now.getTime() - env.STALE_SENDING_MS);
  const rows = await prisma.$queryRaw<ClaimedEmail[]>`
    UPDATE "Email"
    SET status = 'SENDING'::"EmailStatus", attempts = attempts + 1, "updatedAt" = ${now}
    WHERE id = ${emailId}
      AND (
        (status IN ('SCHEDULED'::"EmailStatus", 'RATE_LIMITED'::"EmailStatus") AND "scheduledAt" <= ${dueBy})
        OR (status = 'SENDING'::"EmailStatus" AND "updatedAt" < ${staleBefore})
      )
    RETURNING id, "campaignId", "userId", "senderId", "toAddress", subject, body, attempts`;
  return rows[0] ?? null;
}

export async function markSent(
  emailId: string,
  result: { messageId: string; previewUrl: string | null },
): Promise<Email> {
  return prisma.email.update({
    where: { id: emailId },
    data: {
      status: EmailStatus.SENT,
      sentAt: new Date(),
      messageId: result.messageId,
      previewUrl: result.previewUrl,
      error: null,
    },
  });
}

export async function markFailed(emailId: string, error: string): Promise<Email> {
  return prisma.email.update({
    where: { id: emailId },
    data: { status: EmailStatus.FAILED, error },
  });
}

/** Returns a claimed row to SCHEDULED so the BullMQ retry can claim it again. */
export async function releaseForRetry(emailId: string, error: string): Promise<void> {
  await prisma.email.updateMany({
    where: { id: emailId, status: EmailStatus.SENDING },
    data: { status: EmailStatus.SCHEDULED, error },
  });
}

export const SCHEDULED_STATUSES: EmailStatus[] = [
  EmailStatus.SCHEDULED,
  EmailStatus.SENDING,
  EmailStatus.RATE_LIMITED,
];
export const SENT_STATUSES: EmailStatus[] = [EmailStatus.SENT, EmailStatus.FAILED];

export type EmailListKind = 'scheduled' | 'sent';

export async function listEmails(userId: string, kind: EmailListKind, page: number, limit: number) {
  const where: Prisma.EmailWhereInput = {
    userId,
    status: { in: kind === 'scheduled' ? SCHEDULED_STATUSES : SENT_STATUSES },
  };
  const orderBy: Prisma.EmailOrderByWithRelationInput[] =
    kind === 'scheduled'
      ? [{ scheduledAt: 'asc' }, { id: 'asc' }]
      : [{ updatedAt: 'desc' }, { id: 'asc' }];

  const [total, rows] = await prisma.$transaction([
    prisma.email.count({ where }),
    prisma.email.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
      include: { sender: { select: { email: true } } },
    }),
  ]);

  return {
    items: rows.map(toEmailDto),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

export type EmailDto = ReturnType<typeof toEmailDto>;

export function toEmailDto(row: Email & { sender: { email: string } }) {
  return {
    id: row.id,
    campaignId: row.campaignId,
    toAddress: row.toAddress,
    subject: row.subject,
    status: row.status,
    senderEmail: row.sender.email,
    scheduledAt: row.scheduledAt.toISOString(),
    originalScheduledAt: row.originalScheduledAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    previewUrl: row.previewUrl,
    error: row.error,
    attempts: row.attempts,
  };
}

export async function getStats(userId: string): Promise<Record<EmailStatus, number>> {
  const grouped = await prisma.email.groupBy({
    by: ['status'],
    where: { userId },
    _count: { _all: true },
  });
  const stats = Object.fromEntries(Object.values(EmailStatus).map((s) => [s, 0])) as Record<
    EmailStatus,
    number
  >;
  for (const g of grouped) stats[g.status] = g._count._all;
  return stats;
}
