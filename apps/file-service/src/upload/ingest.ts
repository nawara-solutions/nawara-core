import { createHash } from 'node:crypto';
import { pipeline, Readable, Transform, type TransformCallback } from 'node:stream';
import type { FileMediaType } from '../policy/media-types.js';
import { isStorageError } from '../storage/storage-error.js';
import type { StoragePort } from '../storage/storage.port.js';
import { declaredAgrees, detectMediaType, DETECTION_WINDOW_BYTES, extensionAgrees } from './media-type.js';

/**
 * Why an upload did not complete. `status` is the file's terminal state (`REJECTED`: the content was refused; `FAILED`: the transfer
 * failed), `failureCode` the bounded code stored on the row, `http` what the uploader is told (a stable code, never provider detail).
 */
export interface UploadRefusal {
  status: 'REJECTED' | 'FAILED';
  failureCode: string;
  http: { status: number; code: string; message: string };
}

export class UploadRefused extends Error {
  constructor(readonly refusal: UploadRefusal) {
    super(refusal.failureCode);
    this.name = 'UploadRefused';
  }
}

const refuse = (status: UploadRefusal['status'], failureCode: string, httpStatus: number, code: string, message: string) =>
  new UploadRefused({ status, failureCode, http: { status: httpStatus, code, message } });

export const REFUSALS = {
  tooLarge: () => refuse('REJECTED', 'file_too_large', 413, 'file_too_large', 'The file exceeds the size allowed for this upload.'),
  unsupported: () => refuse('REJECTED', 'unsupported_media_type', 415, 'unsupported_media_type', 'The file type is not accepted.'),
  mismatch: () => refuse('REJECTED', 'media_type_mismatch', 422, 'media_type_mismatch', 'The declared type or file name does not match the content.'),
  checksum: () => refuse('REJECTED', 'checksum_mismatch', 422, 'checksum_mismatch', 'The content does not match the declared digest.'),
  aborted: () => refuse('FAILED', 'client_aborted', 400, 'upload_aborted', 'The upload was interrupted.'),
  idle: () => refuse('FAILED', 'upload_timeout', 408, 'upload_timeout', 'The upload stalled.'),
  incomplete: () => refuse('FAILED', 'upload_incomplete', 400, 'upload_incomplete', 'The upload ended before its declared length.'),
  storageUnavailable: (code: string) => refuse('FAILED', code, 503, 'storage_unavailable', 'File storage is temporarily unavailable.'),
  storageFault: (code: string) => refuse('FAILED', code, 500, 'storage_error', 'The file could not be stored.'),
};

export interface IngestInput {
  /** The untrusted request body, read exactly once, as a stream. */
  body: Readable;
  /** `Content-Length`: required, already checked against `limit` before a byte is read. */
  declaredLength: number;
  /** The effective ceiling: min(FILE_MAX_BYTES, the caller's policy, the ticket). Enforced on the bytes actually received. */
  limit: number;
  /** The types this upload may be: the caller policy (and the ticket) narrowed from the V1 allow-list. */
  allowed: ReadonlySet<FileMediaType>;
  /** The declared `Content-Type` essence: a hint that must agree with the bytes. */
  declaredType?: string;
  /** The sanitized file name: its extension must agree with the bytes. */
  fileName?: string;
  /** A client-declared SHA-256 (`Content-Digest`): enforced by the store before the object is published. */
  expectedSha256?: string;
  storage: StoragePort;
  storageKey: string;
  /** Aborted on a client disconnect or an idle timeout; its reason is an `UploadRefused`. */
  signal: AbortSignal;
}

export interface Accepted {
  mediaType: FileMediaType;
  sizeBytes: number;
  sha256: string;
}

/**
 * Counts and hashes every byte on its way to the store, and refuses the byte that would pass the limit. SHA-256 is computed over
 * exactly the accepted bytes, incrementally (nothing is buffered).
 */
class Meter extends Transform {
  bytes = 0;
  private readonly hash = createHash('sha256');

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) return done(REFUSALS.tooLarge());
    this.hash.update(chunk);
    done(null, chunk);
  }

  digest(): string {
    return this.hash.digest('hex');
  }
}

/**
 * The upload pipeline (Stage 17.5):
 *
 *   request ─► head window (≤ 4 KiB + one chunk) ─► type decided from the bytes ─► Meter (count, limit, SHA-256) ─► StoragePort.put
 *
 * The head is read first because the store needs the (verified) content type before the object is written; it is then replayed
 * ahead of the rest of the stream. Backpressure runs end to end (the request is read only as fast as the store accepts). The store
 * publishes a complete, exactly-sized object or nothing (Stage 17.4), so a refused, aborted or failed upload leaves no object.
 * Bounded memory: the head window plus stream buffers, whatever the file size.
 */
export async function ingest(input: IngestInput): Promise<Accepted> {
  const reader = input.body[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const head: Buffer[] = [];
  let headBytes = 0;
  try {
    while (headBytes < DETECTION_WINDOW_BYTES && headBytes < input.declaredLength) {
      const next = await reader.next();
      if (next.done) break;
      head.push(next.value);
      headBytes += next.value.length;
      if (headBytes > input.limit) throw REFUSALS.tooLarge();
    }
  } catch (e) {
    throw input.signal.aborted ? input.signal.reason : e instanceof UploadRefused ? e : REFUSALS.aborted();
  }

  const detected = detectMediaType(windowOf(head, Math.min(headBytes, DETECTION_WINDOW_BYTES)));
  if (!detected || !input.allowed.has(detected)) throw REFUSALS.unsupported();
  if (!declaredAgrees(input.declaredType, detected) || !extensionAgrees(input.fileName, detected)) throw REFUSALS.mismatch();

  async function* replay(): AsyncGenerator<Buffer> {
    for (const chunk of head) yield chunk;
    head.length = 0;
    for (;;) {
      const next = await reader.next();
      if (next.done) return;
      yield next.value;
    }
  }
  const meter = new Meter(input.limit);
  const body = pipeline(Readable.from(replay()), meter, () => undefined); // a source failure reaches the store as a body error

  try {
    await input.storage.put(input.storageKey, body, {
      sizeBytes: input.declaredLength,
      contentType: detected,
      sha256: input.expectedSha256,
      signal: input.signal,
    });
  } catch (e) {
    throw classify(e, input.signal);
  }
  if (meter.bytes !== input.declaredLength) throw REFUSALS.incomplete(); // unreachable: the store enforces the exact length
  return { mediaType: detected, sizeBytes: meter.bytes, sha256: meter.digest() };
}

/** Copies at most `size` bytes of the head (the detection window): never the whole upload. */
function windowOf(chunks: readonly Buffer[], size: number): Buffer {
  const window = Buffer.alloc(size);
  let at = 0;
  for (const chunk of chunks) {
    if (at >= size) break;
    at += chunk.copy(window, at, 0, Math.min(chunk.length, size - at));
  }
  return window;
}

/** Every failure of the pipeline as ONE refusal (the storage error's provider detail stays in the logs only). */
export function classify(e: unknown, signal: AbortSignal): UploadRefused {
  if (e instanceof UploadRefused) return e;
  if (signal.aborted && signal.reason instanceof UploadRefused) return signal.reason;
  if (isStorageError(e)) {
    switch (e.code) {
      case 'storage_checksum_mismatch':
        return REFUSALS.checksum();
      case 'storage_length_mismatch':
        return REFUSALS.incomplete();
      case 'storage_unavailable':
      case 'storage_timeout':
        return REFUSALS.storageUnavailable(e.code);
      default:
        return REFUSALS.storageFault(e.code); // rejected, invalid key, already exists: an operator fault, never the client's
    }
  }
  return REFUSALS.aborted(); // the request stream itself failed (reset, premature close)
}
