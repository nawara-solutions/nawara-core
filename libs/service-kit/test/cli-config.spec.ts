import { describe, expect, it } from 'vitest';
import { ConfigError, EnvReader } from '../src/index.js';
import { DATABASE_URL_FLAG_DEPRECATION, brokerUrl, migrationDatabaseUrl, outboxDatabaseUrl } from '../src/cli/cli-config.js';

/**
 * V2 A15.1: how the operator CLIs resolve their connection settings. `EnvReader` itself (trimming, `NAME_FILE`, the unreadable file,
 * value-free errors) is proven by config.spec.ts; these tests cover only what the CLIs add: the migration fallback, the deprecated
 * `--database-url` precedence, and that neither ever reads a setting it does not use.
 */
const SENTINEL = 'sentinel-pw-7f3a9c'; // synthetic: stands for a credential in a URL or a file
const url = (name: string) => `postgres://${name}:${SENTINEL}@db.internal:5432/${name}`;
/** A reader over `env` whose files are `files`; `read` records every setting file that was opened. */
function reader(env: Record<string, string | undefined>, files: Record<string, string> = {}) {
  const read: string[] = [];
  const r = new EnvReader(env as NodeJS.ProcessEnv, (p) => {
    read.push(p);
    if (!(p in files)) throw new Error(`ENOENT ${SENTINEL}`);
    return files[p]!;
  });
  return { r, read };
}
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).not.toContain(SENTINEL);
    return (e as Error).message;
  }
  throw new Error('expected a ConfigError');
};

describe('migrationDatabaseUrl: MIGRATION_DATABASE_URL, falling back lazily to DATABASE_URL (OD-A15-7, OD-A15.1-2)', () => {
  const FILES = { '/run/mig': `${url('migrator')}\n`, '/run/db': `${url('app')}\n` };

  it('uses the primary setting, by name or by file', () => {
    expect(migrationDatabaseUrl(reader({ MIGRATION_DATABASE_URL: url('migrator') }).r)).toBe(url('migrator'));
    expect(migrationDatabaseUrl(reader({ MIGRATION_DATABASE_URL_FILE: '/run/mig' }, FILES).r)).toBe(url('migrator'));
    expect(migrationDatabaseUrl(reader({ MIGRATION_DATABASE_URL: `  ${url('migrator')}\n` }).r)).toBe(url('migrator'));
  });

  it('refuses the primary setting given both ways, whatever the fallback holds', () => {
    for (const fallback of [{}, { DATABASE_URL: url('app') }]) {
      expect(refusal(() => migrationDatabaseUrl(reader({ MIGRATION_DATABASE_URL: url('migrator'), MIGRATION_DATABASE_URL_FILE: '/run/mig', ...fallback }, FILES).r)))
        .toBe('set MIGRATION_DATABASE_URL or MIGRATION_DATABASE_URL_FILE, not both');
    }
  });

  it('does not read the fallback at all once the primary resolves: a primary file with DATABASE_URL, or an ambiguous or unreadable fallback', () => {
    // The primary by file together with DATABASE_URL is the normal primary / fallback chain, not an ambiguity.
    expect(migrationDatabaseUrl(reader({ MIGRATION_DATABASE_URL_FILE: '/run/mig', DATABASE_URL: url('app') }, FILES).r)).toBe(url('migrator'));
    const ambiguous = reader({ MIGRATION_DATABASE_URL: url('migrator'), DATABASE_URL: url('app'), DATABASE_URL_FILE: '/run/db' }, FILES);
    expect(migrationDatabaseUrl(ambiguous.r)).toBe(url('migrator'));
    expect(ambiguous.read).toEqual([]);
    const unreadable = reader({ MIGRATION_DATABASE_URL_FILE: '/run/mig', DATABASE_URL_FILE: '/missing' }, FILES);
    expect(migrationDatabaseUrl(unreadable.r)).toBe(url('migrator'));
    expect(unreadable.read).toEqual(['/run/mig']);
  });

  it('falls back to DATABASE_URL, by name or by file, when the primary is unset, empty or whitespace only', () => {
    expect(migrationDatabaseUrl(reader({ DATABASE_URL: url('app') }).r)).toBe(url('app'));
    expect(migrationDatabaseUrl(reader({ DATABASE_URL_FILE: '/run/db' }, FILES).r)).toBe(url('app'));
    for (const blank of ['', '   ', '\n\t ']) expect(migrationDatabaseUrl(reader({ MIGRATION_DATABASE_URL: blank, DATABASE_URL: url('app') }).r)).toBe(url('app'));
  });

  it('refuses an ambiguous or unreadable fallback when the fallback is what would be used', () => {
    expect(refusal(() => migrationDatabaseUrl(reader({ DATABASE_URL: url('app'), DATABASE_URL_FILE: '/run/db' }, FILES).r))).toBe('set DATABASE_URL or DATABASE_URL_FILE, not both');
    expect(refusal(() => migrationDatabaseUrl(reader({ DATABASE_URL_FILE: '/missing' }, FILES).r))).toBe('DATABASE_URL_FILE is set but the file cannot be read');
    expect(refusal(() => migrationDatabaseUrl(reader({ MIGRATION_DATABASE_URL_FILE: '/missing', DATABASE_URL: url('app') }, FILES).r)))
      .toBe('MIGRATION_DATABASE_URL_FILE is set but the file cannot be read'); // an unreadable primary is an error, never a silent fallback
  });

  it('requires one of the two', () => {
    for (const env of [{}, { MIGRATION_DATABASE_URL: ' ', DATABASE_URL: '' }]) {
      expect(refusal(() => migrationDatabaseUrl(reader(env).r))).toBe('MIGRATION_DATABASE_URL (or DATABASE_URL) is required');
    }
  });
});

describe('brokerUrl: RABBITMQ_URL or RABBITMQ_URL_FILE', () => {
  const amqp = `amqp://svc:${SENTINEL}@broker.internal:5672`;
  it('reads either form, refuses both, and requires one', () => {
    expect(brokerUrl(reader({ RABBITMQ_URL: ` ${amqp} ` }).r)).toBe(amqp);
    expect(brokerUrl(reader({ RABBITMQ_URL_FILE: '/run/amqp' }, { '/run/amqp': `${amqp}\n` }).r)).toBe(amqp);
    expect(refusal(() => brokerUrl(reader({ RABBITMQ_URL: amqp, RABBITMQ_URL_FILE: '/run/amqp' }, { '/run/amqp': amqp }).r))).toBe('set RABBITMQ_URL or RABBITMQ_URL_FILE, not both');
    expect(refusal(() => brokerUrl(reader({ RABBITMQ_URL_FILE: '/missing' }).r))).toBe('RABBITMQ_URL_FILE is set but the file cannot be read');
    for (const env of [{}, { RABBITMQ_URL: '  ' }]) expect(refusal(() => brokerUrl(reader(env).r))).toBe('RABBITMQ_URL is required');
  });
});

describe('outboxDatabaseUrl: DATABASE_URL or DATABASE_URL_FILE; the deprecated --database-url still wins (OD-A15-1)', () => {
  const FILES = { '/run/db': `${url('app')}\n` };

  it('reads the environment, by name or by file, when no flag is given', () => {
    expect(outboxDatabaseUrl(reader({ DATABASE_URL: url('app') }).r, undefined)).toBe(url('app'));
    expect(outboxDatabaseUrl(reader({ DATABASE_URL_FILE: '/run/db' }, FILES).r, undefined)).toBe(url('app'));
    expect(refusal(() => outboxDatabaseUrl(reader({ DATABASE_URL: url('app'), DATABASE_URL_FILE: '/run/db' }, FILES).r, undefined))).toBe('set DATABASE_URL or DATABASE_URL_FILE, not both');
    expect(refusal(() => outboxDatabaseUrl(reader({}).r, undefined))).toBe('DATABASE_URL (or DATABASE_URL_FILE) is required');
  });

  it('the flag wins and the environment is then not read at all: alone, with DATABASE_URL, with an ambiguous or unreadable pair', () => {
    expect(outboxDatabaseUrl(reader({}).r, url('flag'))).toBe(url('flag'));
    expect(outboxDatabaseUrl(reader({ DATABASE_URL: url('app') }).r, url('flag'))).toBe(url('flag'));
    const ambiguous = reader({ DATABASE_URL: url('app'), DATABASE_URL_FILE: '/run/db' }, FILES);
    expect(outboxDatabaseUrl(ambiguous.r, url('flag'))).toBe(url('flag'));
    expect(ambiguous.read).toEqual([]);
    const unreadable = reader({ DATABASE_URL_FILE: '/missing' });
    expect(outboxDatabaseUrl(unreadable.r, url('flag'))).toBe(url('flag'));
    expect(unreadable.read).toEqual([]);
  });

  it('the deprecation text is fixed: it names the replacement and can carry no value', () => {
    expect(DATABASE_URL_FLAG_DEPRECATION).toBe('--database-url is deprecated: pass DATABASE_URL or DATABASE_URL_FILE (a credential on the command line is visible to other processes)');
    expect(DATABASE_URL_FLAG_DEPRECATION).not.toMatch(/:\/\/|\$\{|@/);
  });
});
