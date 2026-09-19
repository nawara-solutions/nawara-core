import { Inject, Injectable } from '@nestjs/common';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import type { PaymentConfig } from '../config/payment-config.js';
import { paymentError } from '../errors.js';
import type { PaymentProvider } from './provider.port.js';
import { TestPaymentProvider } from './test-provider.js';

/** Enabled providers, by id. Only the test provider exists in this phase — real gateways are deferred (SDD section 18). */
@Injectable()
export class ProviderRegistry {
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(
    @Inject(PAYMENT_CONFIG) config: PaymentConfig,
    @Inject(TestPaymentProvider) testProvider: TestPaymentProvider,
  ) {
    if (config.testProviderEnabled) this.providers.set(testProvider.id, testProvider);
  }

  get(id: string): PaymentProvider {
    const provider = this.providers.get(id);
    if (!provider) throw paymentError(422, 'invalid_provider', `Provider ${id} is not enabled.`);
    return provider;
  }

  /** For the webhook route, which reports an unknown provider as 404, not 422 (SDD section 9.1, endpoint 5). */
  tryGet(id: string): PaymentProvider | undefined {
    return this.providers.get(id);
  }
}
