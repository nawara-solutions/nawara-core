import { defineConfig } from 'vitest/config';

// Unit tests: no external services. Integration tests (PostgreSQL, RabbitMQ) use vitest.config.integration.ts.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.spec.ts'],
  },
});
