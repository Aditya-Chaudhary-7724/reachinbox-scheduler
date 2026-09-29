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
    },
  },
});
