import { isAbsolute } from 'node:path';
import { ConfigError, type EnvReader } from '@nawara/service-kit';
import { isStorageKeyPrefix } from '../persistence/storage-key.js';
import type { StorageProviderName } from './storage.port.js';

interface StorageLimits {
  /** Prefix of every new key (`<prefix>/<fileId>/<random>`, SDD §6). */
  keyPrefix: string;
  /** Deadline of head / delete / a read's first byte; the base of a write's whole-transfer deadline. */
  requestTimeoutMs: number;
  /** A write's whole-transfer bound = requestTimeoutMs + size at this throughput (SDD §15). */
  minThroughputBytesPerSecond: number;
}

export interface FilesystemStorageConfig extends StorageLimits {
  provider: 'filesystem';
  root: string;
}

export interface S3StorageConfig extends StorageLimits {
  provider: 's3';
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxAttempts: number;
}

export type StorageConfig = FilesystemStorageConfig | S3StorageConfig;

const PROVIDERS: readonly StorageProviderName[] = ['filesystem', 's3'];
/** S3 bucket naming (the portable subset: lowercase, digits, dots and hyphens, 3–63 characters). */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** A region token (`eu-west-3`, `auto`, `us-east-1`): some providers accept any value, the SDK needs one. */
const REGION = /^[a-z0-9-]{1,32}$/;

/**
 * Storage settings (Stage 17.4). Fail closed: the provider is REQUIRED (no default, no fallback from one provider to another), every
 * value is validated, errors name the variable and never echo a value (credentials may come from `*_FILE`). Nothing here contacts the
 * store: a storage outage never prevents startup and never fails readiness (ADR-0048 §8).
 */
export function loadStorageConfig(reader: EnvReader, isProduction: boolean): StorageConfig {
  const provider = reader.required('FILE_STORAGE_PROVIDER');
  if (!(PROVIDERS as readonly string[]).includes(provider)) throw new ConfigError(`FILE_STORAGE_PROVIDER must be one of: ${PROVIDERS.join(', ')}`);
  const keyPrefix = reader.optional('FILE_STORAGE_KEY_PREFIX', 'files')!;
  if (!isStorageKeyPrefix(keyPrefix)) throw new ConfigError('FILE_STORAGE_KEY_PREFIX must be lowercase letters, digits, "-" and "/"-separated segments (at most 130 characters)');
  const limits: StorageLimits = {
    keyPrefix,
    requestTimeoutMs: reader.int('FILE_STORAGE_REQUEST_TIMEOUT_MS', { default: 10_000, min: 1_000, max: 60_000 }),
    minThroughputBytesPerSecond: reader.int('FILE_STORAGE_MIN_THROUGHPUT_BYTES_PER_SECOND', { default: 65_536, min: 1_024, max: 104_857_600 }),
  };

  if (provider === 'filesystem') {
    // F7: development and tests only. No override exists: production bytes never land on a container's disk.
    if (isProduction) throw new ConfigError('FILE_STORAGE_PROVIDER=filesystem is refused in production (use s3)');
    const root = reader.required('FILE_STORAGE_ROOT');
    if (!isAbsolute(root) || root.includes('\0') || root === '/') throw new ConfigError('FILE_STORAGE_ROOT must be an absolute directory other than /');
    return { provider, root, ...limits };
  }

  const endpoint = reader.url('FILE_S3_ENDPOINT', isProduction ? ['https:'] : ['https:', 'http:']);
  const parsed = new URL(endpoint);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConfigError('FILE_S3_ENDPOINT must be a plain endpoint URL (credentials go in FILE_S3_ACCESS_KEY_ID / FILE_S3_SECRET_ACCESS_KEY)');
  }
  const region = reader.required('FILE_S3_REGION');
  if (!REGION.test(region)) throw new ConfigError('FILE_S3_REGION must be a region token (lowercase letters, digits and "-")');
  const bucket = reader.required('FILE_S3_BUCKET');
  if (!BUCKET.test(bucket) || bucket.includes('..')) throw new ConfigError('FILE_S3_BUCKET must be a valid bucket name');
  return {
    provider: 's3',
    endpoint,
    region,
    bucket,
    accessKeyId: reader.required('FILE_S3_ACCESS_KEY_ID'),
    secretAccessKey: reader.secret('FILE_S3_SECRET_ACCESS_KEY', 16),
    forcePathStyle: reader.bool('FILE_S3_FORCE_PATH_STYLE', false),
    connectTimeoutMs: reader.int('FILE_STORAGE_CONNECT_TIMEOUT_MS', { default: 2_000, min: 100, max: 2_000 }),
    idleTimeoutMs: reader.int('FILE_STORAGE_IDLE_TIMEOUT_MS', { default: 30_000, min: 1_000, max: 120_000 }),
    maxAttempts: reader.int('FILE_STORAGE_MAX_ATTEMPTS', { default: 3, min: 1, max: 5 }),
    ...limits,
  };
}
