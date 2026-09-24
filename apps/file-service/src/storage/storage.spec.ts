import { createHash } from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { filesystemError } from './filesystem-storage.js';
import { ObservedStorage, type StorageObservation } from './observed-storage.js';
import { s3Error } from './s3-storage.js';
import { StorageError } from './storage-error.js';
import type { StoragePort } from './storage.port.js';
import { Deadline, neutralStream, putDeadlineMs, VerifiedBody } from './streams.js';

/** What a store "receives": every chunk the verifier releases, in order. */
async function released(chunks: Buffer[], size: number, sha?: string): Promise<{ bytes: number; error?: unknown }> {
  let bytes = 0;
  const sink = new Writable({ write(c: Buffer, _e, done) { bytes += c.length; done(); } });
  try {
    await pipeline(Readable.from(chunks), new VerifiedBody(size, sha), sink);
    return { bytes };
  } catch (error) {
    return { bytes, error };
  }
}

describe('VerifiedBody: a store never receives a complete body unless it is exactly right', () => {
  const a = Buffer.alloc(1000, 1);
  const b = Buffer.alloc(24, 2);
  const digest = createHash('sha256').update(Buffer.concat([a, b])).digest('hex');

  it('passes an exact body through, in order', async () => {
    expect(await released([a, b], 1024, digest)).toEqual({ bytes: 1024 });
    expect(await released([], 0)).toEqual({ bytes: 0 });
  });

  it('a short body: refused at the end, and the store never got the last chunk (so never a complete body)', async () => {
    const r = await released([a], 1024);
    expect((r.error as StorageError).code).toBe('storage_length_mismatch');
    expect(r.bytes).toBe(0);
  });

  it('a long body: refused as soon as it passes the size, before the store has sizeBytes', async () => {
    const r = await released([Buffer.alloc(1024), Buffer.alloc(10)], 1024);
    expect((r.error as StorageError).code).toBe('storage_length_mismatch');
    expect(r.bytes).toBeLessThan(1024); // the exact-size prefix was never completed downstream
  });

  it('a wrong digest: refused before the last bytes are released', async () => {
    const r = await released([a, b], 1024, '0'.repeat(64));
    expect((r.error as StorageError).code).toBe('storage_checksum_mismatch');
    expect(r.bytes).toBeLessThan(1024);
  });
});

describe('error normalization: provider-neutral codes, bounded details, no leak', () => {
  const s3 = (name: string, status?: number, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`${name} at https://bucket-secret.objects.example.test/files/x req-id RID123`), { name, $metadata: { httpStatusCode: status, requestId: 'RID123' }, ...extra });

  it.each([
    [s3('NoSuchKey', 404), 'storage_not_found'],
    [s3('NotFound', 404), 'storage_not_found'],
    [s3('NoSuchBucket', 404), 'storage_rejected'],
    [s3('PreconditionFailed', 412), 'storage_already_exists'],
    [s3('ConditionalRequestConflict', 409), 'storage_already_exists'],
    [s3('AccessDenied', 403), 'storage_rejected'],
    [s3('InvalidAccessKeyId', 403), 'storage_rejected'],
    [s3('SignatureDoesNotMatch', 403), 'storage_rejected'],
    [s3('BadDigest', 400), 'storage_checksum_mismatch'],
    [s3('IncompleteBody', 400), 'storage_length_mismatch'],
    [s3('InternalError', 500), 'storage_unavailable'],
    [s3('ServiceUnavailable', 503), 'storage_unavailable'],
    [s3('SlowDown', 503), 'storage_unavailable'],
    [s3('TooManyRequests', 429), 'storage_unavailable'],
    [s3('TimeoutError'), 'storage_timeout'],
    [Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }), 'storage_unavailable'],
    [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'storage_unavailable'],
    [Object.assign(new Error('getaddrinfo ENOTFOUND bucket.example'), { code: 'ENOTFOUND' }), 'storage_unavailable'],
    [new Error('something odd'), 'storage_unavailable'],
  ])('S3 %s → %s', (e, code) => {
    const err = s3Error(e, 'get');
    expect(err).toBeInstanceOf(StorageError);
    expect(err.code).toBe(code);
    const visible = `${err.message} ${err.detail ?? ''} ${JSON.stringify(err)} ${String(err.stack).split('\n')[0]}`;
    for (const leak of ['bucket-secret', 'example.test', 'RID123', 'req-id', '10.0.0.1']) expect(visible).not.toContain(leak);
    expect(err.cause).toBeUndefined();
  });

  it.each([
    ['ENOENT', 'storage_not_found'], ['ENOTDIR', 'storage_not_found'], ['EEXIST', 'storage_already_exists'],
    ['EACCES', 'storage_rejected'], ['EPERM', 'storage_rejected'], ['EROFS', 'storage_rejected'], ['ELOOP', 'storage_rejected'],
    ['ENOSPC', 'storage_unavailable'], ['EDQUOT', 'storage_unavailable'], ['EIO', 'storage_unavailable'], ['EMFILE', 'storage_unavailable'],
  ])('filesystem %s → %s (the errno kept as the only detail; no path)', (code, expected) => {
    const e = Object.assign(new Error(`${code}: no space left on device, open '/srv/secret-layout/files/abc'`), { code, path: '/srv/secret-layout/files/abc' });
    const err = filesystemError(e, 'put');
    expect(err.code).toBe(expected);
    expect(err.detail).toBe(code);
    expect(`${err.message} ${JSON.stringify(err)}`).not.toContain('secret-layout');
  });

  it('retryable is exactly unavailable and timeout', () => {
    expect(new StorageError('storage_unavailable', 'get').retryable).toBe(true);
    expect(new StorageError('storage_timeout', 'put').retryable).toBe(true);
    for (const c of ['storage_not_found', 'storage_already_exists', 'storage_rejected', 'storage_invalid_key'] as const) expect(new StorageError(c, 'get').retryable).toBe(false);
  });
});

describe('stream plumbing', () => {
  it('a provider stream failure arrives as a StorageError; an abort destroys the provider stream', async () => {
    const source = new PassThrough();
    const out = neutralStream(source, (e) => s3Error(e, 'get'), new AbortController().signal);
    const failed = new Promise((resolve) => out.once('error', resolve));
    source.destroy(Object.assign(new Error('read ECONNRESET 10.1.2.3'), { code: 'ECONNRESET' }));
    expect(((await failed) as StorageError).code).toBe('storage_unavailable');

    const source2 = new PassThrough();
    const ac = new AbortController();
    const out2 = neutralStream(source2, (e) => s3Error(e, 'get'), ac.signal);
    out2.on('error', () => undefined);
    ac.abort();
    await new Promise((r) => setImmediate(r));
    expect(out2.destroyed).toBe(true);
    expect(source2.destroyed).toBe(true);
  });

  it('a deadline tells its own expiry from the caller\'s abort, and release() disarms it', async () => {
    const caller = new AbortController();
    const d = new Deadline(caller.signal, 20);
    await new Promise((r) => setTimeout(r, 40));
    expect((d.outcome('head') as StorageError).code).toBe('storage_timeout');
    const d2 = new Deadline(caller.signal, 10_000);
    const reason = new Error('client went away');
    caller.abort(reason);
    expect(d2.outcome('put')).toBe(reason);
    const d3 = new Deadline(new AbortController().signal, 20);
    d3.release();
    await new Promise((r) => setTimeout(r, 40));
    expect(d3.signal.aborted).toBe(false);
  });

  it('the whole-transfer bound grows with size at the minimum throughput', () => {
    expect(putDeadlineMs(0, 10_000, 65_536)).toBe(10_000);
    expect(putDeadlineMs(26_214_400, 10_000, 65_536)).toBe(410_000); // 25 MiB at 64 KiB/s + 10 s
  });
});

describe('ObservedStorage: bounded observations, never a key', () => {
  const key = 'files/2b1f1c2e-6d7a-4a39-9c43-2c8f1f7d9a10/0123456789abcdef0123456789abcdef';
  const fake = (fail?: unknown): StoragePort => ({
    provider: 's3',
    put: async () => { if (fail) throw fail; },
    get: async () => { throw fail ?? new Error('unused'); },
    head: async () => (fail ? Promise.reject(fail) : { sizeBytes: 7 }),
    delete: async () => undefined,
  });

  it('reports operation, provider, outcome, duration and bytes, and nothing identifying', async () => {
    const seen: StorageObservation[] = [];
    const s = new ObservedStorage(fake(), (o) => seen.push(o));
    await s.put(key, Readable.from([]), { sizeBytes: 0, contentType: 'application/pdf', signal: new AbortController().signal });
    await s.head(key, { signal: new AbortController().signal });
    const failing = new ObservedStorage(fake(new StorageError('storage_unavailable', 'head', 'ENOSPC')), (o) => seen.push(o));
    await expect(failing.head(key, { signal: new AbortController().signal })).rejects.toThrow('storage_unavailable');
    expect(seen.map((o) => [o.operation, o.provider, o.outcome, o.bytes, o.detail])).toEqual([
      ['put', 's3', 'ok', 0, undefined], ['head', 's3', 'ok', 7, undefined], ['head', 's3', 'storage_unavailable', undefined, 'ENOSPC'],
    ]);
    expect(JSON.stringify(seen)).not.toContain('2b1f1c2e');
  });

  it('an observer failure never changes the outcome', async () => {
    const s = new ObservedStorage(fake(), () => { throw new Error('metrics down'); });
    await expect(s.head(key, { signal: new AbortController().signal })).resolves.toEqual({ sizeBytes: 7 });
  });
});
