import { Global, Module } from '@nestjs/common';
import type { PaymentConfig } from './payment-config.js';
import { PAYMENT_CONFIG } from './payment-config.token.js';

/** Global: every feature module needs PAYMENT_CONFIG, not per-module state. */
@Global()
@Module({})
export class PaymentConfigModule {
  static forRoot(config: PaymentConfig) {
    return {
      module: PaymentConfigModule,
      providers: [{ provide: PAYMENT_CONFIG, useValue: config }],
      exports: [PAYMENT_CONFIG],
    };
  }
}
