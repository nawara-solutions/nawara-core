import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Stage 18.5 failure probes (`npm run test:chaos`): the REAL broker and database containers are restarted / stopped underneath a running
 * ingestion (Docker CLI; `TEST_RABBITMQ_CONTAINER`, `TEST_POSTGRES_CONTAINER`). Destructive to the containers they name, so never part of
 * `test` or `test:e2e` and never run against shared infrastructure (the File `test:ops` precedent).
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.chaos-spec.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
