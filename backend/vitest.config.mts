import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    // Integration tests share Redis/Postgres; run files sequentially.
    fileParallelism: false,
    // Isolated stores so tests never touch development data.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://reachinbox:reachinbox@localhost:5433/reachinbox_test?schema=public',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
      BULL_BOARD_PASS: 'test',
      JWT_SECRET: 'test-secret-at-least-16-chars',
      ELASTICSEARCH_INDEX: 'emails_test',
      MOCK_SMTP: 'true',
      MIN_SEND_INTERVAL_MS: '1000',
      MAX_EMAILS_PER_HOUR_PER_SENDER: '1000',
      MAX_EMAILS_PER_HOUR: '',
      FRONTEND_URL: 'http://localhost:5173',
      // Slack API + incoming webhook are served by a local HTTP stub in tests/slack*.
      SLACK_CLIENT_ID: 'test-client-id',
      SLACK_CLIENT_SECRET: 'test-client-secret',
      SLACK_REDIRECT_URI: 'https://example.ngrok.app/api/slack/callback',
      SLACK_API_URL: 'http://127.0.0.1:4599/api',
      SLACK_TOKEN_ENC_KEY: '0'.repeat(64),
    },
  },
});
