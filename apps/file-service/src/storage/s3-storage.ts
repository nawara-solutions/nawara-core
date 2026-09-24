import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { isStorageKey } from '../persistence/storage-key.js';
import { safeDetail, StorageError, type StorageOperation } from './storage-error.js';
import type { StoragePort, StoragePutOptions, StorageReadOptions, StoredObject, StoredObjectStream } from './storage.port.js';
import { Deadline, neutralStream, putDeadlineMs, VerifiedBody } from './streams.js';

export interface S3StorageOptions {
  /** The provider's S3 endpoint (FILE_S3_ENDPOINT): always configuration, never a hard-coded host. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing (`<endpoint>/<bucket>/<key>`) for providers that need it (FILE_S3_FORCE_PATH_STYLE). */
  forcePathStyle: boolean;
  /** TCP connect bound (SDD §15: ≤ 2 s). */
  connectTimeoutMs: number;
  /** Socket idle bound: no byte for this long ends the request or the stream (SDD §15: 30 s). */
  idleTimeoutMs: number;
  /** Deadline for head / delete / a read's first byte, and the base of a write's whole-transfer deadline. */
  requestTimeoutMs: number;
  minThroughputBytesPerSecond: number;
  /** Attempts for the idempotent operations (get before the first byte, head, delete). `put` is always ONE attempt. */
  maxAttempts: number;
}

/** The SDK must never write to the console: its messages bypass the service's JSON logs and can carry hosts and request ids. */
const SILENT = { trace: () => undefined, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const NOT_FOUND = new Set(['NoSuchKey', 'NotFound']);
/** Configuration or permission: an operator must act (credentials, bucket, region, endpoint, clock skew). */
const REJECTED = new Set(['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'NoSuchBucket', 'PermanentRedirect',
  'AuthorizationHeaderMalformed', 'InvalidBucketName', 'RequestTimeTooSkewed', 'InvalidRequest', 'MissingContentLength', 'NotImplemented']);
const TIMEOUT = new Set(['TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'ETIMEDOUT']);
const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED']);

/**
 * Maps an SDK / network error to the neutral model. Only the S3 error NAME (a bounded token such as `NoSuchBucket`) survives, as
 * `detail`; the message, request ids, host, bucket and the error object itself are dropped.
 */
export function s3Error(e: unknown, operation: StorageOperation): StorageError {
  if (e instanceof StorageError) return e;
  const err = e as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: number } };
  const name = typeof err?.name === 'string' ? err.name : '';
  const code = typeof err?.code === 'string' ? err.code : '';
  const status = err?.$metadata?.httpStatusCode;
  const detail = safeDetail(name !== 'Error' && name ? name : code);
  if (NOT_FOUND.has(name) || (status === 404 && name !== 'NoSuchBucket')) return new StorageError('storage_not_found', operation, detail);
  if (name === 'PreconditionFailed' || status === 412 || name === 'ConditionalRequestConflict') return new StorageError('storage_already_exists', operation, detail);
  if (name === 'BadDigest' || name === 'XAmzContentSHA256Mismatch') return new StorageError('storage_checksum_mismatch', operation, detail);
  if (name === 'IncompleteBody') return new StorageError('storage_length_mismatch', operation, detail);
  if (TIMEOUT.has(name) || TIMEOUT.has(code)) return new StorageError('storage_timeout', operation, detail);
  if (REJECTED.has(name) || status === 401 || status === 403 || status === 301 || status === 400) return new StorageError('storage_rejected', operation, detail);
  if (NETWORK.has(code) || (status !== undefined && (status >= 500 || status === 429))) return new StorageError('storage_unavailable', operation, detail);
  return new StorageError('storage_unavailable', operation, detail);
}

/**
 * `StoragePort` over the S3 API (SDD §4, F5 / F6): any S3-compatible provider through configuration only (endpoint, region, bucket,
 * addressing). The provider is NOT chosen here (O2 / F6 stay open). It uses PutObject, GetObject, HeadObject and DeleteObject only:
 * no bucket creation, ACL, public or presigned URL, multipart, listing, tagging or versioning. Objects are private (no ACL is ever
 * sent; the bucket's own policy must be private).
 *
 * - `put`: one streamed PutObject with the exact `Content-Length` and `If-None-Match: *` (never replaces an object: 412 →
 *   `storage_already_exists`). A single PUT is atomic on S3: an interrupted request publishes nothing. Never retried (the body is a
 *   one-shot stream), bounded by a whole-transfer deadline.
 * - `get` / `head` / `delete`: retried by the SDK (standard mode, bounded attempts and backoff) until the response starts; a read
 *   is never retried once bytes flow. Delete is idempotent (S3 answers 204 for a missing key).
 * - Checksums: the SDK's automatic request / response checksums are OFF (`WHEN_REQUIRED`): not every S3-compatible provider accepts
 *   them. An expected SHA-256 is verified in the stream before the last bytes are released (`VerifiedBody`); the S3 ETag is never
 *   treated as a digest.
 */
export class S3Storage implements StoragePort {
  readonly provider = 's3' as const;
  private readonly writer: S3Client;
  private readonly reader: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    const handler = () =>
      new NodeHttpHandler({
        connectionTimeout: options.connectTimeoutMs,
        requestTimeout: options.idleTimeoutMs, // the socket idle timeout
        httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 50 }),
        httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 50 }),
      });
    const common = {
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
      logger: SILENT,
    };
    this.writer = new S3Client({ ...common, maxAttempts: 1, requestHandler: handler() });
    this.reader = new S3Client({ ...common, maxAttempts: options.maxAttempts, retryMode: 'standard', requestHandler: handler() });
  }

  async put(key: string, body: Readable, opts: StoragePutOptions): Promise<void> {
    checkKey(key, 'put');
    if (!Number.isSafeInteger(opts.sizeBytes) || opts.sizeBytes < 0) throw new StorageError('storage_length_mismatch', 'put', 'invalid_size');
    opts.signal.throwIfAborted();
    const deadline = new Deadline(opts.signal, putDeadlineMs(opts.sizeBytes, this.options.requestTimeoutMs, this.options.minThroughputBytesPerSecond));
    // A failing body or a refused body (length, digest) must END the request at once: the HTTP client does not abort a request whose
    // body stream errors, it would wait for the missing bytes until the deadline (found by the contract suite, Stage 17.4).
    const failFast = new AbortController();
    let bodyError: unknown;
    body.once('error', (e) => {
      bodyError ??= e;
      failFast.abort(e);
    });
    const verified = new VerifiedBody(opts.sizeBytes, opts.sha256);
    let verifyError: unknown;
    verified.once('error', (e) => {
      verifyError ??= e;
      failFast.abort(e);
    });
    body.pipe(verified);
    body.once('error', (e) => verified.destroy(e as Error));
    try {
      await this.writer.send(
        new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: verified, ContentLength: opts.sizeBytes, ContentType: opts.contentType, IfNoneMatch: '*' }),
        { abortSignal: AbortSignal.any([deadline.signal, failFast.signal]) },
      );
    } catch (e) {
      throw deadline.outcome('put') ?? bodyError ?? verifyError ?? s3Error(e, 'put');
    } finally {
      deadline.release();
      if (!body.destroyed) body.destroy();
    }
  }

  async get(key: string, opts: StorageReadOptions): Promise<StoredObjectStream> {
    checkKey(key, 'get');
    opts.signal.throwIfAborted();
    const deadline = new Deadline(opts.signal, this.options.requestTimeoutMs); // to the first byte only
    try {
      const out = await this.reader.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }), { abortSignal: deadline.signal });
      const source = out.Body as Readable | undefined;
      if (!source || typeof source.pipe !== 'function') throw new StorageError('storage_unavailable', 'get', 'no_body');
      return { sizeBytes: out.ContentLength ?? 0, body: neutralStream(source, (e) => s3Error(e, 'get'), opts.signal) };
    } catch (e) {
      throw deadline.outcome('get') ?? s3Error(e, 'get');
    } finally {
      deadline.release(); // the stream is bounded by the socket idle timeout and the caller's signal from here on
    }
  }

  async head(key: string, opts: StorageReadOptions): Promise<StoredObject | undefined> {
    checkKey(key, 'head');
    opts.signal.throwIfAborted();
    const deadline = new Deadline(opts.signal, this.options.requestTimeoutMs);
    try {
      const out = await this.reader.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }), { abortSignal: deadline.signal });
      return { sizeBytes: out.ContentLength ?? 0 };
    } catch (e) {
      const err = deadline.outcome('head') ?? s3Error(e, 'head');
      if (err instanceof StorageError && err.code === 'storage_not_found') return undefined;
      throw err;
    } finally {
      deadline.release();
    }
  }

  async delete(key: string, opts: StorageReadOptions): Promise<void> {
    checkKey(key, 'delete');
    opts.signal.throwIfAborted();
    const deadline = new Deadline(opts.signal, this.options.requestTimeoutMs);
    try {
      await this.reader.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }), { abortSignal: deadline.signal });
    } catch (e) {
      const err = deadline.outcome('delete') ?? s3Error(e, 'delete');
      if (err instanceof StorageError && err.code === 'storage_not_found') return; // idempotent on every provider
      throw err;
    } finally {
      deadline.release();
    }
  }

  /** Releases the keep-alive sockets (application shutdown). */
  close(): void {
    this.writer.destroy();
    this.reader.destroy();
  }
}

function checkKey(key: string, operation: StorageOperation): void {
  if (typeof key !== 'string' || !isStorageKey(key)) throw new StorageError('storage_invalid_key', operation);
}
