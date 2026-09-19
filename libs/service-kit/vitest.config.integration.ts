import { defineConfig } from 'vitest/config';

// Integration tests need a real PostgreSQL (TEST_DATABASE_ADMIN_URL) and RabbitMQ (TEST_RABBITMQ_URL).
// In CI (CI=true) a missing service is a FAILURE, never a silent skip: see test/support/env.ts.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.int-spec.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
