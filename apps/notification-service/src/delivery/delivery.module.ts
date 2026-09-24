import { Module, type DynamicModule } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import type { NotificationConfig } from '../config/notification-config.js';
import { DeliveryWorker } from './delivery-worker.js';
import { DestinationLimiter } from './destination-limiter.js';
import { OpsReporter } from './ops-reporter.js';
import { RetentionWorker } from './retention.worker.js';
import { DELIVERY_PROVIDERS, type ProviderRegistry } from './provider.js';
import { SecretPurgeWorker } from './secret-purge.worker.js';
import { ResendEmailProvider } from './providers/resend.js';
import { TwilioSmsProvider } from './providers/twilio.js';
import { TestProvider } from './test-provider.js';

/**
 * The providers configuration selects, one per channel, built once for the application's life (the HTTP connections are reused by
 * Node's global dispatcher). `none` on both channels runs no worker; a channel with `none` keeps its deliveries PENDING.
 */
export function configuredProviders(config: NotificationConfig): ProviderRegistry {
  const d = config.delivery;
  const registry: ProviderRegistry = {};
  if (d.emailProvider === 'test') registry.EMAIL = new TestProvider('EMAIL');
  if (d.emailProvider === 'resend' && d.resend) registry.EMAIL = new ResendEmailProvider(d.resend);
  if (d.smsProvider === 'test') registry.SMS = new TestProvider('SMS');
  if (d.smsProvider === 'twilio' && d.twilio) registry.SMS = new TwilioSmsProvider(d.twilio);
  return registry;
}

/** Stage 16.7: the delivery engine (SDD §8) and the secret purge (SDD §12.1). Tests may inject providers; production never does. */
@Module({})
export class DeliveryModule {
  static register(providers: ProviderRegistry): DynamicModule {
    return {
      module: DeliveryModule,
      imports: [RateLimitModule],
      providers: [{ provide: DELIVERY_PROVIDERS, useValue: providers }, DestinationLimiter, DeliveryWorker, SecretPurgeWorker, OpsReporter, RetentionWorker],
      exports: [DeliveryWorker, SecretPurgeWorker, DestinationLimiter, OpsReporter, RetentionWorker],
    };
  }
}
