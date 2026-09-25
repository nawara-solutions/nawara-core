import { fileURLToPath } from 'node:url';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DbModule, HealthModule, ServiceAuthModule, kitMigrationsDir, type EventBus } from '@nawara/service-kit';
import type { FileConfig } from './config/file-config.js';
import { FILE_CONFIG } from './config/file-config.token.js';
import { FileAuditModule } from './audit/file-audit.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { StorageModule } from './storage/storage.module.js';
import { DeletionModule } from './deletion/deletion.module.js';
import { DownloadModule } from './download/download.module.js';
import { UploadModule } from './upload/upload.module.js';
import { OpsCounters, OPS_COUNTERS_TOKEN } from './ops/ops-counters.js';
import { OpsModule } from './ops/ops-reporter.js';
import { logObserver } from './storage/storage.module.js';

/** The service's own migrations (Stage 17.3: the `file` and `file_access_ticket` schema), applied by the explicit `npm run migrate` step and never at startup. */
export const fileMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

export interface AppModuleOverrides {
  /** Tests point readiness at the migrations they applied. */
  migrationsDirs?: string[];
  /** TEST FIXTURES ONLY: the event bus the audit relay publishes to (production builds it from RABBITMQ_URL). */
  bus?: EventBus;
}

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: FileConfig, counters: OpsCounters): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: FILE_CONFIG, useValue: config }, { provide: OPS_COUNTERS_TOKEN, useValue: counters }],
      exports: [FILE_CONFIG, OPS_COUNTERS_TOKEN],
    };
  }
}

/**
 * The whole module graph. `main.ts` and the test suites build it through the SAME function, so a test can never pass against a
 * differently wired application than the one that ships.
 *
 * Stage 17.2 (the foundation): the kit's health / readiness / bounded HTTP drain, the kit database (bounded pool and deadlines;
 * readiness `database` + `migrations`; the pool closes last) and service authentication, plus the validated configuration (with the
 * caller policy). Stage 17.3 adds the persistence layer (the `file` and `file_access_ticket` repositories); Stage 17.4 the object
 * store (`STORAGE_PORT`: the configured filesystem or S3-compatible adapter, never a readiness check); Stage 17.5 the upload lifecycle
 * (`UploadModule`: upload tickets, their redemption, service upload, attach); Stage 17.6 the byte-read boundary (`DownloadModule`: owner
 * metadata and content, download tickets, their redemption, ticket revocation); Stage 17.7 deletion and cleanup (`DeletionModule`: the
 * delete route and the bounded cleanup workers: orphan expiry, delete worker, upload-lease sweep, ticket retention).
 *
 * Stage 18.7.4 adds the central audit intent (`FileAuditModule`: `file.deleted`, `file.integrity_incident`) and the kit outbox relay that
 * publishes it to RabbitMQ — the only events this service produces; it consumes none.
 *
 * Deliberately NOT here (ADR-0048): object storage is not a readiness dependency; no call to Auth or to any product service, for any
 * purpose.
 */
@Module({})
export class AppModule {
  static register(config: FileConfig, overrides: AppModuleOverrides = {}): DynamicModule {
    // Stage 17.9: one set of operational counters per process, fed by the storage wrapper, the gates, the limiters and the byte path.
    const counters = new OpsCounters();
    const logStorage = logObserver();
    return {
      module: AppModule,
      imports: [
        HealthModule.forRoot({ httpDrainTimeoutMs: config.httpDrainTimeoutMs }), // Stage 15.5: bounded HTTP drain
        DbModule.forRoot({
          url: config.databaseUrl,
          applicationName: config.serviceName,
          max: config.db.poolMax,
          connectionTimeoutMs: config.db.connectionTimeoutMs,
          statementTimeoutMs: config.db.statementTimeoutMs,
          idleInTransactionTimeoutMs: config.db.idleInTransactionTimeoutMs,
          queryTimeoutMs: config.db.queryTimeoutMs, // Stage 15.2 (I9): client-side deadline for a silent server
          migrations: { dirs: overrides.migrationsDirs ?? [kitMigrationsDir, fileMigrationsDir] },
        }),
        ServiceAuthModule.forRoot(config.serviceTokens),
        ConfigModule.forRoot(config, counters),
        PersistenceModule,
        FileAuditModule.forRoot(config, overrides.bus), // Stage 18.7.4: the central audit intent and the kit relay (the ONE events use)
        StorageModule.forRoot(config.storage, (o) => {
          logStorage(o);
          counters.observeStorage(o);
        }),
        UploadModule,
        DownloadModule,
        DeletionModule,
        OpsModule, // Stage 17.9: the operational snapshot (file_ops_snapshot / file_ops_counters / file_storage_ops)
      ],
    };
  }
}
