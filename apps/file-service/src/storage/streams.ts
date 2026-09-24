import { createHash, type Hash } from 'node:crypto';
import { addAbortSignal, PassThrough, Transform, type Readable, type TransformCallback } from 'node:stream';
import { StorageError, type StorageOperation } from './storage-error.js';

/**
 * Verifies a `put` body on its way to the store: exactly `sizeBytes`, and the expected SHA-256 when one is given.
 *
 * The LAST chunk is held back until the source has ended and been verified. A store considers a body complete once it has received
 * `Content-Length` bytes and may commit it then; releasing the final bytes only after verification means a body that runs over, falls
 * short or has the wrong digest never reaches the store complete, so nothing is published (one chunk of lag, a few KiB: no buffering).
 * A body that runs over fails as soon as it passes the size.
 */
export class VerifiedBody extends Transform {
  private received = 0;
  private held: Buffer | undefined;
  private readonly hash: Hash | undefined;

  constructor(
    private readonly sizeBytes: number,
    private readonly expectedSha256: string | undefined,
  ) {
    super();
    this.hash = expectedSha256 === undefined ? undefined : createHash('sha256');
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.received += chunk.length;
    if (this.received > this.sizeBytes) return done(new StorageError('storage_length_mismatch', 'put'));
    this.hash?.update(chunk);
    const release = this.held;
    this.held = chunk;
    done(null, release);
  }

  override _flush(done: TransformCallback): void {
    if (this.received !== this.sizeBytes) return done(new StorageError('storage_length_mismatch', 'put'));
    if (this.hash && this.hash.digest('hex') !== this.expectedSha256) return done(new StorageError('storage_checksum_mismatch', 'put'));
    done(null, this.held);
  }
}

/**
 * Re-exposes a provider's read stream so that every failure on it (a reset socket, an idle timeout, an I/O error) arrives as a
 * provider-neutral `StorageError`, and an abort through `signal` destroys it (and the provider stream behind it). Backpressure is the
 * plain `pipe` backpressure: nothing is read ahead beyond the stream buffers.
 */
export function neutralStream(source: Readable, toStorageError: (e: unknown) => StorageError, signal: AbortSignal): Readable {
  const out = new PassThrough();
  source.on('error', (e) => out.destroy(toStorageError(e)));
  out.on('close', () => {
    if (!source.destroyed) source.destroy();
  });
  source.pipe(out);
  addAbortSignal(signal, out);
  return out;
}

/**
 * One deadline for one operation, combined with the caller's signal; tells which of the two ended it. `release()` disarms it: a read's
 * deadline covers the request up to its first byte only, so it must not keep a handle on the stream that follows (the caller's own
 * signal still cancels that stream).
 */
export class Deadline {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private expired = false;
  private readonly onCallerAbort = () => this.controller.abort(this.caller.reason);

  constructor(
    private readonly caller: AbortSignal,
    ms: number,
  ) {
    this.timer = setTimeout(() => {
      this.expired = true;
      this.controller.abort(new StorageError('storage_timeout', 'put', 'deadline'));
    }, ms);
    this.timer.unref();
    caller.addEventListener('abort', this.onCallerAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  release(): void {
    clearTimeout(this.timer);
    this.caller.removeEventListener('abort', this.onCallerAbort);
  }

  /** The caller's own abort (rethrown as is), or our deadline (a `storage_timeout`), or neither. */
  outcome(operation: StorageOperation): unknown {
    if (this.caller.aborted) return this.caller.reason;
    if (this.expired) return new StorageError('storage_timeout', operation, 'deadline');
    return undefined;
  }
}

/** The whole-transfer bound of a `put` (SDD §15): a base for the request plus the size at a minimum throughput. */
export function putDeadlineMs(sizeBytes: number, baseMs: number, minBytesPerSecond: number): number {
  return baseMs + Math.ceil((sizeBytes / minBytesPerSecond) * 1000);
}
