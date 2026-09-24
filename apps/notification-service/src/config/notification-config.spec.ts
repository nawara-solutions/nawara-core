import { describe, expect, it } from 'vitest';
import { ConfigError, generateServiceToken } from '@nawara/service-kit';
import { SERVICE_NAME, loadNotificationConfig } from './notification-config.js';

const DB = 'postgres://notification_app:pw-not-real@db:5432/notification';
const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ DATABASE_URL: DB, ...over });

describe('notification-service configuration', () => {
  it('has one canonical identity, and production is the default environment (the safe behaviour)', () => {
    const c = loadNotificationConfig(env());
    expect(SERVICE_NAME).toBe('notification-service');
    expect(c.serviceName).toBe('notification-service');
    expect(c.nodeEnv).toBe('production');
    expect(c.isProduction).toBe(true);
  });

  it('in production needs only DATABASE_URL; every other setting has a default, and no default opens anything', () => {
    const c = loadNotificationConfig(env({ NODE_ENV: 'production' }));
    expect(c.databaseUrl).toBe(DB);
    expect(c.port).toBe(3000);
    expect(c.httpDrainTimeoutMs).toBe(5000);
    expect(c.corsOrigins).toEqual([]);
    expect(c.trustProxy).toBe(false);
    expect(c.serviceTokens).toEqual([]); // every service-token call refused
  });

  it('carries the kit database limits with their bounded defaults (Stage 16.4)', () => {
    expect(loadNotificationConfig(env()).db).toEqual({ poolMax: 10, connectionTimeoutMs: 5000, statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 60_000, queryTimeoutMs: 35_000 });
    expect(() => loadNotificationConfig(env({ DB_POOL_MAX: '0' }))).toThrow(ConfigError);
    expect(() => loadNotificationConfig(env({ DB_STATEMENT_TIMEOUT_MS: '30000', DB_QUERY_TIMEOUT_MS: '30000' }))).toThrow(/DB_QUERY_TIMEOUT_MS/);
  });

  it('carries only what the service uses: no broker, policy, key ring, default locale or provider configuration yet', () => {
    const keys = Object.keys(loadNotificationConfig(env()));
    for (const later of ['rabbitmqUrl', 'servicePolicy', 'secretKeys', 'defaultLocale', 'docs']) expect(keys).not.toContain(later);
  });

  it('refuses a missing or non-PostgreSQL DATABASE_URL, without echoing it', () => {
    expect(() => loadNotificationConfig({})).toThrow(/DATABASE_URL/);
    for (const bad of ['mysql://u:secret-pw-value@h/db', 'not a url']) {
      try {
        loadNotificationConfig({ DATABASE_URL: bad });
        throw new Error('no throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as Error).message).not.toContain('secret-pw-value');
      }
    }
  });

  it.each(['postgres', 'root', 'notification_migrator'])('refuses the %s database user in production (superuser / schema owner), without echoing the URL', (user) => {
    try {
      loadNotificationConfig({ NODE_ENV: 'production', DATABASE_URL: `postgres://${user}:s3cret-value@db:5432/notification` });
      throw new Error('no throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toMatch(/least-privilege runtime role/);
      expect((e as Error).message).not.toContain('s3cret-value');
    }
  });

  it('allows any database user outside production (tests and local runs use an admin connection)', () => {
    expect(loadNotificationConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://postgres@localhost:5433/n' }).databaseUrl).toContain('postgres@');
  });

  it('accepts registered service callers, and refuses malformed SERVICE_TOKENS without echoing them', () => {
    const { digest } = generateServiceToken();
    expect(loadNotificationConfig(env({ SERVICE_TOKENS: `some-core-service:${digest}` })).serviceTokens).toEqual([{ caller: 'some-core-service', digest }]);
    for (const bad of ['no-colon', 'caller:not-a-digest', `a:${digest},b:${digest}`]) {
      try {
        loadNotificationConfig(env({ SERVICE_TOKENS: bad }));
        throw new Error('no throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as Error).message).not.toContain(digest);
        expect((e as Error).message).not.toContain('not-a-digest');
      }
    }
  });

  it.each([
    ['PORT', ['0', '65536', 'abc', '1.5']],
    ['HTTP_DRAIN_TIMEOUT_MS', ['499', '120001', 'soon']],
    ['NODE_ENV', ['prod', 'staging']],
    ['LOG_LEVEL', ['verbose']],
    ['BODY_LIMIT_KB', ['0', '10241']],
    ['CORS_ORIGINS', ['*', 'https://app.example.com/path', 'ftp://x.example']],
    ['TRUST_PROXY', ['maybe']],
  ])('refuses an invalid %s (fail closed)', (name, values) => {
    for (const v of values) expect(() => loadNotificationConfig(env({ [name]: v })), `${name}=${v}`).toThrow(ConfigError);
  });

  it('HTTP_DRAIN_TIMEOUT_MS has the kit default and bounds (5000, 500-120000)', () => {
    expect(loadNotificationConfig(env({ HTTP_DRAIN_TIMEOUT_MS: '500' })).httpDrainTimeoutMs).toBe(500);
    expect(loadNotificationConfig(env({ HTTP_DRAIN_TIMEOUT_MS: '120000' })).httpDrainTimeoutMs).toBe(120_000);
  });
});
