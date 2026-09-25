import { describe, expect, it } from 'vitest';
import { ConfigError, EnvReader } from '@nawara/service-kit';
import { loadStorageConfig } from './storage-config.js';
import { createStorage } from './storage.module.js';

const SECRET = 'super-secret-value-do-not-echo';
const S3 = {
  FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: 'https://objects.example.test', FILE_S3_REGION: 'auto', FILE_S3_BUCKET: 'nawara-files',
  FILE_S3_ACCESS_KEY_ID: 'AKIDEXAMPLE', FILE_S3_SECRET_ACCESS_KEY: SECRET,
};
const FS = { FILE_STORAGE_PROVIDER: 'filesystem', FILE_STORAGE_ROOT: '/var/lib/file-service/storage' };
const load = (env: NodeJS.ProcessEnv, production: boolean, files: Record<string, string> = {}) =>
  loadStorageConfig(new EnvReader(env, (p) => files[p] ?? ''), production);

describe('storage configuration (Stage 17.4)', () => {
  it('requires a provider: no default, no fallback', () => {
    expect(() => load({}, false)).toThrow(/FILE_STORAGE_PROVIDER is required/);
    for (const typo of ['S3', 'local', 'minio', 'r2', 'filesytem', 's3 ']) expect(() => load({ ...S3, FILE_STORAGE_PROVIDER: typo }, true), typo).toThrow(/FILE_STORAGE_PROVIDER must be one of: filesystem, s3/);
  });

  it('refuses the filesystem store in production, with no override, and accepts it elsewhere', () => {
    expect(() => load(FS, true)).toThrow(/refused in production/);
    expect(() => load({ ...FS, FILE_STORAGE_ALLOW_FILESYSTEM_IN_PRODUCTION: 'true', ALLOW_LOCAL_STORAGE: 'true' }, true)).toThrow(/refused in production/);
    expect(load(FS, false)).toMatchObject({ provider: 'filesystem', root: '/var/lib/file-service/storage', keyPrefix: 'files' });
  });

  it.each(['relative/dir', './storage', '/', ''])('refuses the filesystem root %j', (root) => {
    expect(() => load({ ...FS, FILE_STORAGE_ROOT: root }, false)).toThrow(/FILE_STORAGE_ROOT/);
  });

  it('loads S3 with bounded defaults (connect ≤ 2 s, idle 45 s since 17.9, 3 attempts for idempotent operations)', () => {
    expect(load(S3, true)).toEqual({
      provider: 's3', endpoint: 'https://objects.example.test', region: 'auto', bucket: 'nawara-files', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET,
      forcePathStyle: false, connectTimeoutMs: 2_000, idleTimeoutMs: 45_000, maxAttempts: 3, maxSockets: 96, keyPrefix: 'files', requestTimeoutMs: 10_000, minThroughputBytesPerSecond: 65_536,
    });
  });

  it('reads the S3 credentials from mounted secret files (*_FILE)', () => {
    const c = load({ ...S3, FILE_S3_SECRET_ACCESS_KEY: undefined, FILE_S3_SECRET_ACCESS_KEY_FILE: '/run/secrets/s3' }, true, { '/run/secrets/s3': `${SECRET}\n` });
    expect(c).toMatchObject({ secretAccessKey: SECRET });
  });

  it.each([
    ['FILE_S3_ENDPOINT', { FILE_S3_ENDPOINT: undefined }],
    ['FILE_S3_ENDPOINT', { FILE_S3_ENDPOINT: 'http://objects.example.test' }], // production requires TLS
    ['FILE_S3_ENDPOINT', { FILE_S3_ENDPOINT: 'ftp://objects.example.test' }],
    ['FILE_S3_ENDPOINT', { FILE_S3_ENDPOINT: `https://AKIDEXAMPLE:${SECRET}@objects.example.test` }],
    ['FILE_S3_REGION', { FILE_S3_REGION: undefined }],
    ['FILE_S3_REGION', { FILE_S3_REGION: 'EU West' }],
    ['FILE_S3_BUCKET', { FILE_S3_BUCKET: undefined }],
    ['FILE_S3_BUCKET', { FILE_S3_BUCKET: 'Bad_Bucket' }],
    ['FILE_S3_BUCKET', { FILE_S3_BUCKET: 'a..b' }],
    ['FILE_S3_ACCESS_KEY_ID', { FILE_S3_ACCESS_KEY_ID: undefined }],
    ['FILE_S3_SECRET_ACCESS_KEY', { FILE_S3_SECRET_ACCESS_KEY: undefined }],
    ['FILE_S3_SECRET_ACCESS_KEY', { FILE_S3_SECRET_ACCESS_KEY: 'short' }],
    ['FILE_S3_FORCE_PATH_STYLE', { FILE_S3_FORCE_PATH_STYLE: 'yes' }],
    ['FILE_STORAGE_CONNECT_TIMEOUT_MS', { FILE_STORAGE_CONNECT_TIMEOUT_MS: '5000' }], // SDD §15: ≤ 2 s
    ['FILE_STORAGE_IDLE_TIMEOUT_MS', { FILE_STORAGE_IDLE_TIMEOUT_MS: '0' }],
    ['FILE_STORAGE_REQUEST_TIMEOUT_MS', { FILE_STORAGE_REQUEST_TIMEOUT_MS: '600000' }],
    ['FILE_STORAGE_MAX_ATTEMPTS', { FILE_STORAGE_MAX_ATTEMPTS: '10' }],
    ['FILE_STORAGE_MIN_THROUGHPUT_BYTES_PER_SECOND', { FILE_STORAGE_MIN_THROUGHPUT_BYTES_PER_SECOND: '1' }],
    ['FILE_STORAGE_KEY_PREFIX', { FILE_STORAGE_KEY_PREFIX: '../escape' }],
    ['FILE_STORAGE_KEY_PREFIX', { FILE_STORAGE_KEY_PREFIX: 'Files' }],
  ])('refuses an invalid or missing %s in production, never echoing a value', (name, over) => {
    try {
      load({ ...S3, ...over }, true);
      throw new Error('accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain(name);
      expect((e as Error).message).not.toContain(SECRET);
      expect((e as Error).message).not.toContain('AKIDEXAMPLE');
    }
  });

  it('allows a plain-HTTP endpoint (a local S3-compatible test server) outside production only', () => {
    expect(load({ ...S3, FILE_S3_ENDPOINT: 'http://127.0.0.1:9000', FILE_S3_FORCE_PATH_STYLE: 'true' }, false)).toMatchObject({ endpoint: 'http://127.0.0.1:9000', forcePathStyle: true });
  });

  it('selects the adapter once, from the validated configuration (the domain only sees StoragePort)', () => {
    const fs = createStorage(load(FS, false), () => undefined);
    const s3 = createStorage(load(S3, true), () => undefined);
    expect(fs.port.provider).toBe('filesystem');
    expect(s3.port.provider).toBe('s3');
    s3.close();
  });
});
