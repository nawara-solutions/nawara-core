import { describe, expect, it } from 'vitest';
import { ConfigError, EnvReader, loadBaseConfig, parseCorsOrigins } from '../src/index.js';

const reader = (env: Record<string, string | undefined>, files: Record<string, string> = {}) =>
  new EnvReader(env as NodeJS.ProcessEnv, (p) => {
    if (!(p in files)) throw new Error('ENOENT');
    return files[p];
  });

describe('EnvReader', () => {
  it('requires a value and never echoes one in an error', () => {
    expect(() => reader({}).required('DATABASE_URL')).toThrow('DATABASE_URL is required');
    const secret = 'super-secret-value-that-is-too-short';
    try {
      reader({ TOKEN: secret }).secret('TOKEN', 64);
      throw new Error('no throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it('reads NAME_FILE (the file wins) and fails clearly, without the path content, when it cannot be read', () => {
    expect(reader({ DB_PASS_FILE: '/run/secrets/db', DB_PASS: 'from-env' }, { '/run/secrets/db': 'from-file\n' }).get('DB_PASS')).toBe('from-file');
    expect(() => reader({ DB_PASS_FILE: '/missing' }).get('DB_PASS')).toThrow('DB_PASS_FILE is set but the file cannot be read');
  });

  it('validates integers, booleans, enumerations and URLs without echoing values', () => {
    expect(reader({}).int('PORT', { default: 3000, min: 1, max: 65535 })).toBe(3000);
    expect(reader({ PORT: '8080' }).int('PORT', { default: 3000, min: 1, max: 65535 })).toBe(8080);
    for (const bad of ['0', '70000', '3.5', 'abc']) expect(() => reader({ PORT: bad }).int('PORT', { default: 1, min: 1, max: 65535 })).toThrow(ConfigError);
    expect(reader({ FLAG: 'true' }).bool('FLAG', false)).toBe(true);
    expect(() => reader({ FLAG: 'yes' }).bool('FLAG', false)).toThrow(ConfigError);
    expect(() => reader({ MODE: 'x' }).oneOf('MODE', ['a', 'b'] as const, 'a')).toThrow(ConfigError);
    expect(reader({ U: 'postgres://u:p@h/db' }).url('U', ['postgres:', 'postgresql:'])).toBe('postgres://u:p@h/db');
    try {
      reader({ U: 'http://user:hunter2@host' }).url('U', ['postgres:']);
      throw new Error('no throw');
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
    }
    expect(() => reader({ U: 'not a url' }).url('U', ['postgres:'])).toThrow('U must be a valid URL');
  });
});

describe('loadBaseConfig', () => {
  it('defaults to PRODUCTION behaviour when NODE_ENV is unset (the safe default)', () => {
    const c = loadBaseConfig('billing-service', {});
    expect(c).toMatchObject({ nodeEnv: 'production', isProduction: true, port: 3000, logLevel: 'info', bodyLimitKb: 100, corsOrigins: [], trustProxy: false });
  });

  it('accepts development and test, and rejects anything else', () => {
    expect(loadBaseConfig('billing-service', { NODE_ENV: 'development' }).isProduction).toBe(false);
    expect(() => loadBaseConfig('billing-service', { NODE_ENV: 'staging' })).toThrow(ConfigError);
  });

  it('validates the service name, port, log level and body limit', () => {
    expect(() => loadBaseConfig('Billing Service', {})).toThrow(ConfigError);
    expect(() => loadBaseConfig('billing-service', { PORT: '0' })).toThrow(ConfigError);
    expect(() => loadBaseConfig('billing-service', { LOG_LEVEL: 'trace' })).toThrow(ConfigError);
    expect(() => loadBaseConfig('billing-service', { BODY_LIMIT_KB: '0' })).toThrow(ConfigError);
  });

  it('CORS fails closed: exact http(s) origins only, never a wildcard, path or bare host', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins('https://a.test, http://localhost:3000')).toEqual(['https://a.test', 'http://localhost:3000']);
    for (const bad of ['*', 'https://*.a.test', 'a.test', 'https://a.test/', 'https://a.test/x', 'ftp://a.test']) {
      expect(() => parseCorsOrigins(bad), bad).toThrow(ConfigError);
    }
  });
});

describe('database runtime limits (Stage 14.4)', () => {
  it('defaults: pool 10, connection 5 s, statement 30 s, idle in transaction 60 s', () => {
    expect(loadBaseConfig('billing-service', {}).db).toEqual({ poolMax: 10, connectionTimeoutMs: 5000, statementTimeoutMs: 30000, idleInTransactionTimeoutMs: 60000, queryTimeoutMs: 35000 });
  });
  it('accepts values inside the bounds', () => {
    const env = { DB_POOL_MAX: '25', DB_CONNECTION_TIMEOUT_MS: '100', DB_STATEMENT_TIMEOUT_MS: '600000', DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '3600000' };
    expect(loadBaseConfig('billing-service', env).db).toEqual({ poolMax: 25, connectionTimeoutMs: 100, statementTimeoutMs: 600000, idleInTransactionTimeoutMs: 3600000, queryTimeoutMs: 605000 });
  });
  it.each([
    ['DB_POOL_MAX', '0'], ['DB_POOL_MAX', '101'], ['DB_POOL_MAX', 'ten'],
    ['DB_CONNECTION_TIMEOUT_MS', '0'], ['DB_CONNECTION_TIMEOUT_MS', '-1'], ['DB_CONNECTION_TIMEOUT_MS', '1.5'], ['DB_CONNECTION_TIMEOUT_MS', '60001'],
    ['DB_STATEMENT_TIMEOUT_MS', '0'], ['DB_STATEMENT_TIMEOUT_MS', '999'], ['DB_STATEMENT_TIMEOUT_MS', 'NaN'],
    ['DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', '0'], ['DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', '3600001'],
  ])('refuses %s=%s (zero, negative, fractional, non-numeric or unbounded), naming the variable', (name, value) => {
    expect(() => loadBaseConfig('billing-service', { [name]: value })).toThrow(new RegExp(name));
  });
});

describe('client-side query deadline (Stage 15.2, I9)', () => {
  const db = (env: Record<string, string>) => loadBaseConfig('billing-service', env).db;
  it('defaults to the statement timeout + 5 s, following a changed statement timeout', () => {
    expect(db({}).queryTimeoutMs).toBe(35000);
    expect(db({ DB_STATEMENT_TIMEOUT_MS: '1000' }).queryTimeoutMs).toBe(6000);
    expect(db({ DB_STATEMENT_TIMEOUT_MS: '600000' }).queryTimeoutMs).toBe(605000);
  });
  it('accepts an explicit value above the statement timeout, up to the bound', () => {
    expect(db({ DB_QUERY_TIMEOUT_MS: '30001' }).queryTimeoutMs).toBe(30001);
    expect(db({ DB_STATEMENT_TIMEOUT_MS: '1000', DB_QUERY_TIMEOUT_MS: '1001' }).queryTimeoutMs).toBe(1001);
    expect(db({ DB_STATEMENT_TIMEOUT_MS: '600000', DB_QUERY_TIMEOUT_MS: '660000' }).queryTimeoutMs).toBe(660000);
  });
  it.each(['0', '-1', '999', '660001', '1.5', 'ten', 'NaN'])('refuses DB_QUERY_TIMEOUT_MS=%s (outside 1000-660000 or not an integer)', (value) => {
    expect(() => db({ DB_QUERY_TIMEOUT_MS: value })).toThrow(/DB_QUERY_TIMEOUT_MS must be an integer between 1000 and 660000/);
  });
  it.each([
    [{ DB_QUERY_TIMEOUT_MS: '30000' }], // equal to the default statement timeout
    [{ DB_QUERY_TIMEOUT_MS: '20000' }], // below it
    [{ DB_STATEMENT_TIMEOUT_MS: '60000', DB_QUERY_TIMEOUT_MS: '35000' }], // a raised statement timeout left above an explicit deadline
  ])('refuses a deadline that is not above the statement timeout (the server must cancel a slow statement first): %o', (env) => {
    expect(() => db(env)).toThrow(/DB_QUERY_TIMEOUT_MS must be greater than DB_STATEMENT_TIMEOUT_MS/);
  });
});
