import { Inject, Injectable, Logger, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { FilesystemStorage } from './filesystem-storage.js';
import { ObservedStorage, type StorageObserver } from './observed-storage.js';
import { S3Storage } from './s3-storage.js';
import type { StorageConfig } from './storage-config.js';
import { STORAGE_PORT, type StoragePort } from './storage.port.js';

/**
 * The composition boundary: the ONE place that looks at the provider. Everything else receives `StoragePort`. The configuration was
 * validated at boot (an unknown provider never gets here); there is no fallback between providers.
 */
export function createStorage(config: StorageConfig, observe: StorageObserver): { port: StoragePort; close: () => void } {
  switch (config.provider) {
    case 'filesystem': {
      const adapter = new FilesystemStorage(config);
      return { port: new ObservedStorage(adapter, observe), close: () => undefined };
    }
    case 's3': {
      const adapter = new S3Storage(config);
      return { port: new ObservedStorage(adapter, observe), close: () => adapter.close() };
    }
  }
}

/** Storage operations at DEBUG, bounded fields only (never a key, id, bucket, endpoint, path or credential). */
function logObserver(): StorageObserver {
  const logger = new Logger('Storage');
  return (o) => {
    const line = `storage_op op=${o.operation} provider=${o.provider} outcome=${o.outcome} duration_ms=${o.durationMs}${o.bytes === undefined ? '' : ` bytes=${o.bytes}`}${o.detail ? ` detail=${o.detail}` : ''}`;
    if (o.outcome === 'ok' || o.outcome === 'aborted' || o.outcome === 'storage_not_found') logger.debug(line);
    else logger.warn(line);
  };
}

const STORAGE_CLOSE = Symbol('STORAGE_CLOSE');

@Injectable()
class StorageLifecycle implements OnApplicationShutdown {
  constructor(@Inject(STORAGE_CLOSE) private readonly close: () => void) {}

  onApplicationShutdown(): void {
    this.close(); // keep-alive sockets, after the HTTP drain
  }
}

/**
 * Provides `STORAGE_PORT`. Nothing here touches the store at startup, and nothing registers a readiness check: object storage is not a
 * readiness dependency (ADR-0048 §8); an outage fails the byte operations that need it (`storage_unavailable`, 17.5 / 17.6).
 */
@Module({})
export class StorageModule {
  static forRoot(config: StorageConfig, observe: StorageObserver = logObserver()): DynamicModule {
    const storage = createStorage(config, observe);
    return {
      module: StorageModule,
      global: true,
      providers: [{ provide: STORAGE_PORT, useValue: storage.port }, { provide: STORAGE_CLOSE, useValue: storage.close }, StorageLifecycle],
      exports: [STORAGE_PORT],
    };
  }
}
