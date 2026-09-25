import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Stage 17.9 operational probes (`npm run test:ops`): measurements and resource invariants against the BUILT service (`npm run build`
 * first) with real PostgreSQL and, when configured, the S3-compatible test server. Slow and machine-dependent: never part of `test`
 * or `test:e2e`, and never a capacity claim (see the Stage 17.9 record).
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.ops-spec.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
