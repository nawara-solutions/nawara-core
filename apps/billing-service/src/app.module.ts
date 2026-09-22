import { fileURLToPath } from 'node:url';
import { Logger, Module, type DynamicModule } from '@nestjs/common';
import {
  DbModule, EventsModule, HealthModule, InMemoryEventBus, RabbitMqEventBus, RateLimitModule, ServiceAuthModule, kitMigrationsDir,
  type AuthClient, type EventBus,
} from '@nawara/service-kit';
import { AuthClientModule } from './auth/auth-client.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import type { BillingConfig } from './config/billing-config.js';
import { BillingConfigModule } from './config/billing-config.module.js';
import { CurrenciesModule } from './currencies/currencies.module.js';
import { InvoicesModule } from './invoices/invoices.module.js';
import { PaymentIntegrationModule } from './payment-integration/payment-integration.module.js';
import { SubscriptionsModule } from './subscriptions/subscriptions.module.js';

/** The service's own migrations, applied by the explicit `npm run migrate` step and never at startup. */
export const billingMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

export interface AppModuleOverrides {
  /** Tests inject a stub; production uses the kit's `HttpAuthClient` against `AUTH_SERVICE_URL`. */
  authClient?: AuthClient;
  /** Tests inject the in-memory bus; production uses RabbitMQ when `RABBITMQ_URL` is set. */
  bus?: EventBus;
  /** Tests point readiness at the migrations they applied. */
  migrationsDirs?: string[];
}

/**
 * The whole module graph. `main.ts` and the test suites build it through the SAME function, so a test can never
 * pass against a differently wired application than the one that ships. Stage 3 added the HTTP API (`CatalogModule`,
 * `InvoicesModule`'s controllers). Stage 4 adds `PaymentIntegrationModule`: the dispatcher, the Payment client port,
 * the event consumer and the reconciler — the actual cross-service loop to payment-service.
 */
@Module({})
export class AppModule {
  static register(config: BillingConfig, overrides: AppModuleOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HealthModule.forRoot(),
        DbModule.forRoot({
          url: config.databaseUrl,
          applicationName: config.serviceName,
          migrations: { dirs: overrides.migrationsDirs ?? [kitMigrationsDir, billingMigrationsDir] },
        }),
        ServiceAuthModule.forRoot(config.serviceTokens),
        AuthClientModule.forRoot(overrides.authClient ?? { baseUrl: config.authServiceUrl, timeoutMs: config.authTimeoutMs }),
        BillingConfigModule.forRoot(config),
        EventsModule.forRoot({
          source: config.serviceName,
          bus: overrides.bus ?? (config.rabbitmqUrl
            ? new RabbitMqEventBus({ url: config.rabbitmqUrl, retry: config.paymentEventRetry, onNotice: (message) => new Logger('RabbitMqEventBus').warn(message) })
            : new InMemoryEventBus()),
          // Stage 5 hardening: an unpublished outbox row previously failed silently (the kit's default onError is a no-op).
          onError: (message) => new Logger('OutboxRelay').warn(`outbox_publish_failure ${message}`),
        }),
        RateLimitModule,
        AuthModule,
        InvoicesModule,
        CatalogModule,
        CurrenciesModule,
        PaymentIntegrationModule,
        SubscriptionsModule,
      ],
    };
  }
}
