import { afterAll, describe, expect, it } from 'vitest';
import type { RunnerTask, RunnerTestSuite } from 'vitest';
import { describeWithEnv } from './support/env.js';

/**
 * V2 A15.3: the infrastructure gate of the integration suites. Locally, a suite whose variables are missing is SKIPPED and its body is
 * never run (Vitest runs describe callbacks while collecting, so running the body would execute its setup with no configuration). In
 * CI the same suite becomes a failing test. With the variables present, the body runs normally.
 */
const MISSING = 'A15_3_DESCRIBE_WITH_ENV_MISSING'; // never set
const PRESENT = 'A15_3_DESCRIBE_WITH_ENV_PRESENT';
const ran = { missing: 0, present: 0, ci: 0 };
// Vitest decides nothing eagerly here: describeWithEnv reads the environment when it is called, but each describe callback (and so a
// suite body) runs later, during collection. The state each case needs is therefore set where that case is evaluated.
const savedCi = process.env.CI;
delete process.env[MISSING];
delete process.env.CI;
process.env[PRESENT] = 'set';
afterAll(() => {
  delete process.env[PRESENT];
  if (savedCi === undefined) delete process.env.CI; else process.env.CI = savedCi;
});

describeWithEnv('probe: local, variable missing', [MISSING], () => {
  ran.missing += 1;
  new URL(process.env[MISSING] as string); // what the observability spec did: it must never run here
});
// Inside a skipped describe, so the CI failure it registers is collected (and inspected below) without failing this file.
describe.skip('probe: CI container', () => {
  process.env.CI = 'true';
  describeWithEnv('probe: CI, variable missing', [MISSING], () => {
    ran.ci += 1;
  });
  delete process.env.CI;
});
describeWithEnv('probe: variable present', [PRESENT], (env) => {
  ran.present += 1;
  it('receives the variable', () => expect(env[PRESENT]).toBe('set'));
});

const find = (tasks: RunnerTask[], name: string): RunnerTask | undefined =>
  tasks.map((t) => (t.name === name ? t : t.type === 'suite' ? find((t as RunnerTestSuite).tasks, name) : undefined)).find(Boolean);

describe('describeWithEnv', () => {
  it('local, variable missing: the suite is skipped and its body is never run', (ctx) => {
    expect(ran.missing).toBe(0);
    const suite = find(ctx.task.file.tasks, `probe: local, variable missing (needs ${MISSING})`) as RunnerTestSuite;
    expect(suite?.mode).toBe('skip');
    expect(suite.tasks.map((t) => t.name)).toEqual([`needs ${MISSING}`]);
  });

  it('CI, variable missing: the body is not run and a failing "requires" test takes its place', (ctx) => {
    expect(ran.ci).toBe(0);
    const suite = find(ctx.task.file.tasks, 'probe: CI, variable missing') as RunnerTestSuite;
    expect(suite.tasks.map((t) => t.name)).toEqual([`requires ${MISSING}`]);
  });

  it('variable present: the body runs once and its tests are registered', (ctx) => {
    expect(ran.present).toBe(1);
    const suite = find(ctx.task.file.tasks, 'probe: variable present') as RunnerTestSuite;
    expect(suite.mode).not.toBe('skip');
    expect(suite.tasks.map((t) => t.name)).toEqual(['receives the variable']);
  });
});
