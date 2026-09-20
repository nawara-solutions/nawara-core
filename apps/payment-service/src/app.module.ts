import { fileURLToPath } from 'node:url';
import { Logger, Module } from '@nestjs/common';
import {
  DbModule, EventsModule, HealthModule, InMemoryEventBus, RabbitMqEventBus, RateLimitModule, ServiceAuthModule, kitMigrationsDir,
} from '@nawara/service-kit';
import { AttemptsModule } from './attempts/attempts.module.js';
import { AuthClientModule } from './auth/auth-client.module.js';
import { loadPaymentConfig } from './config/payment-config.js';
import { PaymentConfigModule } from './config/payment-config.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';

const config = loadPaymentConfig();

@Module({
  imports: [
    HealthModule.forRoot(),
    DbModule.forRoot({
      url: config.databaseUrl,
      applicationName: 'payment-service',
      migrations: { dirs: [kitMigrationsDir, fileURLToPath(new URL('../db/migrations/', import.meta.url))] },
    }),
    ServiceAuthModule.forRoot(config.serviceTokens),
    AuthClientModule.forRoot({ baseUrl: config.authServiceUrl, timeoutMs: config.authTimeoutMs }),
    PaymentConfigModule.forRoot(config),
    EventsModule.forRoot({
      source: 'payment-service',
      bus: config.rabbitmqUrl ? new RabbitMqEventBus({ url: config.rabbitmqUrl }) : new InMemoryEventBus(),
      // Stage 5 hardening: an unpublished outbox row previously failed silently (the kit's default onError is a no-op).
      onError: (message) => new Logger('OutboxRelay').warn(`outbox_publish_failure ${message}`),
    }),
    RateLimitModule,
    ProvidersModule,
    PaymentsModule,
    AttemptsModule,
    WebhooksModule,
  ],
})
export class AppModule {}
