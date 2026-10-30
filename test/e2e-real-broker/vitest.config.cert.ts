import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Core V2 S1e-5: the integrated certification, run ONLY by scripts/deploy-tests/real-broker-consumers.mjs (`npm run test:deploy:real-broker`)
// on the broker and database it provisions; the ordinary real-broker job (`vitest.config.ts`, `*.e2e-spec.ts`) never includes it.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['certification/**/*.cert-spec.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
