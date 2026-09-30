import 'dotenv/config';
import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const optionalPositiveInt = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a positive integer' });
      return z.NEVER;
    }
    return n;
  });

const booleanString = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  // Exact origin of the dashboard (CORS + redirects), so any trailing slash is stripped.
  FRONTEND_URL: z
    .string()
    .url()
    .default('http://localhost:5173')
    .transform((v) => v.replace(/\/+$/, '')),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),
  // Encoded API key for secured clusters (e.g. Elastic Cloud). Unset for local dev.
  ELASTICSEARCH_API_KEY: optionalString,
  ELASTICSEARCH_INDEX: z.string().min(1).default('emails'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_CALLBACK_URL: z.string().url().default('http://localhost:4000/auth/google/callback'),

  SLACK_CLIENT_ID: optionalString,
  SLACK_CLIENT_SECRET: optionalString,
  SLACK_REDIRECT_URI: optionalString,
  SLACK_API_URL: z.string().url().default('https://slack.com/api'),
  SLACK_TOKEN_ENC_KEY: optionalString.refine(
    (v) => v === undefined || /^[0-9a-fA-F]{64}$/.test(v),
    'SLACK_TOKEN_ENC_KEY must be 64 hex characters (32 bytes)',
  ),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  MIN_SEND_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  MAX_EMAILS_PER_HOUR: optionalPositiveInt,
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().positive().default(200),
  STALE_SENDING_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000),
  JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  JOB_BACKOFF_MS: z.coerce.number().int().positive().default(30_000),

  ETHEREAL_USER: optionalString,
  ETHEREAL_PASS: optionalString,
  MOCK_SMTP: booleanString,

  BULL_BOARD_USER: z.string().min(1).default('admin'),
  BULL_BOARD_PASS: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    // Logger depends on env, so write directly to stderr here.
    process.stderr.write(`Invalid environment configuration:\n${issues.join('\n')}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
