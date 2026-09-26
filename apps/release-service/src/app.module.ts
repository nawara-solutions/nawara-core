import { fileURLToPath } from 'node:url';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DbModule, HealthModule, kitMigrationsDir } from '@nawara/service-kit';
import type { ReleaseConfig } from './config/release-config.js';
import { RELEASE_CONFIG } from './config/release-config.token.js';
import { PersistenceModule } from './persistence/persistence.module.js';

/** The service's own migrations, applied by the explicit `npm run migrate` step as the migrator and never at startup. */
export const releaseMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

export interface AppModuleOverrides {
  /** Tests point readiness at the migrations they applied. */
  migrationsDirs?: string[];
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
 * `database` + `migrations`; the pool closes last), the validated configuration, and the domain's persistence primitives. There is NO
 * HTTP route besides /health and /ready: registration and publication (CI) are Stage 20.3, owner administration 20.4, the public
 * compatibility read 20.5. The service calls no other service, and nothing in a product's request path calls it.
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
        ConfigModule.forRoot(config),
        PersistenceModule,
      ],
    };
  }
}
