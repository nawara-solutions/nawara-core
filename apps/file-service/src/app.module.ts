import { fileURLToPath } from 'node:url';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DbModule, HealthModule, ServiceAuthModule, kitMigrationsDir } from '@nawara/service-kit';
import type { FileConfig } from './config/file-config.js';
import { FILE_CONFIG } from './config/file-config.token.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { StorageModule } from './storage/storage.module.js';
import { DownloadModule } from './download/download.module.js';
import { UploadModule } from './upload/upload.module.js';

/** The service's own migrations (Stage 17.3: the `file` and `file_access_ticket` schema), applied by the explicit `npm run migrate` step and never at startup. */
export const fileMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

export interface AppModuleOverrides {
  /** Tests point readiness at the migrations they applied. */
  migrationsDirs?: string[];
}

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: FileConfig): DynamicModule {
    return { module: ConfigModule, providers: [{ provide: FILE_CONFIG, useValue: config }], exports: [FILE_CONFIG] };
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
 * metadata and content, download tickets, their redemption, ticket revocation). Deletion and cleanup are 17.7.
 *
 * Deliberately NOT here (ADR-0048): object storage is not a readiness dependency; there is no RabbitMQ (events come with Stage 18 /
 * 17.9 through the kit outbox) and no call to Auth or to any product service, for any purpose.
 */
@Module({})
export class AppModule {
  static register(config: FileConfig, overrides: AppModuleOverrides = {}): DynamicModule {
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
        ConfigModule.forRoot(config),
        PersistenceModule,
        StorageModule.forRoot(config.storage),
        UploadModule,
        DownloadModule,
      ],
    };
  }
}
