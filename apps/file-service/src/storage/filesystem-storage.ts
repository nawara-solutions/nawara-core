import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readlink, realpath, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isStorageKey } from '../persistence/storage-key.js';
import { safeDetail, StorageError, type StorageOperation } from './storage-error.js';
import type { StoragePort, StoragePutOptions, StorageReadOptions, StoredObject, StoredObjectStream } from './storage.port.js';
import { Deadline, neutralStream, putDeadlineMs, VerifiedBody } from './streams.js';

export interface FilesystemStorageOptions {
  /** An absolute directory (FILE_STORAGE_ROOT); created 0700 if missing. Development and tests only: refused in production. */
  root: string;
  /** The base of a write's whole-transfer deadline (FILE_STORAGE_REQUEST_TIMEOUT_MS). */
  requestTimeoutMs: number;
  /** A write must progress at least this fast (FILE_STORAGE_MIN_THROUGHPUT_BYTES_PER_SECOND). */
  minThroughputBytesPerSecond: number;
}

/** Temporary writes live here, beside the objects (same filesystem, so `link` is atomic). No key can name it: keys have no dot. */
const TEMP_DIR = '.tmp';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } = constants;

const NOT_FOUND = new Set(['ENOENT', 'ENOTDIR']);
/** Operator faults: permissions, a read-only disk, a symlink or a foreign entry in the root, a root on another filesystem. */
const REJECTED = new Set(['EACCES', 'EPERM', 'EROFS', 'ELOOP', 'EXDEV', 'EISDIR', 'ENAMETOOLONG']);

/** Maps a filesystem error to the neutral model: the errno name is kept as a bounded detail, the path and message never. */
export function filesystemError(e: unknown, operation: StorageOperation): StorageError {
  if (e instanceof StorageError) return e;
  const code = (e as { code?: unknown })?.code;
  const detail = safeDetail(code);
  if (typeof code === 'string' && NOT_FOUND.has(code)) return new StorageError('storage_not_found', operation, detail);
  if (code === 'EEXIST') return new StorageError('storage_already_exists', operation, detail);
  if (typeof code === 'string' && REJECTED.has(code)) return new StorageError('storage_rejected', operation, detail);
  return new StorageError('storage_unavailable', operation, detail); // ENOSPC, EDQUOT, EIO, EMFILE, EAGAIN, EBUSY, …
}

/**
 * The absolute path of `key` under the (already resolved) root, refusing anything that would land outside it. Keys are checked
 * against the generator's grammar first (no dot, no leading slash, no backslash), so a traversal cannot even be written; this
 * containment check is the second, independent barrier.
 */
export function resolveWithin(realRoot: string, key: string, operation: StorageOperation): string {
  const target = resolve(realRoot, key);
  if (!target.startsWith(realRoot + sep)) throw new StorageError('storage_invalid_key', operation, 'outside_root');
  return target;
}

/**
 * `StoragePort` on a local directory (SDD §4, F7): development and focused tests. Layout: `<root>/<key>` (the key's own directories,
 * mode 0700; objects 0600), temporary writes in `<root>/.tmp/<random>.part`.
 *
 * Safety: keys are validated and contained (above); every directory on a key's path is checked with `lstat` and refused if it is a
 * symlink or not a directory; objects are opened with `O_NOFOLLOW`, and on Linux the opened descriptor's real path is re-checked
 * against the root (`/proc/self/fd`), which closes the gap between the check and the open for reads and for the temporary file. A
 * write goes to a fresh temporary file (`O_EXCL`, fsync on close) and is published with `link()`, which is atomic and fails if the
 * key exists (never `rename`, which would replace it). Residual (documented): Node has no `openat`/`RESOLVE_BENEATH`, so someone who
 * can write inside the root could swap a key's directory for a symlink between the check and the final `link` / `unlink`. The root
 * must be owned by the service user and writable by nobody else; this adapter is refused in production.
 */
export class FilesystemStorage implements StoragePort {
  readonly provider = 'filesystem' as const;
  private rootReady: Promise<string> | undefined;

  constructor(private readonly options: FilesystemStorageOptions) {}

  async put(key: string, body: Readable, opts: StoragePutOptions): Promise<void> {
    checkKey(key, 'put');
    checkSize(opts.sizeBytes);
    opts.signal.throwIfAborted();
    const deadline = new Deadline(opts.signal, putDeadlineMs(opts.sizeBytes, this.options.requestTimeoutMs, this.options.minThroughputBytesPerSecond));
    let bodyError: unknown;
    body.once('error', (e) => {
      bodyError ??= e;
    });
    let temp: string | undefined;
    let handle: FileHandle | undefined;
    try {
      const root = await this.root('put');
      const target = resolveWithin(root, key, 'put');
      await this.directories(root, dirname(key), true, 'put');
      await this.directories(root, TEMP_DIR, true, 'put');
      temp = join(root, TEMP_DIR, `${randomBytes(16).toString('hex')}.part`);
      handle = await open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE);
      await confine(handle, root, 'put');
      await pipeline(body, new VerifiedBody(opts.sizeBytes, opts.sha256), handle.createWriteStream({ flush: true }), { signal: deadline.signal });
      handle = undefined; // closed (after fsync) by the write stream
      await link(temp, target); // atomic publish; EEXIST: an object is never replaced
    } catch (e) {
      throw deadline.outcome('put') ?? bodyError ?? filesystemError(e, 'put');
    } finally {
      deadline.release();
      await handle?.close().catch(() => undefined);
      if (temp) await unlink(temp).catch(() => undefined); // the temporary name never outlives the call (published or not)
    }
  }

  async get(key: string, opts: StorageReadOptions): Promise<StoredObjectStream> {
    const { handle, sizeBytes } = await this.openObject(key, 'get', opts.signal);
    if (!handle) throw new StorageError('storage_not_found', 'get');
    const source = handle.createReadStream();
    return { sizeBytes, body: neutralStream(source, (e) => filesystemError(e, 'get'), opts.signal) };
  }

  async head(key: string, opts: StorageReadOptions): Promise<StoredObject | undefined> {
    const { handle, sizeBytes } = await this.openObject(key, 'head', opts.signal);
    if (!handle) return undefined;
    await handle.close();
    return { sizeBytes };
  }

  async delete(key: string, opts: StorageReadOptions): Promise<void> {
    checkKey(key, 'delete');
    opts.signal.throwIfAborted();
    const root = await this.root('delete');
    const target = resolveWithin(root, key, 'delete');
    try {
      await this.directories(root, dirname(key), false, 'delete');
      const entry = await lstat(target);
      if (entry.isDirectory()) throw new StorageError('storage_rejected', 'delete', 'not_a_file');
      await unlink(target); // a symlink placed at a key is removed itself, never followed
    } catch (e) {
      const err = filesystemError(e, 'delete');
      if (err.code === 'storage_not_found') return; // idempotent: already absent
      throw err;
    }
    await rmdir(dirname(target)).catch(() => undefined); // the file's own directory, when now empty
  }

  /** Opens an object for reading (confined, no symlink); `handle` is undefined when there is no object. */
  private async openObject(key: string, operation: StorageOperation, signal: AbortSignal): Promise<{ handle?: FileHandle; sizeBytes: number }> {
    checkKey(key, operation);
    signal.throwIfAborted();
    const root = await this.root(operation);
    const target = resolveWithin(root, key, operation);
    let handle: FileHandle | undefined;
    try {
      await this.directories(root, dirname(key), false, operation);
      handle = await open(target, O_RDONLY | O_NOFOLLOW);
      await confine(handle, root, operation);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new StorageError('storage_rejected', operation, 'not_a_file');
      return { handle, sizeBytes: stat.size };
    } catch (e) {
      await handle?.close().catch(() => undefined);
      const err = filesystemError(e, operation);
      if (err.code === 'storage_not_found') return { sizeBytes: 0 };
      throw err;
    }
  }

  /** Walks (and optionally creates, 0700) each directory of `relative` under the root, refusing a symlink or a non-directory. */
  private async directories(root: string, relative: string, create: boolean, operation: StorageOperation): Promise<void> {
    let current = root;
    for (const part of relative.split('/')) {
      current = join(current, part);
      if (create) await mkdir(current, { mode: DIR_MODE }).catch((e: { code?: string }) => (e.code === 'EEXIST' ? undefined : Promise.reject(e)));
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new StorageError('storage_rejected', operation, 'not_a_directory');
    }
  }

  /** The root's real path, resolved once (created 0700 if missing); a failure is retried on the next call. */
  private root(operation: StorageOperation): Promise<string> {
    this.rootReady ??= (async () => {
      await mkdir(this.options.root, { recursive: true, mode: DIR_MODE });
      return realpath(this.options.root);
    })();
    return this.rootReady.catch((e: unknown) => {
      this.rootReady = undefined;
      throw filesystemError(e, operation);
    });
  }
}

function checkKey(key: string, operation: StorageOperation): void {
  if (typeof key !== 'string' || !isStorageKey(key)) throw new StorageError('storage_invalid_key', operation);
}

function checkSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new StorageError('storage_length_mismatch', 'put', 'invalid_size');
}

/** Linux: the descriptor's real location must be inside the root (defeats a symlink swapped in after the checks). Elsewhere: no-op. */
async function confine(handle: FileHandle, root: string, operation: StorageOperation): Promise<void> {
  let actual: string;
  try {
    actual = await readlink(`/proc/self/fd/${handle.fd}`);
  } catch {
    return;
  }
  if (!actual.startsWith(root + sep)) throw new StorageError('storage_rejected', operation, 'outside_root');
}
