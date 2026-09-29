import nodemailer, { type Transporter } from 'nodemailer';
import type { Sender } from '@prisma/client';
import { env } from '../config/env';

const transporters = new Map<string, Transporter>();

/** One pooled SMTP transport per sender, reused across jobs in this process. */
function transporterFor(sender: Sender): Transporter {
  if (env.MOCK_SMTP) {
    return nodemailer.createTransport({ jsonTransport: true });
  }
  let transporter = transporters.get(sender.id);
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: sender.smtpHost,
      port: sender.smtpPort,
      secure: sender.smtpPort === 465,
      pool: true,
      maxConnections: 2,
      auth: { user: sender.smtpUser, pass: sender.smtpPass },
    });
    transporters.set(sender.id, transporter);
  }
  return transporter;
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
  const info = await transporterFor(sender).sendMail({
    from: { name: sender.name, address: sender.email },
    to: mail.to,
    subject: mail.subject,
    text: mail.body,
    html: `<div style="white-space:pre-wrap">${escapeHtml(mail.body)}</div>`,
    messageId: messageIdFor(mail.emailId),
  });
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
