import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { BillingConfig } from './billing-config.js';
import { BILLING_CONFIG } from './billing-config.token.js';

/** Global: every feature module needs the validated configuration, not per-module state. */
@Global()
@Module({})
export class BillingConfigModule {
  static forRoot(config: BillingConfig): DynamicModule {
    return {
      module: BillingConfigModule,
      providers: [{ provide: BILLING_CONFIG, useValue: config }],
      exports: [BILLING_CONFIG],
    };
  }
}
