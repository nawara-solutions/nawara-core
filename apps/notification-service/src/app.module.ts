import { fileURLToPath } from 'node:url';
import { Module, type DynamicModule } from '@nestjs/common';
import { DbModule, HealthModule, ServiceAuthModule, kitMigrationsDir } from '@nawara/service-kit';
import type { NotificationConfig } from './config/notification-config.js';

/** The service's own migrations (schema and published templates), applied by the explicit `npm run migrate` step and never at startup. */
export const notificationMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

export interface AppModuleOverrides {
  /** Tests point readiness at the migrations they applied. */
  migrationsDirs?: string[];
}

/**
 * The whole module graph. `main.ts` and the test suites build it through the SAME function, so a test can never pass against a
 * differently wired application than the one that ships.
 *
 * Stage 16.3: the kit's health / readiness / bounded HTTP drain and service authentication. Stage 16.4: the kit database (bounded
 * pool and deadlines; readiness = `database` + `migrations`; the pool closes last at shutdown). There is still no business route, no
 * event consumer (16.5) and no worker (16.7).
 */
@Module({})
export class AppModule {
  static register(config: NotificationConfig, overrides: AppModuleOverrides = {}): DynamicModule {
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
          migrations: { dirs: overrides.migrationsDirs ?? [kitMigrationsDir, notificationMigrationsDir] },
        }),
        ServiceAuthModule.forRoot(config.serviceTokens),
      ],
    };
  }
}
