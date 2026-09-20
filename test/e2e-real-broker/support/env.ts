import { describe, it } from 'vitest';

/**
 * Copied, not imported, from each service's own `test/support/env.ts` (a service never imports another's source,
 * even its test helpers — `scripts/lib/checks.mjs`'s `checkSource` enforces this repo-wide). Locally, a missing
 * service skips the suite (with a notice). In CI (CI=true) a missing service is a FAILURE.
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
