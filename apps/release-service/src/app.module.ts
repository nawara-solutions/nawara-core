import { fileURLToPath } from 'node:url';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DbModule, HealthModule, ServiceAuthModule, kitMigrationsDir, type EventBus } from '@nawara/service-kit';
import { ReleaseAuditModule } from './audit/release-audit.js';
import { AdminModule } from './admin/admin.module.js';
import { AutomationModule } from './automation/automation.module.js';
import type { ReleaseConfig } from './config/release-config.js';
import { RELEASE_CONFIG } from './config/release-config.token.js';
import { PersistenceModule } from './persistence/persistence.module.js';

/** The service's own migrations, applied by the explicit `npm run migrate` step as the migrator and never at startup. */
export const releaseMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

export interface AppModuleOverrides {
  /** Tests point readiness at the migrations they applied. */
  migrationsDirs?: string[];
  /** TEST FIXTURES ONLY: the event bus the audit relay publishes to (production builds it from RABBITMQ_URL). */
  bus?: EventBus;
}

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: ReleaseConfig): DynamicModule {
    return { module: ConfigModule, providers: [{ provide: RELEASE_CONFIG, useValue: config }], exports: [RELEASE_CONFIG] };
  }
}

/**
 * The whole module graph. `main.ts` and the test suites build it through the SAME function, so a test can never pass against a
 * differently wired application than the one that ships.
 *
 * Stage 20.2 (ADR-0051): the kit's health / readiness / bounded HTTP drain, the kit database (bounded pool and deadlines; readiness
 * `database` + `migrations`; the pool closes last), the validated configuration, and the domain's persistence primitives.
 *
 * Stage 20.3: service authentication (ADR-0033), the central audit intent and the kit outbox relay that publishes it (`ReleaseAuditModule`:
 * `release.registered`, `release.published`; the only events this service produces, it consumes none), and the CI automation API
 * (`AutomationModule`: registration and publication, per-product policy).
 *
 * Stage 20.4: owner administration (`AdminModule`, only when configured): withdrawal and minimum-version changes by the verified owner of
 * the operating Company with a factor step-up. Its Auth client is the ONLY call to another service (Auth, with the human's own bearer). The
 * public compatibility read is 20.5. Nothing in a product's request path calls this service.
 */
@Module({})
export class AppModule {
  static register(config: ReleaseConfig, overrides: AppModuleOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HealthModule.forRoot({ httpDrainTimeoutMs: config.httpDrainTimeoutMs }),
        DbModule.forRoot({
          url: config.databaseUrl,
          applicationName: config.serviceName,
          max: config.db.poolMax,
          connectionTimeoutMs: config.db.connectionTimeoutMs,
          statementTimeoutMs: config.db.statementTimeoutMs,
          idleInTransactionTimeoutMs: config.db.idleInTransactionTimeoutMs,
          queryTimeoutMs: config.db.queryTimeoutMs,
          migrations: { dirs: overrides.migrationsDirs ?? [kitMigrationsDir, releaseMigrationsDir] },
        }),
        ServiceAuthModule.forRoot(config.serviceTokens),
        ConfigModule.forRoot(config),
        PersistenceModule,
        ReleaseAuditModule.forRoot(config, overrides.bus), // Stage 20.3: the audit intent and the kit relay (the ONE events use)
        AutomationModule, // Stage 20.3: CI registration and publication
        AdminModule.register(config), // Stage 20.4: owner withdrawal and minimum-version changes (only when owner administration is configured)
      ],
    };
  }
}
