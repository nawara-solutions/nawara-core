import { defineConfig } from 'vitest/config';

// Integration tests need a real PostgreSQL (TEST_DATABASE_ADMIN_URL). In CI (CI=true) a missing database is a FAILURE, never a skip.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.int-spec.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
