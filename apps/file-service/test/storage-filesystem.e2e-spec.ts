import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesystemStorage, resolveWithin } from '../src/storage/filesystem-storage.js';
import { bodyOf, code, generated, newKey, peakBufferGrowth, readAll, sha, sig, storageContract } from './support/storage-contract.js';

/**
 * Stage 17.4: the filesystem adapter (development and tests only) on real temporary directories: the StoragePort contract, then
 * what only a local disk can get wrong: containment, symlinks, permissions, temporary files.
 */
describe('filesystem storage (real directories)', () => {
  let base: string;
  let root: string;
  let storage: FilesystemStorage;
  const make = (over: Partial<ConstructorParameters<typeof FilesystemStorage>[0]> = {}) =>
    new FilesystemStorage({ root, requestTimeoutMs: 10_000, minThroughputBytesPerSecond: 65_536, ...over });
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'file-storage-'));
    root = join(base, 'root');
    storage = make();
  });
  const outsiders: string[] = [];
  /** A directory OUTSIDE the root (a symlink target); removed after the suite even if a test fails midway. */
  const outsideDir = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    outsiders.push(d);
    return d;
  };
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
    for (const d of outsiders) rmSync(d, { recursive: true, force: true });
  });

  storageContract(() => ({ storage, shortDeadline: make({ requestTimeoutMs: 1_000, minThroughputBytesPerSecond: 1_024 }) }));

  it('lays an object out at exactly <root>/<key> (0600, directories 0700); the temporary area is empty afterwards', async () => {
    const key = newKey();
    await storage.put(key, bodyOf(randomBytes(10)), { sizeBytes: 10, contentType: 'application/pdf', signal: sig() });
    const path = join(root, key);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(root, '.tmp'))).toEqual([]);
  });

  it('leaves no temporary file behind after a failed, short, aborted or duplicate write', async () => {
    const key = newKey();
    await storage.put(key, bodyOf(randomBytes(5)), { sizeBytes: 5, contentType: 'x', signal: sig() });
    await storage.put(key, bodyOf(randomBytes(5)), { sizeBytes: 5, contentType: 'x', signal: sig() }).catch(() => undefined);
    await storage.put(newKey(), bodyOf(randomBytes(5)), { sizeBytes: 50, contentType: 'x', signal: sig() }).catch(() => undefined);
    const ac = new AbortController();
    ac.abort();
    await storage.put(newKey(), bodyOf(randomBytes(5)), { sizeBytes: 5, contentType: 'x', signal: ac.signal }).catch(() => undefined);
    expect(readdirSync(join(root, '.tmp'))).toEqual([]);
  });

  it('the containment check refuses every escape independently of the key grammar', () => {
    const real = '/srv/storage';
    for (const bad of ['../secret', '../../etc/passwd', '/absolute/path', 'foo/../../../bar', '..', '.', '']) {
      expect(code((() => { try { return resolveWithin(real, bad, 'get'); } catch (e) { return e; } })()), bad).toBe('storage_invalid_key');
    }
    expect(resolveWithin(real, 'files/a/b', 'get')).toBe('/srv/storage/files/a/b');
    expect(resolveWithin(real, '%2e%2e/x', 'get')).toBe('/srv/storage/%2e%2e/x'); // encodings are literal names, never decoded
  });

  it('never follows a symlinked directory out of the root (write, read, head, delete)', async () => {
    const outside = outsideDir('file-storage-outside-');
    const escapeRoot = join(base, 'root-symlinked-prefix');
    mkdirSync(escapeRoot, { mode: 0o700 });
    symlinkSync(outside, join(escapeRoot, 'files')); // the key prefix directory points outside
    const s = new FilesystemStorage({ root: escapeRoot, requestTimeoutMs: 10_000, minThroughputBytesPerSecond: 65_536 });
    const key = newKey();
    expect(code(await s.put(key, bodyOf(randomBytes(10)), { sizeBytes: 10, contentType: 'x', signal: sig() }).catch((e: unknown) => e))).toBe('storage_rejected');
    expect(readdirSync(outside)).toEqual([]); // nothing was written outside
    mkdirSync(join(outside, key.split('/')[1]!), { recursive: true });
    writeFileSync(join(outside, key.split('/').slice(1).join('/')), 'outside secret');
    expect(code(await s.get(key, { signal: sig() }).catch((e: unknown) => e))).toBe('storage_rejected');
    expect(code(await s.head(key, { signal: sig() }).catch((e: unknown) => e))).toBe('storage_rejected');
    expect(code(await s.delete(key, { signal: sig() }).catch((e: unknown) => e))).toBe('storage_rejected');
    expect(readFileSync(join(outside, key.split('/').slice(1).join('/')), 'utf8')).toBe('outside secret');
  });

  it('never follows a symlink placed at an object key: read refused; delete removes the link, not its target', async () => {
    const secret = join(base, 'target-secret.txt');
    writeFileSync(secret, 'do not serve me');
    const key = newKey();
    mkdirSync(join(root, dirname(key)), { recursive: true, mode: 0o700 });
    symlinkSync(secret, join(root, key));
    expect(code(await storage.get(key, { signal: sig() }).catch((e: unknown) => e))).toBe('storage_rejected');
    expect(code(await storage.head(key, { signal: sig() }).catch((e: unknown) => e))).toBe('storage_rejected');
    expect(code(await storage.put(key, bodyOf(randomBytes(3)), { sizeBytes: 3, contentType: 'x', signal: sig() }).catch((e: unknown) => e))).toBe('storage_already_exists');
    await storage.delete(key, { signal: sig() });
    expect(existsSync(join(root, key))).toBe(false);
    expect(readFileSync(secret, 'utf8')).toBe('do not serve me');
  });

  it('refuses a symlinked temporary area', async () => {
    const other = join(base, 'root-symlinked-tmp');
    const outside = outsideDir('file-storage-tmp-outside-');
    mkdirSync(other, { mode: 0o700 });
    symlinkSync(outside, join(other, '.tmp'));
    const s = new FilesystemStorage({ root: other, requestTimeoutMs: 10_000, minThroughputBytesPerSecond: 65_536 });
    expect(code(await s.put(newKey(), bodyOf(randomBytes(10)), { sizeBytes: 10, contentType: 'x', signal: sig() }).catch((e: unknown) => e))).toBe('storage_rejected');
    expect(readdirSync(outside)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('a permission failure is `storage_rejected` (operator fault), with the errno only', async () => {
    const locked = join(base, 'root-locked');
    mkdirSync(join(locked, 'files'), { recursive: true, mode: 0o700 });
    chmodSync(join(locked, 'files'), 0o500);
    const s = new FilesystemStorage({ root: locked, requestTimeoutMs: 10_000, minThroughputBytesPerSecond: 65_536 });
    const e = await s.put(newKey(), bodyOf(randomBytes(10)), { sizeBytes: 10, contentType: 'x', signal: sig() }).catch((x: unknown) => x);
    expect(code(e)).toBe('storage_rejected');
    expect((e as { detail?: string }).detail).toBe('EACCES');
    expect(JSON.stringify(e) + String(e)).not.toContain(locked);
    chmodSync(join(locked, 'files'), 0o700);
  });

  it('creates a missing root (0700) on first use, and nothing at construction', async () => {
    const lazy = join(base, 'lazy', 'nested');
    const s = new FilesystemStorage({ root: lazy, requestTimeoutMs: 10_000, minThroughputBytesPerSecond: 65_536 });
    expect(existsSync(lazy)).toBe(false);
    expect(await s.head(newKey(), { signal: sig() })).toBeUndefined();
    expect(statSync(lazy).mode & 0o777).toBe(0o700);
  });

  it('large stream: 48 MiB in and out without buffering the object (bounded memory, exact digest)', async () => {
    const size = 48 * 1024 * 1024;
    const key = newKey();
    const src = generated(size);
    const inGrowth = await peakBufferGrowth(() => storage.put(key, src.body, { sizeBytes: size, contentType: 'application/pdf', signal: sig() }));
    let outDigest = '';
    const outGrowth = await peakBufferGrowth(async () => {
      const got = await storage.get(key, { signal: sig() });
      const h = (await import('node:crypto')).createHash('sha256');
      for await (const c of got.body) h.update(c as Buffer);
      outDigest = h.digest('hex');
    });
    expect(outDigest).toBe(src.digest());
    // Relative to the object: a buffering implementation holds ≥ 1 × size; fast sampling in one process is noisy (up to ~20 MiB seen).
    expect(inGrowth).toBeLessThan(0.75 * size);
    expect(outGrowth).toBeLessThan(0.75 * size);
  }, 60_000);

  it('reads back through a slow consumer with backpressure (the stream is not drained ahead)', async () => {
    const data = randomBytes(4 * 1024 * 1024);
    const key = newKey();
    await storage.put(key, bodyOf(data), { sizeBytes: data.length, contentType: 'application/pdf', signal: sig() });
    const got = await storage.get(key, { signal: sig() });
    const first = await new Promise<Buffer>((r) => got.body.once('data', r));
    got.body.pause();
    await new Promise((r) => setTimeout(r, 100));
    expect(got.body.readableLength).toBeLessThan(1024 * 1024); // paused: only stream buffers are held, not the object
    got.body.resume();
    const rest = await readAll(got.body);
    expect(sha(Buffer.concat([first, rest]))).toBe(sha(data));
  });

  it('writes nothing derived from anything but the key (no name, type or organization on disk)', async () => {
    const key = newKey();
    await storage.put(key, Readable.from([Buffer.from('x')]), { sizeBytes: 1, contentType: 'application/pdf', signal: sig() });
    const entries = readdirSync(join(root, dirname(key)));
    expect(entries).toEqual([key.split('/')[2]]);
  });
});
