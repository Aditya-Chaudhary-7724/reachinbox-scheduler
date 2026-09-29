/**
 * Ensures there are multiple Ethereal sender accounts to round-robin across.
 * - If ETHEREAL_USER/ETHEREAL_PASS are set, that account is upserted as a sender.
 * - The remainder (up to TARGET_SENDERS) is filled with auto-created Ethereal test accounts.
 * Safe to run repeatedly: existing senders are kept.
 */
import { env } from '../src/config/env';
import { prisma } from '../src/db/prisma';
import { logger } from '../src/utils/logger';

// nodemailer caches createTestAccount() per process unless ETHEREAL_CACHE is off,
// which would hand us the same account on every iteration. The flag is read at
// module load, so set it before importing nodemailer.
process.env.ETHEREAL_CACHE = 'false';

const TARGET_SENDERS = 3;
const ETHEREAL_SMTP = { host: 'smtp.ethereal.email', port: 587 };

async function main() {
  const { default: nodemailer } = await import('nodemailer');

  if (env.ETHEREAL_USER && env.ETHEREAL_PASS) {
    await prisma.sender.upsert({
      where: { email: env.ETHEREAL_USER },
      update: { smtpUser: env.ETHEREAL_USER, smtpPass: env.ETHEREAL_PASS },
      create: {
        name: 'Ethereal (configured)',
        email: env.ETHEREAL_USER,
        smtpHost: ETHEREAL_SMTP.host,
        smtpPort: ETHEREAL_SMTP.port,
        smtpUser: env.ETHEREAL_USER,
        smtpPass: env.ETHEREAL_PASS,
      },
    });
    logger.info({ email: env.ETHEREAL_USER }, 'Upserted configured Ethereal sender');
  }

  const existing = await prisma.sender.count();
  for (let i = existing; i < TARGET_SENDERS; i++) {
    const account = await nodemailer.createTestAccount();
    const sender = await prisma.sender.create({
      data: {
        name: `Ethereal Sender ${i + 1}`,
        email: account.user,
        smtpHost: account.smtp.host,
        smtpPort: account.smtp.port,
        smtpUser: account.user,
        smtpPass: account.pass,
      },
    });
    logger.info({ email: sender.email }, 'Created Ethereal test sender');
  }

  const senders = await prisma.sender.findMany({ select: { name: true, email: true } });
  logger.info({ senders }, `Seed complete: ${senders.length} senders`);
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'Seed failed');
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
