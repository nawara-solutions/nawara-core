import { Module, type DynamicModule } from '@nestjs/common';
import type { BillingConfig } from '../config/billing-config.js';
import { HttpOwnerAuthority, OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import { RefundCommandIdempotency } from '../refunds/refund-idempotency.js';
import { RefundOwnerGuard } from '../refunds/refund-owner.guard.js';
import { LateSuccessService } from './late-success.service.js';
import { HttpPaymentReconciliationClient, PAYMENT_RECONCILIATION_CLIENT, type PaymentReconciliationClient } from './payment-reconciliation-client.js';
import { ReconciliationCases } from './reconciliation-cases.js';
import { ReconciliationController } from './reconciliation.controller.js';
import { ReconciliationService, ReconciliationWorkerService } from './reconciliation.service.js';

/**
 * Core V2 S6h-B reconciliation (register BIL-33, BIL-34, EVT-10; the Owner's R6H-1 to R6H-12). PRODUCTION REFUSAL, first line: in production
 * the module mounts NOTHING (no route, no worker, no late-success handler); there is no flag. It reuses the global refund module's Auth receipt
 * client (Billing's own token) for the write-off. `paymentReconciliationClient` and `worker: false` are for tests.
 */
@Module({})
export class ReconciliationModule {
  static register(config: BillingConfig, ownerAuthority?: OwnerAuthority, opts: { worker?: boolean; paymentReconciliationClient?: PaymentReconciliationClient } = {}): DynamicModule {
    if (config.isProduction) return { module: ReconciliationModule };
    return {
      module: ReconciliationModule,
      controllers: [ReconciliationController],
      providers: [
        ReconciliationCases, LateSuccessService, ReconciliationService, RefundCommandIdempotency, RefundOwnerGuard,
        ...(opts.worker === false ? [] : [ReconciliationWorkerService]),
        {
          provide: PAYMENT_RECONCILIATION_CLIENT,
          useValue: opts.paymentReconciliationClient
            ?? new HttpPaymentReconciliationClient({ baseUrl: config.paymentServiceUrl, serviceToken: config.paymentServiceToken, timeoutMs: config.paymentTimeoutMs }),
        },
        { provide: OWNER_AUTHORITY, useValue: ownerAuthority ?? new HttpOwnerAuthority({ baseUrl: config.authServiceUrl }) },
      ],
      // global: the Payment event consumer records Payment's late successes where (and only where) reconciliation is mounted
      global: true,
      exports: [LateSuccessService],
    };
  }
}
