import { describe, expect, it } from 'vitest';
import { ConfigError, generateServiceToken } from '@nawara/service-kit';
import { SERVICE_NAME, loadNotificationConfig } from './notification-config.js';

describe('notification-service configuration (Stage 16.3)', () => {
  it('has one canonical identity, and production is the default environment (the safe behaviour)', () => {
    const c = loadNotificationConfig({});
    expect(SERVICE_NAME).toBe('notification-service');
    expect(c.serviceName).toBe('notification-service');
    expect(c.nodeEnv).toBe('production');
    expect(c.isProduction).toBe(true);
  });

  it('boots in production with nothing but defaults: no mandatory setting exists yet, and no default opens anything', () => {
    const c = loadNotificationConfig({ NODE_ENV: 'production' });
    expect(c.port).toBe(3000);
    expect(c.httpDrainTimeoutMs).toBe(5000);
    expect(c.corsOrigins).toEqual([]);
    expect(c.trustProxy).toBe(false);
    expect(c.serviceTokens).toEqual([]); // every service-token call refused
  });

  it('carries only the foundation settings: no database, broker, policy, key ring or provider configuration yet', () => {
    const keys = Object.keys(loadNotificationConfig({}));
    for (const later of ['databaseUrl', 'rabbitmqUrl', 'servicePolicy', 'secretKeys', 'docs']) expect(keys).not.toContain(later);
  });

  it('accepts registered service callers, and refuses malformed SERVICE_TOKENS without echoing them', () => {
    const { digest } = generateServiceToken();
    expect(loadNotificationConfig({ SERVICE_TOKENS: `some-core-service:${digest}` }).serviceTokens).toEqual([{ caller: 'some-core-service', digest }]);
    for (const bad of ['no-colon', 'caller:not-a-digest', `a:${digest},b:${digest}`]) {
      try {
        loadNotificationConfig({ SERVICE_TOKENS: bad });
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
    for (const v of values) expect(() => loadNotificationConfig({ [name]: v }), `${name}=${v}`).toThrow(ConfigError);
  });

  it('HTTP_DRAIN_TIMEOUT_MS has the kit default and bounds (5000, 500-120000)', () => {
    expect(loadNotificationConfig({ HTTP_DRAIN_TIMEOUT_MS: '500' }).httpDrainTimeoutMs).toBe(500);
    expect(loadNotificationConfig({ HTTP_DRAIN_TIMEOUT_MS: '120000' }).httpDrainTimeoutMs).toBe(120_000);
  });
});
