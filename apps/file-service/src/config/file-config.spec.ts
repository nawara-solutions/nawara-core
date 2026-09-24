import { describe, expect, it } from 'vitest';
import { ConfigError, generateServiceToken } from '@nawara/service-kit';
import { DEFAULT_FILE_MAX_BYTES, FILE_MAX_BYTES_BOUND, SERVICE_NAME, loadFileConfig } from './file-config.js';

const DB = 'postgres://file_app:pw-not-real@db:5432/file';
/** Stage 17.4: a store is required; production accepts only S3 (placeholder values: nothing is contacted at load). */
const S3 = { FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: 'https://objects.example.test', FILE_S3_REGION: 'auto', FILE_S3_BUCKET: 'files-test', FILE_S3_ACCESS_KEY_ID: 'AKIDEXAMPLE', FILE_S3_SECRET_ACCESS_KEY: 'not-a-real-secret-0000' };
const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ DATABASE_URL: DB, ...S3, ...over });
const A = generateServiceToken();

describe('file-service configuration', () => {
  it('has one canonical identity, and production is the default environment (the safe behaviour)', () => {
    const c = loadFileConfig(env());
    expect(SERVICE_NAME).toBe('file-service');
    expect(c.serviceName).toBe('file-service');
    expect(c.nodeEnv).toBe('production');
    expect(c.isProduction).toBe(true);
  });

  it('in production needs the database and a store; no default opens anything', () => {
    const c = loadFileConfig(env({ NODE_ENV: 'production' }));
    expect(c.databaseUrl).toBe(DB);
    expect(c.port).toBe(3000);
    expect(c.httpDrainTimeoutMs).toBe(5000);
    expect(c.corsOrigins).toEqual([]);
    expect(c.trustProxy).toBe(false);
    expect(c.serviceTokens).toEqual([]); // every service-token call refused
    expect(c.callerPolicy.of('anyone')).toBeUndefined();
  });

  it('carries only what is used so far: the store (17.4), no ticket, attach-window, request-hash, broker or Auth setting (later stages)', () => {
    const c = loadFileConfig(env());
    expect(c.storage.provider).toBe('s3');
    const keys = Object.keys(c);
    for (const later of ['ticketTtl', 'attachTtl', 'requestHashKey', 'rabbitmqUrl', 'authServiceUrl', 'docs']) expect(keys).not.toContain(later);
  });

  it('carries the kit database limits with their bounded defaults', () => {
    expect(loadFileConfig(env()).db).toEqual({ poolMax: 10, connectionTimeoutMs: 5000, statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 60_000, queryTimeoutMs: 35_000 });
    expect(() => loadFileConfig(env({ DB_POOL_MAX: '0' }))).toThrow(ConfigError);
  });

  it('FILE_MAX_BYTES: 25 MiB by default, bounded 1 byte to 100 MiB', () => {
    expect(DEFAULT_FILE_MAX_BYTES).toBe(26_214_400);
    expect(FILE_MAX_BYTES_BOUND).toBe(104_857_600);
    expect(loadFileConfig(env()).maxBytes).toBe(26_214_400);
    expect(loadFileConfig(env({ FILE_MAX_BYTES: '104857600' })).maxBytes).toBe(104_857_600);
    for (const bad of ['0', '104857601', '1.5', 'lots']) expect(() => loadFileConfig(env({ FILE_MAX_BYTES: bad })), bad).toThrow(/FILE_MAX_BYTES/);
  });

  it.each([
    ['DATABASE_URL', { DATABASE_URL: '' }],
    ['DATABASE_URL', { DATABASE_URL: 'mysql://file_app:pw@db/file' }],
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
      loadFileConfig(env(over));
      throw new Error('accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain(name);
      expect((e as Error).message).not.toContain('secret-looking-value-0123');
      expect((e as Error).message).not.toContain('pw@db');
    }
  });

  it('production refuses the superuser or a migrator as the runtime database role (a development-only shortcut)', () => {
    for (const user of ['postgres', 'root', 'file_migrator']) {
      expect(() => loadFileConfig(env({ NODE_ENV: 'production', DATABASE_URL: `postgres://${user}:pw@db/file` }))).toThrow(/least-privilege runtime role/);
      expect(loadFileConfig(env({ NODE_ENV: 'development', DATABASE_URL: `postgres://${user}:pw@db/file` })).databaseUrl).toContain(user);
    }
  });

  it('a registered caller needs a policy entry, and the policy is validated against FILE_MAX_BYTES', () => {
    const tokens = { SERVICE_TOKENS: `some-core-service:${A.digest}` };
    expect(() => loadFileConfig(env(tokens))).toThrow(/FILE_SERVICE_POLICY is required/);
    const policy = (maxBytes: number) => JSON.stringify({ callers: { 'some-core-service': { operations: ['upload'], organizations: 'request', mediaTypes: ['application/pdf'], maxBytes } } });
    expect(loadFileConfig(env({ ...tokens, FILE_SERVICE_POLICY: policy(1000) })).callerPolicy.allows('some-core-service', 'upload')).toBe(true);
    expect(() => loadFileConfig(env({ ...tokens, FILE_MAX_BYTES: '1000', FILE_SERVICE_POLICY: policy(1001) }))).toThrow(/maxBytes/);
  });
});
