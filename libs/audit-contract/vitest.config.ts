import { defineConfig } from 'vitest/config';

// Unit tests: no external services. The PostgreSQL suites (outbox transaction, relay envelope) use vitest.config.integration.ts.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.spec.ts'],
  },
});
