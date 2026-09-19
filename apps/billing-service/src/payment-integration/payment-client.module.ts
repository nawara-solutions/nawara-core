import { Module } from '@nestjs/common';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { HttpPaymentClient } from './payment-client.js';
import { PAYMENT_CLIENT } from './payment-client.token.js';

/**
 * Provides `PAYMENT_CLIENT` on its own, with no dependency on `InvoicesModule` — both `InvoicesModule` (the cancel
 * endpoint) and `PaymentIntegrationModule` (the dispatcher and reconciler) need it, and `PaymentIntegrationModule`
 * already imports `InvoicesModule` for `PaymentRequestRepository`, so putting the client there too would be a cycle.
 */
@Module({
  providers: [
    {
      provide: PAYMENT_CLIENT,
      useFactory: (config: BillingConfig) => new HttpPaymentClient({ baseUrl: config.paymentServiceUrl, serviceToken: config.paymentServiceToken, timeoutMs: config.paymentTimeoutMs }),
      inject: [BILLING_CONFIG],
    },
  ],
  exports: [PAYMENT_CLIENT],
})
export class PaymentClientModule {}
