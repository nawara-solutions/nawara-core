import { Module, type DynamicModule } from '@nestjs/common';
import type { BillingConfig } from '../config/billing-config.js';
import { HttpOwnerAuthority, OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import { NoDisputeSourceBeforeS6e, PAYMENT_DISPUTE_EXPOSURE, type DisputeExposure } from './dispute-exposure.js';
import { RefundCaseController } from './refund-case.controller.js';
import { RefundCaseService } from './refund-case.service.js';
import { RefundCommandIdempotency } from './refund-idempotency.js';
import { RefundOwnerGuard } from './refund-owner.guard.js';
import { HttpPaymentRefundClient, PAYMENT_REFUND_CLIENT, type PaymentRefundClient } from './payment-refund-client.js';
import { RefundAuthorizationService } from './refund-authorization.service.js';
import { RefundRelayReconciler, RefundRelayReconcilerService } from './refund-relay-reconciler.js';
import { RefundCompletionService } from './refund-completion.service.js';
import { RefundEffectService, RefundEffectWorkerService } from './refund-effect.service.js';

/**
 * Core V2 S6a refund cases (register BIL-23, BIL-25; the Owner's R6A-1 to R6A-9). PRODUCTION REFUSAL, first line: in production the module
 * mounts NOTHING (no route), and the service refuses too; there is no flag. Core V2 S6b adds the authorization relay (BIL-24) and its
 * reconciler. Completion (S6c), reversal (S6d) and the authoritative dispute source (S6e) are later stages. `disputeExposure` and `refunds`
 * are for tests only.
 */
@Module({})
export class RefundModule {
  static register(config: BillingConfig, ownerAuthority?: OwnerAuthority, disputeExposure?: DisputeExposure,
    refunds: { paymentRefundClient?: PaymentRefundClient; reconciler?: boolean } = {}): DynamicModule {
    if (config.isProduction) return { module: RefundModule };
    return {
      module: RefundModule,
      controllers: [RefundCaseController],
      providers: [
        RefundCaseService, RefundCommandIdempotency, RefundOwnerGuard,
        // Core V2 S6b (BIL-24): the relay to Payment and its reconciler (Billing's own service token; never an Owner's bearer)
        RefundAuthorizationService, RefundRelayReconciler, RefundCompletionService, ...(refunds.reconciler === false ? [] : [RefundRelayReconcilerService]),
        // Core V2 S6d (R6D-3): the commercial effects of completed cases, asynchronously (tests drive `drainOnce` themselves)
        RefundEffectService, ...(refunds.reconciler === false ? [] : [RefundEffectWorkerService]),
        {
          provide: PAYMENT_REFUND_CLIENT,
          useValue: refunds.paymentRefundClient ?? new HttpPaymentRefundClient({ baseUrl: config.paymentServiceUrl, serviceToken: config.paymentServiceToken, timeoutMs: config.paymentTimeoutMs }),
        },
        { provide: OWNER_AUTHORITY, useValue: ownerAuthority ?? new HttpOwnerAuthority({ baseUrl: config.authServiceUrl }) },
        { provide: PAYMENT_DISPUTE_EXPOSURE, useValue: disputeExposure ?? new NoDisputeSourceBeforeS6e() },
      ],
      // Core V2 S6c: global, so the Payment event consumer can apply Payment's refund completion where (and only where) refunds are mounted
      global: true,
      exports: [RefundRelayReconciler, RefundCompletionService, RefundEffectService],
    };
  }
}
