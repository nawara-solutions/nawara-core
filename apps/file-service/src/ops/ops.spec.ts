import { describe, expect, it } from 'vitest';
import { downloadDeadlineMs } from '../download/download.service.js';
import { OPS_COUNTERS, OpsCounters } from './ops-counters.js';

describe('operational counters (Stage 17.9)', () => {
  it('a gate admits exactly `max` at once; a release is idempotent and returns the slot', () => {
    const c = new OpsCounters();
    const slots = Array.from({ length: 5 }, () => c.tryEnter('download', 3));
    expect(slots.filter(Boolean)).toHaveLength(3);
    expect(c.gauges().downloadsInFlight).toBe(3);
    slots[0]!();
    slots[0]!(); // twice: still one slot back, never a negative gauge or a free extra slot
    expect(c.gauges().downloadsInFlight).toBe(2);
    expect(c.tryEnter('download', 3)).toBeDefined();
    expect(c.tryEnter('download', 3)).toBeUndefined();
    expect(c.gauges().uploadsInFlight).toBe(0); // the two gates are independent
  });

  it('drain returns every counter name (zeros included) and resets the interval; gauges are live, not drained', () => {
    const c = new OpsCounters();
    c.bump('upload_busy');
    c.bump('upload_busy');
    c.bump('integrity_digest_mismatch');
    c.tryEnter('upload', 10);
    const first = c.drain();
    expect(Object.keys(first.counts)).toEqual([...OPS_COUNTERS]);
    expect(first.counts.upload_busy).toBe(2);
    expect(first.counts.integrity_digest_mismatch).toBe(1);
    expect(c.drain().counts.upload_busy).toBe(0);
    expect(c.gauges().uploadsInFlight).toBe(1);
  });

  it('storage statistics are keyed by operation and a BOUNDED outcome: anything unexpected folds into `other`', () => {
    const c = new OpsCounters();
    c.observeStorage({ operation: 'get', provider: 's3', outcome: 'ok', durationMs: 10 });
    c.observeStorage({ operation: 'get', provider: 's3', outcome: 'ok', durationMs: 30 });
    c.observeStorage({ operation: 'delete', provider: 's3', outcome: 'storage_unavailable', durationMs: 5 });
    for (const hostile of ['files/abc/123', 'https://bucket.example', 'ok\nforged', `storage_${'x'.repeat(60)}`]) {
      c.observeStorage({ operation: 'put', provider: 's3', outcome: hostile, durationMs: 1 });
    }
    const { storage } = c.drain();
    expect(Object.fromEntries(storage)).toEqual({
      'delete.storage_unavailable': { count: 1, sumMs: 5, maxMs: 5 },
      'get.ok': { count: 2, sumMs: 40, maxMs: 30 },
      'put.other': { count: 4, sumMs: 4, maxMs: 1 },
    });
  });
});

describe('download whole-transfer deadline (Stage 17.9)', () => {
  it('is the request timeout plus the size at the minimum throughput', () => {
    expect(downloadDeadlineMs(0, 10_000, 16_384)).toBe(10_000);
    expect(downloadDeadlineMs(25 * 1024 * 1024, 10_000, 16_384)).toBe(10_000 + 1_600_000); // 25 MiB at 16 KiB/s: 26 min 40 s
    expect(downloadDeadlineMs(1, 10_000, 16_384)).toBe(10_001); // rounded up, never 0 extra
  });
});

describe('silent-socket bound (Stage 17.9)', () => {
  it('is the headers timeout, or one full database wait when that is longer, plus a grace', async () => {
    const { silentSocketTimeoutMs, SILENT_SOCKET_GRACE_MS } = await import('../upload/http-server.js');
    const cfg = (connectionTimeoutMs: number, queryTimeoutMs: number) => ({ db: { connectionTimeoutMs, queryTimeoutMs } }) as unknown as Parameters<typeof silentSocketTimeoutMs>[1];
    expect(silentSocketTimeoutMs(60_000, cfg(5_000, 35_000))).toBe(60_000 + SILENT_SOCKET_GRACE_MS); // the defaults: 65 s
    expect(silentSocketTimeoutMs(60_000, cfg(10_000, 125_000))).toBe(135_000 + SILENT_SOCKET_GRACE_MS); // a long statement timeout wins
  });
});
