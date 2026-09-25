import { fileURLToPath } from 'node:url';
import { Global, Logger, Module, type DynamicModule } from '@nestjs/common';
import { DbModule, HealthModule, RabbitMqEventBus, ServiceAuthModule, kitMigrationsDir, type EventBus } from '@nawara/service-kit';
import type { AuditConfig } from './config/audit-config.js';
import { AUDIT_CONFIG } from './config/audit-config.token.js';
import { AUDIT_EVENT_BUS } from './ingestion/audit-consumer.js';
import { AUDIT_EXCHANGE, consumerPrefetch } from './ingestion/ingestion.constants.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { QueryModule } from './query/query.module.js';

/** The service's own migrations (Stage 18.3: the append-only `audit_record`), applied by the explicit `npm run migrate` step and never at startup. */
export const auditMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

export interface AppModuleOverrides {
  /** Tests point readiness at the migrations they applied. */
  migrationsDirs?: string[];
  /** Tests may inject a bus (a kit RabbitMQ bus with test retry options); production builds the kit RabbitMQ bus below. */
  bus?: EventBus;
}

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AuditConfig, bus: EventBus): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: AUDIT_CONFIG, useValue: config }, { provide: AUDIT_EVENT_BUS, useValue: bus }],
      exports: [AUDIT_CONFIG, AUDIT_EVENT_BUS],
    };
  }
}

/**
 * The whole module graph. `main.ts` and the test suites build it through the SAME function, so a test can never pass against a
 * differently wired application than the one that ships.
 *
 * Stage 18.2 (the foundation): the kit's health / readiness / bounded HTTP drain, the kit database (bounded pool and deadlines;
 * readiness `database` + `migrations`; the pool closes last) and service authentication, plus the validated configuration (with the
 * caller policy). Stage 18.3 adds the persistence layer (`PersistenceModule`: the append-only `audit_record` repository). Stage 18.5
 * adds the ingestion (`IngestionModule`): the kit RabbitMQ bus, the consumer on `audit-service.audit` (`audit.#`), readiness `rabbitmq`
 * + `audit-ingestion`. Stage 18.6 adds the reads (`QueryModule`): `GET /audit/organizations/{id}/records` (read_organization) and
 * `GET /audit/platform/records` (read_platform, each page recorded as `platform_query.executed`).
 *
 * Deliberately NOT here (ADR-0049): no call to Auth, Organization or any product service, for any purpose (A36); no HTTP ingestion
 * route (A16: the bus is the only ingestion path).
 */
@Module({})
export class AppModule {
  static register(config: AuditConfig, overrides: AppModuleOverrides = {}): DynamicModule {
    const bus =
      overrides.bus ??
      new RabbitMqEventBus({
        url: config.rabbitmqUrl,
        exchange: AUDIT_EXCHANGE,
        prefetch: consumerPrefetch(config.db.poolMax),
        confirmTimeoutMs: config.rabbitmqConfirmTimeoutMs,
        heartbeatS: config.rabbitmqHeartbeatS,
        // retry: the kit default (3 retries × 5 s through audit-service.audit.retry, then audit-service.audit.dead).
        onNotice: (message, level) => new Logger('RabbitMqEventBus')[level === 'info' ? 'log' : level](message),
      });
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
        ConfigModule.forRoot(config, bus),
        PersistenceModule,
        IngestionModule,
        QueryModule,
      ],
    };
  }
}
