/**
 * Provider-neutral storage failures (SDD §4). The API stages map them to client codes (`storage_unavailable` → 503, the rest to a
 * generic 500 or a domain code); a client never sees which provider, bucket, endpoint, path or request id was involved.
 */
export type StorageErrorCode =
  /** No object at the key (a read or head of a missing object). */
  | 'storage_not_found'
  /** `put` to a key that already holds an object: never replaced. */
  | 'storage_already_exists'
  /** The store is unreachable, overloaded or failing (5xx, 429, connection refused / reset, disk full, I/O error): retryable. */
  | 'storage_unavailable'
  /** A bounded deadline passed. For `put` the outcome is unknown (the provider may have committed): `head` tells. */
  | 'storage_timeout'
  /** Configuration or permission (access denied, bad credentials, missing bucket, symlink / foreign object in the root): operator fault. */
  | 'storage_rejected'
  /** A key outside the generator's shape: refused before any I/O (a programming error, never a client input). */
  | 'storage_invalid_key'
  /** The body delivered fewer or more bytes than `sizeBytes`: nothing published. */
  | 'storage_length_mismatch'
  /** The bytes do not match the expected `sha256`: nothing published. */
  | 'storage_checksum_mismatch';

export type StorageOperation = 'put' | 'get' | 'head' | 'delete';

const RETRYABLE: ReadonlySet<StorageErrorCode> = new Set(['storage_unavailable', 'storage_timeout']);

/**
 * The message is the code only. `detail` is a bounded, non-sensitive classification for operators (an errno such as `ENOSPC`, an S3
 * error name such as `NoSuchBucket`); it never holds a path, key, bucket, endpoint, request id, credential or provider text, and the
 * provider's own error is deliberately NOT attached as `cause` (it carries hosts and request ids).
 */
export class StorageError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: StorageErrorCode,
    readonly operation: StorageOperation,
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'StorageError';
    this.retryable = RETRYABLE.has(code);
  }
}

/** A bounded token for `detail`: letters, digits and `_` only, at most 64 characters (anything else is dropped, never echoed). */
export function safeDetail(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : undefined;
}

export const isStorageError = (e: unknown, code?: StorageErrorCode): e is StorageError =>
  e instanceof StorageError && (code === undefined || e.code === code);
