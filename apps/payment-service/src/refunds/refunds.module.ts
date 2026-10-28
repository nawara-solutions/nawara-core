import { Global, Module, type DynamicModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import type { PaymentConfig } from '../config/payment-config.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { NoDisputeSourceBeforeS6e, REFUND_DISPUTE_EXPOSURE, type RefundDisputeExposure } from './dispute-exposure.js';
import { HttpReceiptAuthority, RECEIPT_AUTHORITY, type ReceiptAuthority } from './receipt-authority.js';
import { RefundAttemptService } from './refund-attempt.service.js';
import { RefundEvidenceService } from './refund-evidence.service.js';
import { RefundWorker, RefundWorkerService } from './refund-worker.js';
import { RefundsController } from './refunds.controller.js';

/**
 * Core V2 S6b refund attempts (register PAY-07, PAY-08; the Owner's R6B-1 to R6B-10). PRODUCTION REFUSAL, first line: without refunds in the
 * configuration (production refuses them) the module provides NOTHING: no route, no worker, no evidence service, so a refund notification is
 * not applied anywhere. Global when enabled, so the webhook pipeline can apply refund evidence. `receiptAuthority`, `disputeExposure` and
 * `worker: false` are for tests only.
 */
@Global()
@Module({})
export class RefundsModule {
  static register(config: PaymentConfig, opts: { receiptAuthority?: ReceiptAuthority; disputeExposure?: RefundDisputeExposure; worker?: boolean } = {}): DynamicModule {
    if (!config.refunds || config.isProduction) return { module: RefundsModule };
    const refunds = config.refunds;
    return {
      module: RefundsModule,
      imports: [AuthModule, PaymentsModule],
      controllers: [RefundsController],
      providers: [
        RefundAttemptService, RefundEvidenceService, RefundWorker, IdempotencyService,
        ...(opts.worker === false ? [] : [RefundWorkerService]),
        {
          provide: RECEIPT_AUTHORITY,
          useValue: opts.receiptAuthority ?? new HttpReceiptAuthority({ baseUrl: config.authServiceUrl, serviceToken: refunds.authServiceToken, timeoutMs: config.authTimeoutMs }),
        },
        { provide: REFUND_DISPUTE_EXPOSURE, useValue: opts.disputeExposure ?? new NoDisputeSourceBeforeS6e() },
      ],
      exports: [RefundEvidenceService, RefundWorker, RefundAttemptService],
    };
  }
}
