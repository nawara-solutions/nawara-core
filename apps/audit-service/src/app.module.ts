import { fileURLToPath } from 'node:url';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DbModule, HealthModule, ServiceAuthModule, kitMigrationsDir } from '@nawara/service-kit';
import type { AuditConfig } from './config/audit-config.js';
import { AUDIT_CONFIG } from './config/audit-config.token.js';
import { PersistenceModule } from './persistence/persistence.module.js';

/** The service's own migrations (Stage 18.3: the append-only `audit_record`), applied by the explicit `npm run migrate` step and never at startup. */
export const auditMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

export interface AppModuleOverrides {
  /** Tests point readiness at the migrations they applied. */
  migrationsDirs?: string[];
}

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AuditConfig): DynamicModule {
    return { module: ConfigModule, providers: [{ provide: AUDIT_CONFIG, useValue: config }], exports: [AUDIT_CONFIG] };
  }
}

/**
 * The whole module graph. `main.ts` and the test suites build it through the SAME function, so a test can never pass against a
 * differently wired application than the one that ships.
 *
 * Stage 18.2 (the foundation): the kit's health / readiness / bounded HTTP drain, the kit database (bounded pool and deadlines;
 * readiness `database` + `migrations`; the pool closes last) and service authentication, plus the validated configuration (with the
 * caller policy). Stage 18.3 adds the persistence layer (`PersistenceModule`: the append-only `audit_record` repository). Still absent:
 * the contract and catalog (18.4), the consumer (18.5), any query route (18.6).
 *
 * Deliberately NOT here (ADR-0049): no RabbitMQ yet (the ingestion consumer and its readiness semantics are Stage 18.5), and no call to
 * Auth, Organization or any product service, for any purpose (A36).
 */
@Module({})
export class AppModule {
  static register(config: AuditConfig, overrides: AppModuleOverrides = {}): DynamicModule {
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
          migrations: { dirs: overrides.migrationsDirs ?? [kitMigrationsDir, auditMigrationsDir] },
        }),
        ServiceAuthModule.forRoot(config.serviceTokens),
        ConfigModule.forRoot(config),
        PersistenceModule,
      ],
    };
  }
}
