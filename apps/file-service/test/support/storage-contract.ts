import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { newStorageKey } from '../../src/persistence/storage-key.js';
import { isStorageError, type StorageError } from '../../src/storage/storage-error.js';
import type { StoragePort } from '../../src/storage/storage.port.js';

export const newKey = () => newStorageKey('files', randomUUID());
export const sig = () => new AbortController().signal;
export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Test-only: collects a (small) stream to compare bytes. The production paths never do this. */
export async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

/** A body delivered in several chunks, asynchronously (like a network stream). */
export function bodyOf(data: Buffer, chunk = 16 * 1024): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += chunk) parts.push(data.subarray(i, i + chunk));
  return Readable.from(parts);
}

/** A body that delivers `first` bytes, then fails with `error`. */
export function failingBody(first: Buffer, error: Error): Readable {
  const p = new PassThrough();
  p.write(first);
  setTimeout(() => p.destroy(error), 20);
  return p;
}

export const code = (e: unknown) => (isStorageError(e) ? (e as StorageError).code : e);

export interface ContractSetup {
  storage: StoragePort;
  /** The same store with a short write deadline (1 s base, 1 KiB/s): a stalled body must end in `storage_timeout`. */
  shortDeadline: StoragePort;
}

/**
 * The StoragePort contract (Stage 17.4): the SAME behaviour from every adapter, so development and production cannot diverge. Each
 * adapter's suite calls this with its own store.
 */
export function storageContract(setup: () => ContractSetup): void {
  const s = () => setup().storage;

  it('contract: a written object reads back byte for byte (every byte value), with its size', async () => {
    const data = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(1024 * 1024 + 7)]);
    const key = newKey();
    await s().put(key, bodyOf(data), { sizeBytes: data.length, contentType: 'application/pdf', signal: sig() });
    expect(await s().head(key, { signal: sig() })).toEqual({ sizeBytes: data.length });
    const got = await s().get(key, { signal: sig() });
    expect(got.sizeBytes).toBe(data.length);
    expect(sha(await readAll(got.body))).toBe(sha(data));
  });

  it('contract: an empty object is an object', async () => {
    const key = newKey();
    await s().put(key, Readable.from([]), { sizeBytes: 0, contentType: 'application/pdf', signal: sig() });
    expect(await s().head(key, { signal: sig() })).toEqual({ sizeBytes: 0 });
    expect((await readAll((await s().get(key, { signal: sig() })).body)).length).toBe(0);
  });

  it('contract: a missing object is `storage_not_found` to read and `undefined` to head', async () => {
    const key = newKey();
    expect(code(await s().get(key, { signal: sig() }).catch((e: unknown) => e))).toBe('storage_not_found');
    expect(await s().head(key, { signal: sig() })).toBeUndefined();
  });

  it('contract: an existing object is never replaced (`storage_already_exists`); its bytes are unchanged', async () => {
    const key = newKey();
    const first = randomBytes(4096);
    await s().put(key, bodyOf(first), { sizeBytes: first.length, contentType: 'image/png', signal: sig() });
    const second = randomBytes(4096);
    expect(code(await s().put(key, bodyOf(second), { sizeBytes: second.length, contentType: 'image/png', signal: sig() }).catch((e: unknown) => e))).toBe('storage_already_exists');
    expect(sha(await readAll((await s().get(key, { signal: sig() })).body))).toBe(sha(first));
  });

  it('contract: two concurrent writes of one key — exactly one wins', async () => {
    const key = newKey();
    const a = randomBytes(64 * 1024);
    const b = randomBytes(64 * 1024);
    const results = await Promise.allSettled([
      s().put(key, bodyOf(a), { sizeBytes: a.length, contentType: 'image/png', signal: sig() }),
      s().put(key, bodyOf(b), { sizeBytes: b.length, contentType: 'image/png', signal: sig() }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(code((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toBe('storage_already_exists');
    const stored = sha(await readAll((await s().get(key, { signal: sig() })).body));
    expect([sha(a), sha(b)]).toContain(stored);
  });

  it('contract: delete removes the object; deleting a missing object is success (idempotent)', async () => {
    const key = newKey();
    const data = randomBytes(100);
    await s().put(key, bodyOf(data), { sizeBytes: 100, contentType: 'image/jpeg', signal: sig() });
    await s().delete(key, { signal: sig() });
    expect(await s().head(key, { signal: sig() })).toBeUndefined();
    expect(code(await s().get(key, { signal: sig() }).catch((e: unknown) => e))).toBe('storage_not_found');
    await s().delete(key, { signal: sig() });
    await s().delete(newKey(), { signal: sig() });
  });

  it('contract: a failing body rejects with ITS OWN error and publishes nothing; the key stays usable', async () => {
    const key = newKey();
    const boom = new Error('client stream broke');
    const e = await s().put(key, failingBody(randomBytes(20_000), boom), { sizeBytes: 100_000, contentType: 'application/pdf', signal: sig() }).catch((x: unknown) => x);
    expect(e).toBe(boom);
    expect(await s().head(key, { signal: sig() })).toBeUndefined();
    const data = randomBytes(10);
    await s().put(key, bodyOf(data), { sizeBytes: 10, contentType: 'application/pdf', signal: sig() });
    expect(await s().head(key, { signal: sig() })).toEqual({ sizeBytes: 10 });
  });

  it('contract: a body shorter or longer than sizeBytes is `storage_length_mismatch` and publishes nothing', async () => {
    const short = newKey();
    expect(code(await s().put(short, bodyOf(randomBytes(1000)), { sizeBytes: 1024, contentType: 'application/pdf', signal: sig() }).catch((e: unknown) => e))).toBe('storage_length_mismatch');
    expect(await s().head(short, { signal: sig() })).toBeUndefined();
    const long = newKey();
    expect(code(await s().put(long, Readable.from([randomBytes(1024), randomBytes(10)]), { sizeBytes: 1024, contentType: 'application/pdf', signal: sig() }).catch((e: unknown) => e))).toBe('storage_length_mismatch');
    expect(await s().head(long, { signal: sig() })).toBeUndefined();
  });

  it('contract: an expected SHA-256 is enforced: a match is published, a mismatch publishes nothing', async () => {
    const data = randomBytes(50_000);
    const ok = newKey();
    await s().put(ok, bodyOf(data), { sizeBytes: data.length, contentType: 'application/pdf', sha256: sha(data), signal: sig() });
    expect(await s().head(ok, { signal: sig() })).toEqual({ sizeBytes: data.length });
    const bad = newKey();
    expect(code(await s().put(bad, bodyOf(data), { sizeBytes: data.length, contentType: 'application/pdf', sha256: sha(randomBytes(8)), signal: sig() }).catch((e: unknown) => e))).toBe('storage_checksum_mismatch');
    expect(await s().head(bad, { signal: sig() })).toBeUndefined();
  });

  it('contract: an abort during a write rejects with the abort reason and publishes nothing', async () => {
    const key = newKey();
    const ac = new AbortController();
    const body = new PassThrough();
    body.write(randomBytes(10_000));
    const reason = new Error('client disconnected');
    setTimeout(() => ac.abort(reason), 50);
    expect(await s().put(key, body, { sizeBytes: 1_000_000, contentType: 'application/pdf', signal: ac.signal }).catch((e: unknown) => e)).toBe(reason);
    expect(await s().head(key, { signal: sig() })).toBeUndefined();
  });

  it('contract: an already-aborted signal refuses before any I/O', async () => {
    const ac = new AbortController();
    ac.abort(new Error('gone'));
    for (const op of [() => s().head(newKey(), { signal: ac.signal }), () => s().get(newKey(), { signal: ac.signal }), () => s().delete(newKey(), { signal: ac.signal }),
      () => s().put(newKey(), Readable.from([]), { sizeBytes: 0, contentType: 'x', signal: ac.signal })]) {
      await expect(op()).rejects.toThrow('gone');
    }
  });

  it('contract: an abort during a read ends the stream (no hang)', async () => {
    const key = newKey();
    const data = randomBytes(2 * 1024 * 1024);
    await s().put(key, bodyOf(data), { sizeBytes: data.length, contentType: 'application/pdf', signal: sig() });
    const ac = new AbortController();
    const got = await s().get(key, { signal: ac.signal });
    const done = new Promise<unknown>((resolve) => {
      got.body.once('error', resolve);
      got.body.once('close', () => resolve('closed'));
    });
    got.body.once('data', () => ac.abort());
    got.body.resume();
    await done;
    expect(got.body.destroyed).toBe(true);
  });

  it('contract: a stalled write ends in `storage_timeout` at the whole-transfer deadline and publishes nothing', async () => {
    const key = newKey();
    const stalled = new PassThrough();
    stalled.write(randomBytes(100));
    const t0 = Date.now();
    expect(code(await setup().shortDeadline.put(key, stalled, { sizeBytes: 1024, contentType: 'application/pdf', signal: sig() }).catch((e: unknown) => e))).toBe('storage_timeout');
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await s().head(key, { signal: sig() })).toBeUndefined();
  });

  it('contract: a key outside the generator shape is refused before any I/O, for every operation', async () => {
    for (const bad of ['../secret', '../../etc/passwd', '/absolute/path', 'foo/../../../bar', 'files/%2e%2e/x', 'files/passport.pdf', 'FILES/x', '', `files/${randomUUID()}`]) {
      for (const op of [() => s().get(bad, { signal: sig() }), () => s().head(bad, { signal: sig() }), () => s().delete(bad, { signal: sig() }),
        () => s().put(bad, Readable.from([]), { sizeBytes: 0, contentType: 'x', signal: sig() })]) {
        expect(code(await op().catch((e: unknown) => e)), bad).toBe('storage_invalid_key');
      }
    }
  });
}

/** Streams `size` generated bytes (no buffer of the whole) and returns the running digest's result when drained. */
export function generated(size: number, chunk = 64 * 1024): { body: Readable; digest: () => string } {
  const hash = createHash('sha256');
  let sent = 0;
  const block = randomBytes(chunk);
  const body = new Readable({
    read() {
      if (sent >= size) return void this.push(null);
      const n = Math.min(chunk, size - sent);
      const part = Buffer.from(block.subarray(0, n));
      if (n >= 4) part.writeUInt32BE(sent >>> 0, 0); // vary the content per chunk
      hash.update(part);
      sent += n;
      this.push(part);
    },
  });
  return { body, digest: () => hash.digest('hex') };
}

/**
 * Peak growth of LIVE memory outside the V8 heap (ArrayBuffers: where stream chunks live) while `run` executes. Each sample follows a
 * forced collection (`--expose-gc`), so discarded chunks do not count: only what is still held. An implementation that buffers the
 * whole object holds all of it at once.
 */
export async function peakBufferGrowth(run: () => Promise<void>): Promise<number> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error('run with --expose-gc (vitest.config.e2e.ts execArgv)');
  gc();
  const base = process.memoryUsage().arrayBuffers;
  let peak = base;
  const sample = () => {
    gc();
    peak = Math.max(peak, process.memoryUsage().arrayBuffers);
  };
  const timer = setInterval(sample, 20);
  try {
    await run();
  } finally {
    clearInterval(timer);
  }
  return peak - base;
}

/**
 * Stage 17.6 backpressure measure: live ArrayBuffer memory (after forced collections) sampled when a client PAUSES a download and
 * again after it has held the pause. With backpressure the server stops reading the store once the stream buffers are full, so the
 * growth during the pause is ~0 and the level at the pause is small, whatever the file size. A server that reads ahead grows during
 * the pause; one that buffers the object first holds it already at the pause. (Sampling a fast transfer is noisy: client and server
 * share one process, so in-flight chunks pile up during each forced collection.)
 */
export async function liveBytes(): Promise<number> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error('run with --expose-gc (vitest.config.e2e.ts execArgv)');
  gc();
  await new Promise((r) => setImmediate(r)); // let released backing stores be finalized
  gc();
  return process.memoryUsage().arrayBuffers;
}
