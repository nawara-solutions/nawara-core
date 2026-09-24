import { fileURLToPath } from 'node:url';
import { Global, Logger, Module, type DynamicModule } from '@nestjs/common';
import { DbModule, HealthModule, RabbitMqEventBus, ServiceAuthModule, kitMigrationsDir, type EventBus } from '@nawara/service-kit';
import type { NotificationConfig } from './config/notification-config.js';
import { NOTIFICATION_CONFIG } from './config/notification-config.token.js';
import { INTAKE_EVENT_BUS } from './intake/event-consumer.js';
import { IntakeModule } from './intake/intake.module.js';

/** The service's own migrations (schema and published templates), applied by the explicit `npm run migrate` step and never at startup. */
export const notificationMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

/**
 * Stage 15.8 (the Billing rule): every delivery the consumer handles holds one database client while it is recorded, so the consumer
 * takes at most half of the pool (5 with the default `DB_POOL_MAX` 10, at most 10); the other half stays for HTTP and the workers.
 */
export const consumerPrefetch = (poolMax: number): number => Math.min(10, Math.max(1, Math.floor(poolMax / 2)));

export interface AppModuleOverrides {
  /** Tests point readiness at the migrations they applied. */
  migrationsDirs?: string[];
  /** Tests may inject a bus (the in-memory one, or a RabbitMQ bus with test options); production builds the kit RabbitMQ bus. */
  bus?: EventBus;
}

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: NotificationConfig, bus: EventBus): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: NOTIFICATION_CONFIG, useValue: config }, { provide: INTAKE_EVENT_BUS, useValue: bus }],
      exports: [NOTIFICATION_CONFIG, INTAKE_EVENT_BUS],
    };
  }
}

/**
 * The whole module graph. `main.ts` and the test suites build it through the SAME function, so a test can never pass against a
 * differently wired application than the one that ships.
 *
 * - Stage 16.3: the kit's health / readiness / bounded HTTP drain and service authentication.
 * - Stage 16.4: the kit database (bounded pool and deadlines; readiness `database` + `migrations`; the pool closes last).
 * - Stage 16.5: the event intake on the kit RabbitMQ bus (queue `notification.events`; readiness `rabbitmq` + `event-intake`).
 * There is still no business route (16.6), no worker (16.7) and no provider (16.8).
 */
@Module({})
export class AppModule {
  static register(config: NotificationConfig, overrides: AppModuleOverrides = {}): DynamicModule {
    const bus =
      overrides.bus ??
      new RabbitMqEventBus({
        url: config.rabbitmqUrl,
        prefetch: consumerPrefetch(config.db.poolMax),
        confirmTimeoutMs: config.rabbitmqConfirmTimeoutMs,
        heartbeatS: config.rabbitmqHeartbeatS,
        // retry: the kit default (3 retries x 5 s, then `notification.events.dead`), as SDD §13 states.
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
          migrations: { dirs: overrides.migrationsDirs ?? [kitMigrationsDir, notificationMigrationsDir] },
        }),
        ServiceAuthModule.forRoot(config.serviceTokens),
        ConfigModule.forRoot(config, bus),
        IntakeModule,
      ],
    };
  }
}
