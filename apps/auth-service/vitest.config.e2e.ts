import { defineConfig } from 'vitest/config';

// Integration tests run against a REAL PostgreSQL with the real migrations applied: the point is to
// prove the service and the database constraints work together. See test/helpers/global-setup.ts.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['test/helpers/global-setup.ts'],
    setupFiles: ['test/helpers/env.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
