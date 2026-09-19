import { fileURLToPath } from 'node:url';
import { Module } from '@nestjs/common';
import {
  DbModule, EventsModule, HealthModule, InMemoryEventBus, RabbitMqEventBus, RateLimitModule, ServiceAuthModule, kitMigrationsDir,
} from '@nawara/service-kit';
import { AuthClientModule } from './auth/auth-client.module.js';
import { ServiceOrUserGuard } from './auth/service-or-user.guard.js';
import { PAYMENT_CONFIG } from './config/payment-config.token.js';
import { loadPaymentConfig } from './config/payment-config.js';

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
    EventsModule.forRoot({
      source: 'payment-service',
      bus: config.rabbitmqUrl ? new RabbitMqEventBus({ url: config.rabbitmqUrl }) : new InMemoryEventBus(),
    }),
    RateLimitModule,
  ],
  providers: [{ provide: PAYMENT_CONFIG, useValue: config }, ServiceOrUserGuard],
  exports: [ServiceOrUserGuard],
})
export class AppModule {}
