import { Module, type DynamicModule } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import type { NotificationConfig } from '../config/notification-config.js';
import { DeliveryWorker } from './delivery-worker.js';
import { DELIVERY_PROVIDERS, type ProviderRegistry } from './provider.js';
import { SecretPurgeWorker } from './secret-purge.worker.js';
import { TestProvider } from './test-provider.js';

/** The providers configuration selects. `none` (the default) has none: the worker does not run and deliveries stay PENDING. */
export function configuredProviders(config: NotificationConfig): ProviderRegistry {
  if (config.delivery.provider === 'test') return { EMAIL: new TestProvider('EMAIL'), SMS: new TestProvider('SMS') };
  return {};
}

/** Stage 16.7: the delivery engine (SDD §8) and the secret purge (SDD §12.1). Tests may inject providers; production never does. */
@Module({})
export class DeliveryModule {
  static register(providers: ProviderRegistry): DynamicModule {
    return {
      module: DeliveryModule,
      imports: [RateLimitModule],
      providers: [{ provide: DELIVERY_PROVIDERS, useValue: providers }, DeliveryWorker, SecretPurgeWorker],
      exports: [DeliveryWorker, SecretPurgeWorker],
    };
  }
}
