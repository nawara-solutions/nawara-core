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
