import { describe } from 'vitest';

/**
 * Integration suites need real services. Locally, a missing service skips the suite (with a notice). In CI (CI=true) a
 * missing service is a FAILURE: CI must never silently skip what it claims to cover.
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
    // V2 A15.3: the suite body is NOT run. Vitest runs a describe callback while collecting, even for a skipped describe, so running
    // `body({})` here executed the suite's setup with no configuration (a `new URL(env.X)` threw and failed the whole file).
    describe.skip(`${title} (needs ${missing.join(', ')})`, () => {
      it(`needs ${missing.join(', ')}`, () => undefined);
    });
  }
}
