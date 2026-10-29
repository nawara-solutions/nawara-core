import { Module, type DynamicModule } from '@nestjs/common';
import type { BillingConfig } from '../config/billing-config.js';
import { HttpOwnerAuthority, OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import { PAYMENT_DISPUTE_EXPOSURE, type DisputeExposure } from './dispute-exposure.js';
import { DisputeLossService, DisputeLossWorkerService } from './dispute-loss.service.js';
import { HttpPaymentDisputeClient, PAYMENT_DISPUTE_CLIENT, type PaymentDisputeClient } from './payment-dispute-client.js';
import { FraudHoldController } from '../fraud-holds/fraud-hold.controller.js';
import { FraudHoldService, FraudHoldSweepService } from '../fraud-holds/fraud-hold.service.js';
import {
  FRAUD_EVIDENCE_FILES, FRAUD_HOLD_RECEIPTS, FraudHoldsNotConfigured, HttpFraudEvidenceFiles, HttpFraudHoldReceipts, type FraudEvidenceFiles, type FraudHoldReceipts,
} from '../fraud-holds/fraud-hold-clients.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
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
 * reconciler; S6c completion; S6d reversals. Core V2 S6e-D (R6E-4 to R6E-6): Payment's authoritative dispute exposure replaces the pre-S6e
 * adapter, and the dispute loss worker applies verified final losses. `disputeExposure` and `refunds` are for tests only.
 */
@Module({})
export class RefundModule {
  static register(config: BillingConfig, ownerAuthority?: OwnerAuthority, disputeExposure?: DisputeExposure,
    refunds: { paymentRefundClient?: PaymentRefundClient; reconciler?: boolean; paymentDisputeClient?: PaymentDisputeClient; fraudHoldReceipts?: FraudHoldReceipts; fraudEvidenceFiles?: FraudEvidenceFiles } = {}): DynamicModule {
    if (config.isProduction) return { module: RefundModule };
    // Core V2 S6e-H (BIL-27): fraud holds' Auth receipt and File evidence clients (Billing's own tokens); not configured, nothing is placed
    const fh = config.fraudHolds;
    const notConfigured = new FraudHoldsNotConfigured();
    const disputes = new HttpPaymentDisputeClient({ baseUrl: config.paymentServiceUrl, serviceToken: config.paymentServiceToken, timeoutMs: config.paymentTimeoutMs });
    return {
      module: RefundModule,
      imports: [SubscriptionsModule],
      controllers: [RefundCaseController, FraudHoldController],
      providers: [
        RefundCaseService, RefundCommandIdempotency, RefundOwnerGuard,
        // Core V2 S6b (BIL-24): the relay to Payment and its reconciler (Billing's own service token; never an Owner's bearer)
        RefundAuthorizationService, RefundRelayReconciler, RefundCompletionService, ...(refunds.reconciler === false ? [] : [RefundRelayReconcilerService]),
        // Core V2 S6d (R6D-3): the commercial effects of completed cases, asynchronously (tests drive `drainOnce` themselves)
        RefundEffectService, ...(refunds.reconciler === false ? [] : [RefundEffectWorkerService]),
        // Core V2 S6e-D (R6E-5, R6E-6): verified final losses (event or Payment's losses read) and their effects, asynchronously
        DisputeLossService, ...(refunds.reconciler === false ? [] : [DisputeLossWorkerService]),
        { provide: PAYMENT_DISPUTE_CLIENT, useValue: refunds.paymentDisputeClient ?? disputes },
        // Core V2 S6e-H (H-1 to H-7, C-1): fraud holds and their sweep (expiry record, compensation evidence); tests drive `sweepOnce`
        FraudHoldService, ...(refunds.reconciler === false ? [] : [FraudHoldSweepService]),
        {
          provide: FRAUD_HOLD_RECEIPTS,
          useValue: refunds.fraudHoldReceipts ?? (fh ? new HttpFraudHoldReceipts({ baseUrl: config.authServiceUrl, serviceToken: fh.authServiceToken, timeoutMs: config.authTimeoutMs }) : notConfigured),
        },
        {
          provide: FRAUD_EVIDENCE_FILES,
          useValue: refunds.fraudEvidenceFiles ?? (fh ? new HttpFraudEvidenceFiles({ baseUrl: fh.fileServiceUrl, serviceToken: fh.fileServiceToken, timeoutMs: config.authTimeoutMs }) : notConfigured),
        },
        {
          provide: PAYMENT_REFUND_CLIENT,
          useValue: refunds.paymentRefundClient ?? new HttpPaymentRefundClient({ baseUrl: config.paymentServiceUrl, serviceToken: config.paymentServiceToken, timeoutMs: config.paymentTimeoutMs }),
        },
        { provide: OWNER_AUTHORITY, useValue: ownerAuthority ?? new HttpOwnerAuthority({ baseUrl: config.authServiceUrl }) },
        { provide: PAYMENT_DISPUTE_EXPOSURE, useValue: disputeExposure ?? disputes }, // R6E-4: Payment's authoritative exposure, fail closed
      ],
      // Core V2 S6c: global, so the Payment event consumer can apply Payment's refund completion where (and only where) refunds are mounted
      global: true,
      exports: [RefundRelayReconciler, RefundCompletionService, RefundEffectService, DisputeLossService, FraudHoldService],
    };
  }
}
