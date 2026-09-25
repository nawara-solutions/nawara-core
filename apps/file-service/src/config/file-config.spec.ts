import { randomBytes } from 'node:crypto';
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
    expect(c.upload).toMatchObject({ ticketTtlSeconds: 120, attachTtlSeconds: 86_400, idleTimeoutMs: 30_000, ticketFailureLimit: 20, publicBaseUrl: 'https://files.example.test',
      downloadTicketTtlSeconds: 120, downloadIdleTimeoutMs: 30_000 }); // Stage 17.6 defaults
    expect(c.docs.password).toBeUndefined(); // OpenAPI is not mounted by default
    const keys = [...Object.keys(c), ...Object.keys(c.upload)];
    for (const later of ['rabbitmqUrl', 'authServiceUrl']) expect(keys).not.toContain(later);
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
    ['FILE_DOWNLOAD_TICKET_TTL_SECONDS', { FILE_DOWNLOAD_TICKET_TTL_SECONDS: '59' }], // F16: 60-300 s
    ['FILE_DOWNLOAD_TICKET_TTL_SECONDS', { FILE_DOWNLOAD_TICKET_TTL_SECONDS: '301' }],
    ['FILE_DOWNLOAD_IDLE_TIMEOUT_MS', { FILE_DOWNLOAD_IDLE_TIMEOUT_MS: '999999' }],
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
  it('Stage 17.8 (F32): usage limits have bounded defaults; an organization budget above its caller budget refuses to boot', () => {
    expect(loadFileConfig(env()).limits).toEqual({
      perCaller: { upload: 600, ticket: 1_200, download: 1_200 },
      perOrganization: { upload: 120, ticket: 300, download: 300 },
      ticketMaxDownloads: 50,
      uploadMaxInFlight: 64,
      downloadMaxInFlight: 64,
    });
    expect(() => loadFileConfig(env({ FILE_TICKET_RATE_PER_CALLER: '10', FILE_TICKET_RATE_PER_ORGANIZATION: '11' }))).toThrow(/FILE_TICKET_RATE_PER_ORGANIZATION must not exceed/);
    for (const bad of [{ FILE_UPLOAD_RATE_PER_CALLER: '0' }, { FILE_DOWNLOAD_RATE_PER_ORGANIZATION: 'lots' }, { FILE_TICKET_MAX_DOWNLOADS: '0' }, { FILE_TICKET_MAX_DOWNLOADS: '10001' }]) {
      expect(() => loadFileConfig(env(bad))).toThrow(ConfigError);
    }
  });
  it('Stage 17.9: operational settings have bounded defaults and refuse out-of-range values', () => {
    const c = loadFileConfig(env());
    expect(c.ops.reportIntervalMs).toBe(60_000);
    expect(c.upload.downloadMinThroughputBytesPerSecond).toBe(16_384);
    expect(c.upload.requestHashPreviousKeys).toEqual([]);
    expect(c.storage.provider === 's3' && c.storage.maxSockets).toBe(96);
    for (const bad of [
      { FILE_OPS_REPORT_INTERVAL_MS: '9999' }, { FILE_OPS_REPORT_INTERVAL_MS: '3600001' }, { FILE_DOWNLOAD_MAX_IN_FLIGHT: '0' }, { FILE_DOWNLOAD_MAX_IN_FLIGHT: '4097' },
      { FILE_DOWNLOAD_MIN_THROUGHPUT_BYTES_PER_SECOND: '1023' }, { FILE_S3_MAX_SOCKETS: '7' }, { FILE_S3_MAX_SOCKETS: '1025' }, { FILE_S3_MAX_SOCKETS: 'many' },
    ]) {
      expect(() => loadFileConfig(env(bad))).toThrow(ConfigError);
    }
  });

  it('Stage 17.9: the byte-path bounds must fit the S3 socket pools (writer: uploads; reader: downloads + deletes + a reserve)', () => {
    expect(() => loadFileConfig(env({ FILE_S3_MAX_SOCKETS: '64', FILE_UPLOAD_MAX_IN_FLIGHT: '65', FILE_DOWNLOAD_MAX_IN_FLIGHT: '8' }))).toThrow(/FILE_UPLOAD_MAX_IN_FLIGHT \(65\) must not exceed FILE_S3_MAX_SOCKETS \(64\)/);
    // 53 + 4 + 8 = 65 > 64; 52 + 4 + 8 = 64 fits exactly.
    expect(() => loadFileConfig(env({ FILE_S3_MAX_SOCKETS: '64', FILE_UPLOAD_MAX_IN_FLIGHT: '64', FILE_DOWNLOAD_MAX_IN_FLIGHT: '53' }))).toThrow(/\(65\) must not exceed FILE_S3_MAX_SOCKETS \(64\)/);
    expect(loadFileConfig(env({ FILE_S3_MAX_SOCKETS: '64', FILE_UPLOAD_MAX_IN_FLIGHT: '64', FILE_DOWNLOAD_MAX_IN_FLIGHT: '52' })).limits.downloadMaxInFlight).toBe(52);
    expect(() => loadFileConfig(env({ FILE_S3_MAX_SOCKETS: '64', FILE_UPLOAD_MAX_IN_FLIGHT: '8', FILE_DOWNLOAD_MAX_IN_FLIGHT: '52', FILE_DELETE_CONCURRENCY: '5' }))).toThrow(/FILE_DELETE_CONCURRENCY/);
    // The filesystem adapter has no socket pool: no such relationship.
    expect(loadFileConfig(env({ NODE_ENV: 'development', FILE_STORAGE_PROVIDER: 'filesystem', FILE_STORAGE_ROOT: '/tmp/x', FILE_DOWNLOAD_MAX_IN_FLIGHT: '4000' })).limits.downloadMaxInFlight).toBe(4000);
  });

  it('Stage 17.9: request-hash key rotation: at most 2 previous keys, each distinct from the current keys', () => {
    const k = () => randomBytes(32).toString('base64');
    expect(loadFileConfig(env({ FILE_REQUEST_HASH_PREVIOUS_KEYS: `${k()},${k()}` })).upload.requestHashPreviousKeys).toHaveLength(2);
    expect(() => loadFileConfig(env({ FILE_REQUEST_HASH_PREVIOUS_KEYS: `${k()},${k()},${k()}` }))).toThrow(/at most 2/);
    expect(() => loadFileConfig(env({ FILE_REQUEST_HASH_PREVIOUS_KEYS: UPLOAD.FILE_REQUEST_HASH_KEY }))).toThrow(/must differ/);
    expect(() => loadFileConfig(env({ FILE_REQUEST_HASH_PREVIOUS_KEYS: UPLOAD.FILE_RATE_LIMIT_KEY }))).toThrow(/must differ/);
    expect(() => loadFileConfig(env({ FILE_REQUEST_HASH_PREVIOUS_KEYS: Buffer.alloc(16, 3).toString('base64') }))).toThrow(/at least 32 bytes/);
  });
  it('Stage 17.9: the store\'s idle bound must exceed the client-side idle bounds (a stalled client is cut by the right timer)', () => {
    expect(() => loadFileConfig(env({ FILE_STORAGE_IDLE_TIMEOUT_MS: '30000' }))).toThrow(/FILE_STORAGE_IDLE_TIMEOUT_MS \(30000\) must exceed/);
    expect(() => loadFileConfig(env({ FILE_STORAGE_IDLE_TIMEOUT_MS: '45000', FILE_DOWNLOAD_IDLE_TIMEOUT_MS: '60000' }))).toThrow(/must exceed/);
    expect(loadFileConfig(env({ FILE_STORAGE_IDLE_TIMEOUT_MS: '30001' })).storage).toMatchObject({ idleTimeoutMs: 30_001 });
    // The filesystem adapter has no socket: no such relationship.
    expect(loadFileConfig(env({ NODE_ENV: 'development', FILE_STORAGE_PROVIDER: 'filesystem', FILE_STORAGE_ROOT: '/tmp/x', FILE_UPLOAD_IDLE_TIMEOUT_MS: '120000' })).upload.idleTimeoutMs).toBe(120_000);
  });
});
