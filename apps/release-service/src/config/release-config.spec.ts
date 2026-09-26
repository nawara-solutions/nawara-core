import { describe, expect, it } from 'vitest';
import { ConfigError } from '@nawara/service-kit';
import { SERVICE_NAME, loadReleaseConfig } from './release-config.js';

const DB = 'postgres://release_app:pw-not-real@db:5432/release';
const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ DATABASE_URL: DB, ...over });

describe('release-service configuration', () => {
  it('has one canonical identity, and production is the default environment (the safe behaviour)', () => {
    const c = loadReleaseConfig(env());
    expect(SERVICE_NAME).toBe('release-service');
    expect(c.serviceName).toBe('release-service');
    expect(c.nodeEnv).toBe('production');
    expect(c.isProduction).toBe(true);
    expect(c.databaseUrl).toBe(DB);
  });

  it('carries only the foundation: no service token, Auth, audit, cache, channel, artifact, signing or feature setting (later stages / never)', () => {
    const keys = Object.keys(loadReleaseConfig(env()));
    for (const absent of ['serviceTokens', 'callerPolicy', 'authServiceUrl', 'ownerAccess', 'rabbitmqUrl', 'cacheMaxAge', 'channels', 'signingKey', 'featureFlags', 'maintenance']) {
      expect(keys).not.toContain(absent);
    }
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
