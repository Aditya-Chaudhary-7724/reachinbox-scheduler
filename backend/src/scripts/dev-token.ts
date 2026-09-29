/**
 * Local/testing helper: upserts a user and prints a session JWT for it, so the API can be
 * exercised with `Authorization: Bearer <token>` without going through Google.
 * Refuses to run when NODE_ENV=production.
 *
 *   npm run dev:token -- test@example.com "Test User"
 */
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { signSessionToken } from '../services/auth';

async function main() {
  if (env.NODE_ENV === 'production') {
    throw new Error('dev:token is disabled in production');
  }
  const email = (process.argv[2] ?? 'dev@example.com').toLowerCase();
  const name = process.argv[3] ?? 'Dev User';
  const user = await prisma.user.upsert({
    where: { googleId: `dev:${email}` },
    update: { email, name },
    create: { googleId: `dev:${email}`, email, name },
  });
  process.stdout.write(`${signSessionToken(user.id)}\n`);
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
