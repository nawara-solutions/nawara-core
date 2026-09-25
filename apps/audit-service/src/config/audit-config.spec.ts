import { describe, expect, it } from 'vitest';
import { ConfigError, generateServiceToken } from '@nawara/service-kit';
import { SERVICE_NAME, loadAuditConfig } from './audit-config.js';

const DB = 'postgres://audit_app:pw-not-real@db:5432/audit';
const MQ = 'amqp://audit_consumer:mq-not-real@broker:5672';
const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ DATABASE_URL: DB, RABBITMQ_URL: MQ, ...over });
const A = generateServiceToken();

describe('audit-service configuration', () => {
  it('has one canonical identity (Stage 18.1, A68), and production is the default environment (the safe behaviour)', () => {
    const c = loadAuditConfig(env());
    expect(SERVICE_NAME).toBe('audit-service');
    expect(c.serviceName).toBe('audit-service');
    expect(c.nodeEnv).toBe('production');
    expect(c.isProduction).toBe(true);
  });

  it('in production needs only the database and the broker; no default opens anything', () => {
    const c = loadAuditConfig(env({ NODE_ENV: 'production' }));
    expect(c.databaseUrl).toBe(DB);
    expect(c.port).toBe(3000);
    expect(c.httpDrainTimeoutMs).toBe(5000);
    expect(c.bodyLimitKb).toBe(100);
    expect(c.corsOrigins).toEqual([]);
    expect(c.trustProxy).toBe(false);
    expect(c.serviceTokens).toEqual([]); // every service-token call refused
    expect(c.callerPolicy.of('anyone')).toBeUndefined();
  });

  it('Stage 18.5: the broker is required and bounded; the queue, prefetch and retry are not settings', () => {
    const c = loadAuditConfig(env());
    expect(c.rabbitmqUrl).toBe(MQ);
    expect(c.rabbitmqConfirmTimeoutMs).toBe(5000);
    expect(c.rabbitmqHeartbeatS).toBe(10);
    expect(() => loadAuditConfig(env({ RABBITMQ_URL: undefined }))).toThrow(ConfigError);
    for (const [name, value] of [['RABBITMQ_URL', 'http://broker:5672'], ['RABBITMQ_URL', 'not a url'], ['RABBITMQ_CONFIRM_TIMEOUT_MS', '50'], ['RABBITMQ_HEARTBEAT_S', '0'], ['RABBITMQ_HEARTBEAT_S', '61']]) {
      let err: unknown;
      try {
        loadAuditConfig(env({ [name]: value }));
      } catch (e) {
        err = e;
      }
      expect(err, `${name}=${value}`).toBeInstanceOf(ConfigError);
      expect(String((err as Error).message)).not.toContain('mq-not-real');
    }
    expect(() => loadAuditConfig(env({ RABBITMQ_URL: 'ftp://audit_consumer:mq-not-real@broker' }))).toThrow(/^(?!.*mq-not-real)/);
  });

  it('carries only what the service uses: no queue, prefetch, retention, query-bound, Auth or Organization setting (later stages / never)', () => {
    const keys = Object.keys(loadAuditConfig(env()));
    for (const later of ['queue', 'prefetch', 'retention', 'retentionDays', 'pageSize', 'queryWindowDays', 'authServiceUrl', 'organizationServiceUrl']) {
      expect(keys).not.toContain(later);
    }
  });

  it('carries the kit database limits with their bounded defaults', () => {
    expect(loadAuditConfig(env()).db).toEqual({ poolMax: 10, connectionTimeoutMs: 5000, statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 60_000, queryTimeoutMs: 35_000 });
    for (const [name, value] of [['DB_POOL_MAX', '0'], ['DB_POOL_MAX', '101'], ['DB_CONNECTION_TIMEOUT_MS', 'soon'], ['DB_STATEMENT_TIMEOUT_MS', '10'], ['DB_QUERY_TIMEOUT_MS', '1000']]) {
      expect(() => loadAuditConfig(env({ [name]: value })), `${name}=${value}`).toThrow(ConfigError);
    }
  });

  it.each([
    ['DATABASE_URL', { DATABASE_URL: '' }],
    ['DATABASE_URL', { DATABASE_URL: 'mysql://audit_app:pw@db/audit' }],
    ['PORT', { PORT: '70000' }],
    ['PORT', { PORT: 'eighty' }],
    ['HTTP_DRAIN_TIMEOUT_MS', { HTTP_DRAIN_TIMEOUT_MS: '10' }],
    ['NODE_ENV', { NODE_ENV: 'staging' }],
    ['LOG_LEVEL', { LOG_LEVEL: 'verbose' }],
    ['BODY_LIMIT_KB', { BODY_LIMIT_KB: '0' }],
    ['CORS_ORIGINS', { CORS_ORIGINS: '*' }],
    ['SERVICE_TOKENS', { SERVICE_TOKENS: 'caller:secret-looking-value-0123' }],
  ])('refuses an invalid %s (fail closed), never echoing the value', (name, over) => {
    try {
      loadAuditConfig(env(over));
      throw new Error('accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain(name);
      expect((e as Error).message).not.toContain('secret-looking-value-0123');
      expect((e as Error).message).not.toContain('pw@db');
    }
  });

  it('production refuses the superuser or a migrator as the runtime database role (a development-only shortcut)', () => {
    for (const user of ['postgres', 'root', 'audit_migrator']) {
      expect(() => loadAuditConfig(env({ NODE_ENV: 'production', DATABASE_URL: `postgres://${user}:pw@db/audit` }))).toThrow(/least-privilege runtime role/);
      expect(loadAuditConfig(env({ NODE_ENV: 'development', DATABASE_URL: `postgres://${user}:pw@db/audit` })).databaseUrl).toContain(user);
    }
    expect(loadAuditConfig(env({ NODE_ENV: 'production', DATABASE_URL: 'postgres://audit_app:pw@db/audit' })).databaseUrl).toContain('audit_app');
  });

  it('a registered caller needs a policy entry; the policy grants exactly what it lists', () => {
    const tokens = { SERVICE_TOKENS: `some-core-service:${A.digest}` };
    expect(() => loadAuditConfig(env(tokens))).toThrow(/AUDIT_SERVICE_POLICY is required/);
    const c = loadAuditConfig(env({ ...tokens, AUDIT_SERVICE_POLICY: JSON.stringify({ callers: { 'some-core-service': { operations: ['read_organization'], categories: ['business'] } } }) }));
    expect(c.callerPolicy.allows('some-core-service', 'read_organization')).toBe(true);
    expect(c.callerPolicy.allows('some-core-service', 'read_platform')).toBe(false);
  });
});
