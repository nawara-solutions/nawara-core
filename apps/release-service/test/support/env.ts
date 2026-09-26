import { describe } from 'vitest';

/**
 * Integration/e2e suites need a real Postgres. Locally, a missing service skips the suite (with a notice). In CI
 * (CI=true) a missing service is a FAILURE: CI must never silently skip what it claims to cover. Mirrors
 * `libs/service-kit/test/support/env.ts` — kept local since it's a test helper, not shared infrastructure.
 */
export function describeWithEnv(title: string, envNames: string[], body: (env: Record<string, string>) => void): void {
  const missing = envNames.filter((n) => !process.env[n]);
  if (missing.length === 0) {
    describe(title, () => body(Object.fromEntries(envNames.map((n) => [n, process.env[n] as string]))));
  } else if (process.env.CI) {
    describe(title, () => {
      it(`requires ${missing.join(', ')}`, () => {
        throw new Error(`${missing.join(', ')} must be set in CI`);
      });
    });
  } else {
    describe.skip(`${title} (needs ${missing.join(', ')})`, () => body({}));
  }
}
