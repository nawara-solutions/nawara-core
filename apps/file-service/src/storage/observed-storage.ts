import type { Readable } from 'node:stream';
import { isStorageError, type StorageOperation } from './storage-error.js';
import type { StoragePort, StoragePutOptions, StorageProviderName, StorageReadOptions, StoredObject, StoredObjectStream } from './storage.port.js';

/**
 * One storage operation, for logs and future metrics. Bounded labels only: the operation, the provider NAME, the outcome (`ok`, a
 * `storage_*` code, `aborted` for the caller's own abort, `source_error` for a failure of the caller's body stream). Never a key,
 * file id, organization, bucket, endpoint or path.
 */
export interface StorageObservation {
  operation: StorageOperation;
  provider: StorageProviderName;
  outcome: string;
  durationMs: number;
  /** Bytes written (a successful `put`) or reported (`get` / `head`). */
  bytes?: number;
  /** The bounded classification of a failure (`ENOSPC`, `NoSuchBucket`, `deadline`). */
  detail?: string;
}

export type StorageObserver = (o: StorageObservation) => void;

/** Wraps the selected adapter; the domain receives this (as `StoragePort`) and never branches on the provider. */
export class ObservedStorage implements StoragePort {
  readonly provider: StorageProviderName;

  constructor(
    private readonly inner: StoragePort,
    private readonly observe: StorageObserver,
  ) {
    this.provider = inner.provider;
  }

  put(key: string, body: Readable, opts: StoragePutOptions): Promise<void> {
    return this.run('put', () => this.inner.put(key, body, opts), () => opts.sizeBytes, opts.signal, body);
  }

  get(key: string, opts: StorageReadOptions): Promise<StoredObjectStream> {
    return this.run('get', () => this.inner.get(key, opts), (r) => r.sizeBytes, opts.signal);
  }

  head(key: string, opts: StorageReadOptions): Promise<StoredObject | undefined> {
    return this.run('head', () => this.inner.head(key, opts), (r) => r?.sizeBytes, opts.signal);
  }

  delete(key: string, opts: StorageReadOptions): Promise<void> {
    return this.run('delete', () => this.inner.delete(key, opts), () => undefined, opts.signal);
  }

  private async run<T>(operation: StorageOperation, call: () => Promise<T>, bytes: (r: T) => number | undefined, signal: AbortSignal, body?: Readable): Promise<T> {
    const started = performance.now();
    const report = (outcome: string, extra: Partial<StorageObservation> = {}) => {
      try {
        this.observe({ operation, provider: this.provider, outcome, durationMs: Math.round(performance.now() - started), ...extra });
      } catch {
        // an observer failure never changes a storage outcome
      }
    };
    try {
      const result = await call();
      report('ok', { bytes: bytes(result) });
      return result;
    } catch (e) {
      if (isStorageError(e)) report(e.code, { detail: e.detail });
      else if (signal.aborted) report('aborted');
      else if (body?.errored) report('source_error');
      else report('error');
      throw e;
    }
  }
}
