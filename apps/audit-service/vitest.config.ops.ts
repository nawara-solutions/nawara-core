import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Stage 18.6 measurements (`npm run test:ops`): query plans against a representative volume on real PostgreSQL. Slow and
 * machine-dependent: never part of `test` or `test:e2e`, never a capacity claim (the File 17.9 `test:ops` precedent).
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.ops-spec.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    fileParallelism: false,
  },
});
