import { describe, expect, it } from 'vitest';
import { ConfigError, generateServiceToken } from '@nawara/service-kit';
import { DEFAULT_FILE_MAX_BYTES, FILE_MAX_BYTES_BOUND, SERVICE_NAME, loadFileConfig } from './file-config.js';

const DB = 'postgres://file_app:pw-not-real@db:5432/file';
/** Stage 17.4: a store is required; production accepts only S3 (placeholder values: nothing is contacted at load). */
const S3 = { FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: 'https://objects.example.test', FILE_S3_REGION: 'auto', FILE_S3_BUCKET: 'files-test', FILE_S3_ACCESS_KEY_ID: 'AKIDEXAMPLE', FILE_S3_SECRET_ACCESS_KEY: 'not-a-real-secret-0000' };
/** Stage 17.5: the upload settings (placeholder keys: two different 32-byte values). */
const UPLOAD = { FILE_PUBLIC_BASE_URL: 'https://files.example.test', FILE_REQUEST_HASH_KEY: Buffer.alloc(32, 1).toString('base64'), FILE_RATE_LIMIT_KEY: Buffer.alloc(32, 2).toString('base64') };
const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ DATABASE_URL: DB, ...S3, ...UPLOAD, ...over });
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

  it('carries what is used so far: the store (17.4), the upload lifecycle (17.5); no download-ticket, broker or Auth setting', () => {
    const c = loadFileConfig(env());
    expect(c.storage.provider).toBe('s3');
    expect(c.upload).toMatchObject({ ticketTtlSeconds: 120, attachTtlSeconds: 86_400, idleTimeoutMs: 30_000, ticketFailureLimit: 20, publicBaseUrl: 'https://files.example.test' });
    expect(c.docs.password).toBeUndefined(); // OpenAPI is not mounted by default
    const keys = [...Object.keys(c), ...Object.keys(c.upload)];
    for (const later of ['downloadTicketTtl', 'rabbitmqUrl', 'authServiceUrl']) expect(keys).not.toContain(later);
  });

  it.each([
    ['FILE_PUBLIC_BASE_URL', { FILE_PUBLIC_BASE_URL: undefined }],
    ['FILE_PUBLIC_BASE_URL', { FILE_PUBLIC_BASE_URL: 'http://files.example.test' }], // production requires TLS
    ['FILE_PUBLIC_BASE_URL', { FILE_PUBLIC_BASE_URL: 'https://files.example.test/' }],
    ['FILE_PUBLIC_BASE_URL', { FILE_PUBLIC_BASE_URL: 'https://u:p@files.example.test' }],
    ['FILE_REQUEST_HASH_KEY', { FILE_REQUEST_HASH_KEY: undefined }],
    ['FILE_REQUEST_HASH_KEY', { FILE_REQUEST_HASH_KEY: Buffer.alloc(16, 1).toString('base64') }],
    ['FILE_REQUEST_HASH_KEY', { FILE_REQUEST_HASH_KEY: 'not base64!!' }],
    ['FILE_RATE_LIMIT_KEY', { FILE_RATE_LIMIT_KEY: undefined }],
    ['FILE_RATE_LIMIT_KEY', { FILE_RATE_LIMIT_KEY: Buffer.alloc(32, 1).toString('base64') }], // the same key as the request hash
    ['FILE_UPLOAD_TICKET_TTL_SECONDS', { FILE_UPLOAD_TICKET_TTL_SECONDS: '30' }], // F16: 60-300 s
    ['FILE_UPLOAD_TICKET_TTL_SECONDS', { FILE_UPLOAD_TICKET_TTL_SECONDS: '301' }],
    ['FILE_ATTACH_TTL_SECONDS', { FILE_ATTACH_TTL_SECONDS: '10' }],
    ['FILE_UPLOAD_IDLE_TIMEOUT_MS', { FILE_UPLOAD_IDLE_TIMEOUT_MS: '0' }],
    ['FILE_TICKET_FAILURE_LIMIT', { FILE_TICKET_FAILURE_LIMIT: '0' }],
    ['SWAGGER_PASSWORD', { SWAGGER_PASSWORD: 'short' }],
  ])('Stage 17.5: refuses an invalid or missing %s, never echoing a value', (name, over) => {
    try {
      loadFileConfig(env(over));
      throw new Error('accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain(name);
      expect((e as Error).message).not.toContain(Buffer.alloc(32, 1).toString('base64'));
    }
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
