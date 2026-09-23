import { fileURLToPath } from 'node:url';
import { Logger, Module } from '@nestjs/common';
import {
  DbModule, EventsModule, HealthModule, RateLimitModule, ServiceAuthModule, kitMigrationsDir,
} from '@nawara/service-kit';
import { AttemptsModule } from './attempts/attempts.module.js';
import { AuthClientModule } from './auth/auth-client.module.js';
import { loadPaymentConfig } from './config/payment-config.js';
import { PaymentConfigModule } from './config/payment-config.module.js';
import { createEventBus } from './events/event-bus.js';
import { PaymentsModule } from './payments/payments.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';

const config = loadPaymentConfig();

@Module({
  imports: [
    HealthModule.forRoot({ httpDrainTimeoutMs: config.httpDrainTimeoutMs }), // Stage 15.5: bounded HTTP drain
    DbModule.forRoot({
      url: config.databaseUrl,
      applicationName: 'payment-service',
      // Stage 14.4: bounded pool wait/connect, statement and idle-in-transaction limits (validated in the kit's base config).
      max: config.db.poolMax,
      connectionTimeoutMs: config.db.connectionTimeoutMs,
      statementTimeoutMs: config.db.statementTimeoutMs,
      idleInTransactionTimeoutMs: config.db.idleInTransactionTimeoutMs,
      queryTimeoutMs: config.db.queryTimeoutMs, // Stage 15.2 (I9): client-side deadline for a silent server
      migrations: { dirs: [kitMigrationsDir, fileURLToPath(new URL('../db/migrations/', import.meta.url))] },
    }),
    ServiceAuthModule.forRoot(config.serviceTokens),
    AuthClientModule.forRoot({ baseUrl: config.authServiceUrl, timeoutMs: config.authTimeoutMs }),
    PaymentConfigModule.forRoot(config),
    EventsModule.forRoot({
      source: 'payment-service',
      bus: createEventBus(config),
      // Stage 5 hardening: an unpublished outbox row previously failed silently (the kit's default onError is a no-op).
      // Stage 14.7: each relay message carries its own event name (`outbox_publish_failure eventId=...`, `outbox_relay_pass_failure`, ...).
      onError: (message) => new Logger('OutboxRelay').warn(message),
    }),
    RateLimitModule,
    ProvidersModule,
    PaymentsModule,
    AttemptsModule,
    WebhooksModule,
  ],
})
export class AppModule {}
