import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool';
import type { Sender } from '@prisma/client';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Explicit SMTP timeouts. Nodemailer's defaults (2 min to connect, 10 min socket idle) let a
 * dead pooled connection hang a job for minutes; Ethereal normally answers within seconds,
 * so fail fast and let BullMQ's retry/backoff try again. socketTimeout is inactivity-based:
 * it also closes idle pooled connections before a proxy/NAT can silently drop them.
 */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 20_000,
  greetingTimeout: 15_000,
  socketTimeout: 45_000,
} as const;

/** SMTP options for a sender: one pooled, reused connection per sender. */
export function smtpTransportOptions(sender: Sender): SMTPPool.Options {
  return {
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpPort === 465,
    auth: { user: sender.smtpUser, pass: sender.smtpPass },
    pool: true,
    maxConnections: 1,
    // Recycle the connection periodically instead of keeping one socket forever.
    maxMessages: 50,
    ...SMTP_TIMEOUTS,
  };
}

const transporters = new Map<string, Transporter>();

/** Persistent pooled transport per sender, reused across jobs in this process. */
export function smtpTransporterFor(sender: Sender): Transporter {
  let transporter = transporters.get(sender.id);
  if (!transporter) {
    transporter = nodemailer.createTransport(smtpTransportOptions(sender));
    transporters.set(sender.id, transporter);
  }
  return transporter;
}

/** Drops a sender's transport (e.g. after a failed send) so the next attempt reconnects. */
function discardTransporter(senderId: string): void {
  transporters.get(senderId)?.close();
  transporters.delete(senderId);
}

function transporterFor(sender: Sender): Transporter {
  if (env.MOCK_SMTP) {
    return nodemailer.createTransport({ jsonTransport: true });
  }
  return smtpTransporterFor(sender);
}

/** Deterministic Message-ID: any duplicate delivery after a crash is identifiable. */
export function messageIdFor(emailId: string): string {
  return `<${emailId}@reachinbox.local>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface SendResult {
  messageId: string;
  previewUrl: string | null;
}

export async function sendMail(
  sender: Sender,
  mail: { emailId: string; to: string; subject: string; body: string },
): Promise<SendResult> {
  let info;
  try {
    info = await transporterFor(sender).sendMail({
      from: { name: sender.name, address: sender.email },
      to: mail.to,
      subject: mail.subject,
      text: mail.body,
      html: `<div style="white-space:pre-wrap">${escapeHtml(mail.body)}</div>`,
      messageId: messageIdFor(mail.emailId),
    });
  } catch (err) {
    // A timed-out or reset pooled connection may be unusable: start fresh on the retry.
    if (!env.MOCK_SMTP) {
      discardTransporter(sender.id);
      logger.warn({ senderId: sender.id, err }, 'SMTP send failed; transport will reconnect');
    }
    throw err;
  }
  const preview = nodemailer.getTestMessageUrl(info);
  return {
    messageId: typeof info.messageId === 'string' ? info.messageId : messageIdFor(mail.emailId),
    previewUrl: typeof preview === 'string' ? preview : null,
  };
}

export function closeTransporters(): void {
  for (const t of transporters.values()) t.close();
  transporters.clear();
}
