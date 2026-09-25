import { describe, expect, it } from 'vitest';
import { ConfigError, EnvReader } from '@nawara/service-kit';
import { deleteRetryDelaySeconds, loadCleanupConfig } from './cleanup-config.js';

const load = (env: NodeJS.ProcessEnv, storage = { requestTimeoutMs: 10_000, maxAttempts: 3 }) => loadCleanupConfig(new EnvReader(env), storage);

describe('cleanup configuration (Stage 17.7)', () => {
  it('has bounded technical defaults (no legal retention)', () => {
    expect(load({})).toEqual({ enabled: true, intervalMs: 30_000, batchSize: 20, deleteConcurrency: 4, deleteLeaseSeconds: 300, deleteRetryBaseSeconds: 30, deleteRetryMaxSeconds: 3_600, ticketRetentionSeconds: 86_400 });
  });

  it.each([
    ['FILE_CLEANUP_INTERVAL_MS', { FILE_CLEANUP_INTERVAL_MS: '10' }],
    ['FILE_CLEANUP_BATCH_SIZE', { FILE_CLEANUP_BATCH_SIZE: '0' }],
    ['FILE_CLEANUP_BATCH_SIZE', { FILE_CLEANUP_BATCH_SIZE: '100000' }],
    ['FILE_DELETE_CONCURRENCY', { FILE_DELETE_CONCURRENCY: '64' }],
    ['FILE_DELETE_LEASE_SECONDS', { FILE_DELETE_LEASE_SECONDS: '5' }],
    ['FILE_DELETE_RETRY_MAX_SECONDS', { FILE_DELETE_RETRY_BASE_SECONDS: '60', FILE_DELETE_RETRY_MAX_SECONDS: '30' }],
    ['FILE_TICKET_RETENTION_SECONDS', { FILE_TICKET_RETENTION_SECONDS: '60' }],
    ['FILE_CLEANUP_ENABLED', { FILE_CLEANUP_ENABLED: 'yes' }],
  ])('refuses an invalid %s', (name, env) => {
    expect(() => load(env)).toThrow(ConfigError);
    expect(() => load(env)).toThrow(name);
  });

  it('refuses a lease shorter than one pass\'s worst case (a healthy slow pass must not lose its claims)', () => {
    // 20 rows / 4 at once = 5 rounds × 10 s × 3 attempts = 150 s
    expect(() => load({ FILE_DELETE_LEASE_SECONDS: '150' })).toThrow(/worst case \(150 s/);
    expect(load({ FILE_DELETE_LEASE_SECONDS: '151' }).deleteLeaseSeconds).toBe(151);
    expect(() => load({ FILE_CLEANUP_BATCH_SIZE: '500', FILE_DELETE_CONCURRENCY: '1' })).toThrow(/FILE_DELETE_LEASE_SECONDS/);
  });

  it('backs off exponentially from the base to the cap, never below the base nor above the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((a) => deleteRetryDelaySeconds(a, 30, 3_600))).toEqual([30, 60, 120, 240, 480, 960, 1_920, 3_600]);
    expect(deleteRetryDelaySeconds(1_000, 30, 3_600)).toBe(3_600);
    expect(deleteRetryDelaySeconds(0, 30, 3_600)).toBe(30);
  });
});
