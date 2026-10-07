import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DATABASE_URL_FLAG_DEPRECATION } from '../src/cli/cli-config.js';

/**
 * V2 A15.1: the BUILT operator CLIs refuse a missing, ambiguous or unreadable setting before they connect to anything, and never print
 * a value: not a URL, not a file's path content, not an argument. No PostgreSQL or RabbitMQ is needed (every case exits first, or dials
 * a closed local port). Sentinels are synthetic.
 */
const SENTINEL = 'sentinel-pw-41c8e2';
const pg = `postgres://app:${SENTINEL}@127.0.0.1:1/app?sslmode=disable&application_name=${SENTINEL}`; // port 1: nothing listens
const amqp = `amqp://svc:${SENTINEL}@127.0.0.1:1`;
const dir = mkdtempSync(join(tmpdir(), 'nawara-cli-config-'));
const file = (name: string, content: string) => {
  const path = join(dir, `${name}-${SENTINEL}`); // the path itself must not be printed either
  writeFileSync(path, content);
  return path;
};
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cli = (name: string) => fileURLToPath(new URL(`../dist/cli/${name}.js`, import.meta.url));
function run(name: string, args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, [cli(name), ...args], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 25_000 });
  expect(r.stdout + r.stderr, `${name}: no value in the output`).not.toContain(SENTINEL);
  return r;
}

describe('operator CLIs: configuration is read through EnvReader (V2 A15.1)', () => {
  const TOOLS: Array<{ name: string; args: string[]; variable: string; value: string; prefix: string; required: string }> = [
    { name: 'migrate', args: ['--no-kit'], variable: 'MIGRATION_DATABASE_URL', value: pg, prefix: 'migration failed: ', required: 'MIGRATION_DATABASE_URL (or DATABASE_URL) is required' },
    { name: 'dlq', args: ['list', '--queue', 'x.dead'], variable: 'RABBITMQ_URL', value: amqp, prefix: 'nawara-dlq failed: ', required: 'RABBITMQ_URL is required' },
    { name: 'check-dlq-depth', args: ['--queue', 'x.dead'], variable: 'RABBITMQ_URL', value: amqp, prefix: 'dlq depth check failed: ', required: 'RABBITMQ_URL is required' },
    { name: 'check-outbox-lag', args: [], variable: 'DATABASE_URL', value: pg, prefix: 'outbox lag check failed: ', required: 'DATABASE_URL (or DATABASE_URL_FILE) is required' },
  ];

  it.each(TOOLS)('$name: missing, whitespace-only, ambiguous and unreadable settings are refused by name (exit 1), with nothing else printed', (t) => {
    for (const env of [{}, { [t.variable]: '   ' }]) {
      const missing = run(t.name, t.args, env);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toBe(`${t.prefix}${t.required}\n`);
      expect(missing.stdout).toBe('');
    }
    const both = run(t.name, t.args, { [t.variable]: t.value, [`${t.variable}_FILE`]: file(t.name, t.value) });
    expect(both.status).toBe(1);
    expect(both.stderr).toBe(`${t.prefix}set ${t.variable} or ${t.variable}_FILE, not both\n`);
    const unreadable = run(t.name, t.args, { [`${t.variable}_FILE`]: join(dir, `missing-${SENTINEL}`) });
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).toBe(`${t.prefix}${t.variable}_FILE is set but the file cannot be read\n`);
  });

  it.each(TOOLS)('$name: NAME and NAME_FILE both reach the connection attempt (a closed port: a failure fact, never the URL)', (t) => {
    for (const env of [{ [t.variable]: ` ${t.value}\n` }, { [`${t.variable}_FILE`]: file(`${t.name}-ok`, `${t.value}\n`) }]) {
      const r = run(t.name, t.args, env);
      expect(r.status).toBe(1);
      expect(r.stderr.startsWith(t.prefix)).toBe(true);
      expect(r.stderr).not.toMatch(/is required|not both|cannot be read/); // the setting was accepted: the failure is the connection
    }
  });

  it('migrate: the fallback DATABASE_URL is used when the primary is unset, and is not read when the primary resolves', () => {
    const fallback = run('migrate', ['--no-kit'], { DATABASE_URL_FILE: file('fallback', pg) });
    expect(fallback.stderr).not.toMatch(/is required|not both|cannot be read/);
    const lazy = run('migrate', ['--no-kit'], { MIGRATION_DATABASE_URL_FILE: file('primary', pg), DATABASE_URL: pg, DATABASE_URL_FILE: join(dir, `missing-${SENTINEL}`) });
    expect(lazy.status).toBe(1);
    expect(lazy.stderr).not.toMatch(/is required|not both|cannot be read/); // an ambiguous, unreadable fallback is never evaluated
    const ambiguousFallback = run('migrate', ['--no-kit'], { DATABASE_URL: pg, DATABASE_URL_FILE: file('fallback-2', pg) });
    expect(ambiguousFallback.stderr).toBe('migration failed: set DATABASE_URL or DATABASE_URL_FILE, not both\n');
  });

  it('check-outbox-lag: --database-url still works and wins, with ONE fixed warning on stderr that never carries the URL', () => {
    const count = (text: string) => text.split(DATABASE_URL_FLAG_DEPRECATION).length - 1;
    const environments: Array<Record<string, string>> = [{}, { DATABASE_URL: pg }, { DATABASE_URL: pg, DATABASE_URL_FILE: file('lag', pg) }, { DATABASE_URL_FILE: join(dir, `missing-${SENTINEL}`) }];
    for (const env of environments) {
      const r = run('check-outbox-lag', ['--database-url', pg, '--max-age-seconds', '60'], env);
      expect(r.status).toBe(1); // the closed port
      const lines = r.stderr.trimEnd().split('\n');
      expect(lines[0]).toBe(DATABASE_URL_FLAG_DEPRECATION);
      expect(count(r.stderr)).toBe(1);
      expect(lines[1]).toMatch(/^outbox lag check failed: /);
      expect(r.stderr).not.toMatch(/is required|not both|cannot be read/); // the environment pair was not evaluated
      expect(r.stdout).toBe(''); // stdout carries the check's result only, as before
    }
    const env = run('check-outbox-lag', [], { DATABASE_URL: pg });
    expect(count(env.stderr)).toBe(0); // no flag, no warning
  });
});
