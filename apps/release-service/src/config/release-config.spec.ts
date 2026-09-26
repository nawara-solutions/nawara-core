import { describe, expect, it } from 'vitest';
import { ConfigError } from '@nawara/service-kit';
import { SERVICE_NAME, loadReleaseConfig } from './release-config.js';

const DB = 'postgres://release_app:pw-not-real@db:5432/release';
const BROKER = 'amqp://guest:guest@broker:5672';
const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ DATABASE_URL: DB, RABBITMQ_URL: BROKER, ...over });
const DIGEST = 'a'.repeat(64);

describe('release-service configuration', () => {
  it('has one canonical identity, and production is the default environment (the safe behaviour)', () => {
    const c = loadReleaseConfig(env());
    expect(SERVICE_NAME).toBe('release-service');
    expect(c.serviceName).toBe('release-service');
    expect(c.nodeEnv).toBe('production');
    expect(c.isProduction).toBe(true);
    expect(c.databaseUrl).toBe(DB);
  });

  it('Stage 20.3 adds service callers, their policy, the audit broker and the docs; still no Auth, owner, cache, channel, artifact, signing or feature setting (later stages / never)', () => {
    const c = loadReleaseConfig(env());
    expect(c.serviceTokens).toEqual([]); // fail closed: nobody can call
    expect(c.callerPolicy.holds('anyone', 'release.register')).toBe(false);
    expect(c.rabbitmqUrl).toBe(BROKER);
    expect(c.docs).toEqual({ username: 'docs', password: undefined });
    const keys = Object.keys(c);
    for (const absent of ['authServiceUrl', 'ownerAccess', 'operatingCompanyId', 'cacheMaxAge', 'channels', 'signingKey', 'featureFlags', 'maintenance', 'billingServiceUrl']) {
      expect(keys).not.toContain(absent);
    }
  });

  it('production requires the broker (the committed audit intent must leave the service); development may use the in-memory bus', () => {
    expect(() => loadReleaseConfig(env({ RABBITMQ_URL: undefined }))).toThrow(/RABBITMQ_URL is required in production/);
    expect(() => loadReleaseConfig(env({ RABBITMQ_URL: 'http://broker' }))).toThrow(ConfigError);
    expect(loadReleaseConfig(env({ NODE_ENV: 'development', RABBITMQ_URL: undefined })).rabbitmqUrl).toBeUndefined();
  });

  it('every registered caller needs a policy entry and every entry a registered caller (deny by default); SWAGGER_PASSWORD needs 16+ characters', () => {
    const tokens = `drive-ci:${DIGEST}`;
    expect(() => loadReleaseConfig(env({ SERVICE_TOKENS: tokens }))).toThrow(/RELEASE_SERVICE_POLICY is required/);
    const c = loadReleaseConfig(env({ SERVICE_TOKENS: tokens, RELEASE_SERVICE_POLICY: JSON.stringify({ callers: { 'drive-ci': { products: { drive: ['release.register'] } } } }) }));
    expect(c.callerPolicy.allows('drive-ci', 'drive', 'release.register')).toBe(true);
    expect(() => loadReleaseConfig(env({ SERVICE_TOKENS: tokens, RELEASE_SERVICE_POLICY: JSON.stringify({ callers: { other: { products: { drive: ['release.register'] } } } }) })))
      .toThrow(/no registered service token/);
    expect(() => loadReleaseConfig(env({ SWAGGER_PASSWORD: 'short' }))).toThrow(ConfigError);
    expect(loadReleaseConfig(env({ SWAGGER_PASSWORD: 'x'.repeat(16) })).docs.password).toBe('x'.repeat(16));
  });

  it('refuses a missing or invalid database URL, and a superuser or migrator login in production, never echoing the value', () => {
    for (const bad of [{ DATABASE_URL: undefined }, { DATABASE_URL: '' }, { DATABASE_URL: 'mysql://release_app:pw-not-real@db/release' }, { DATABASE_URL: 'not a url' },
      { DATABASE_URL: 'postgres://postgres:pw-not-real@db/release' }, { DATABASE_URL: 'postgres://release_migrator:pw-not-real@db/release' }]) {
      let err: unknown;
      try {
        loadReleaseConfig(env(bad));
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(bad)).toBeInstanceOf(ConfigError);
      expect(String((err as Error).message)).not.toContain('pw-not-real');
    }
    expect(loadReleaseConfig(env({ NODE_ENV: 'development', DATABASE_URL: 'postgres://postgres:pw@db/release' })).databaseUrl).toContain('postgres:'); // development may
  });

  it('carries the kit database limits with their bounded defaults', () => {
    expect(loadReleaseConfig(env()).db).toEqual({ poolMax: 10, connectionTimeoutMs: 5000, statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 60_000, queryTimeoutMs: 35_000 });
    for (const [name, value] of [['DB_POOL_MAX', '0'], ['DB_POOL_MAX', '101'], ['DB_STATEMENT_TIMEOUT_MS', '10']]) {
      expect(() => loadReleaseConfig(env({ [name]: value })), `${name}=${value}`).toThrow(ConfigError);
    }
  });
});
