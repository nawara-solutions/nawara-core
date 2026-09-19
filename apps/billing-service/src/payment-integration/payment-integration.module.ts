import { Module } from '@nestjs/common';
import { InvoicesModule } from '../invoices/invoices.module.js';
import { PaymentClientModule } from './payment-client.module.js';
import { PaymentDispatcher, PaymentDispatcherService } from './payment-dispatcher.js';
import { PaymentEventConsumer } from './payment-event-consumer.js';
import { PaymentReconciler, PaymentReconcilerService } from './payment-reconciler.js';

/**
 * Stage 4: the cross-service loop (SDD section 21). Everything Billing needs to actually send a payment request to
 * Payment, learn its outcome, and recover from a distributed failure — on top of the Stage 2/3 domain, which is
 * unmodified. No Payment business logic, no Payment database access, no Payment row created here: only the client
 * port, the dispatcher, the event consumer and the reconciler. `PAYMENT_CLIENT` itself is provided by
 * `PaymentClientModule` (not here) — this module already imports `InvoicesModule` for `PaymentRequestRepository`,
 * and `InvoicesModule`'s cancel endpoint also needs `PAYMENT_CLIENT`, so the provider lives in its own module both
 * can import without a cycle.
 */
@Module({
  imports: [InvoicesModule, PaymentClientModule],
  providers: [PaymentDispatcher, PaymentDispatcherService, PaymentReconciler, PaymentReconcilerService, PaymentEventConsumer],
  exports: [PaymentClientModule, PaymentDispatcher, PaymentReconciler],
})
export class PaymentIntegrationModule {}
