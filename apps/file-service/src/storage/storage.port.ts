import type { Readable } from 'node:stream';

/** The stable provider names recorded in `file.storageProvider` and used as a bounded log label (never an endpoint or a bucket). */
export type StorageProviderName = 'filesystem' | 's3';

export interface StoragePutOptions {
  /** The exact number of bytes the body will deliver (the upload's `Content-Length`). A body that ends early or runs over is refused. */
  sizeBytes: number;
  /** The verified media type (17.5). Sent to the provider for transport only: PostgreSQL stays the metadata authority. */
  contentType: string;
  /**
   * Optional lowercase hex SHA-256 the bytes must have (a client `Content-Digest`, 17.5). When given, the object is published only if
   * the bytes match; File Service still computes its own digest while streaming (17.5): this is the provider's second check (F12).
   */
  sha256?: string;
  /** Cancels the operation (a client disconnect, 17.5): the write stops and nothing is published. */
  signal: AbortSignal;
}

export interface StorageReadOptions {
  signal: AbortSignal;
}

export interface StoredObject {
  /** The object's size as the store reports it (PostgreSQL's `sizeBytes` is the authority; a disagreement is an inconsistency). */
  sizeBytes: number;
}

export interface StoredObjectStream extends StoredObject {
  /** The bytes, streamed with backpressure; never buffered whole. A failure mid-stream is a `StorageError` on the stream. */
  body: Readable;
}

/**
 * The byte store behind File Service (ADR-0048 §4, SDD §4): immutable objects under server-generated keys (`newStorageKey`, 17.3).
 * Nothing here knows a file id, an owner, an organization, a ticket or a user; authorization happens before a key reaches the port.
 *
 * Semantics every adapter implements identically (one contract test suite runs against all of them):
 * - `put` publishes a complete object or nothing: a failed, aborted, short, long or checksum-mismatched write leaves no object at the
 *   key. An existing object is never replaced (`storage_already_exists`): the same key always means the same bytes.
 * - `get` streams an existing object (`storage_not_found` otherwise).
 * - `head` reports an object's size, or `undefined` when there is none.
 * - `delete` is idempotent: a missing object is success.
 * - Keys outside the generator's shape are refused before any I/O (`storage_invalid_key`).
 * - Failures are `StorageError`s with provider-neutral codes; a failure of the caller's own body stream rejects with that stream's
 *   error, and an abort through `signal` rejects with the signal's reason, so the caller can tell its side from the store's.
 *
 * There is deliberately no list, copy, rename, public or signed URL, bucket management, ACL, tagging or versioning (SDD §4).
 */
export interface StoragePort {
  readonly provider: StorageProviderName;
  put(key: string, body: Readable, opts: StoragePutOptions): Promise<void>;
  get(key: string, opts: StorageReadOptions): Promise<StoredObjectStream>;
  head(key: string, opts: StorageReadOptions): Promise<StoredObject | undefined>;
  delete(key: string, opts: StorageReadOptions): Promise<void>;
}

/** The DI token under which the configured adapter is provided (selected once, at composition). */
export const STORAGE_PORT = Symbol('STORAGE_PORT');
