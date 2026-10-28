import { Module, type DynamicModule } from '@nestjs/common';
import type { BillingConfig } from '../config/billing-config.js';
import { HttpOwnerAuthority, OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import { NoDisputeSourceBeforeS6e, PAYMENT_DISPUTE_EXPOSURE, type DisputeExposure } from './dispute-exposure.js';
import { RefundCaseController } from './refund-case.controller.js';
import { RefundCaseService } from './refund-case.service.js';
import { RefundCommandIdempotency } from './refund-idempotency.js';
import { RefundOwnerGuard } from './refund-owner.guard.js';

/**
 * Core V2 S6a refund cases (register BIL-23, BIL-25; the Owner's R6A-1 to R6A-9). PRODUCTION REFUSAL, first line: in production the module
 * mounts NOTHING (no route), and the service refuses too; there is no flag. Refund execution (S6b), completion (S6c), reversal (S6d) and the
 * authoritative dispute source (S6e) are later stages. `disputeExposure` is for tests only.
 */
@Module({})
export class RefundModule {
  static register(config: BillingConfig, ownerAuthority?: OwnerAuthority, disputeExposure?: DisputeExposure): DynamicModule {
    if (config.isProduction) return { module: RefundModule };
    return {
      module: RefundModule,
      controllers: [RefundCaseController],
      providers: [
        RefundCaseService, RefundCommandIdempotency, RefundOwnerGuard,
        { provide: OWNER_AUTHORITY, useValue: ownerAuthority ?? new HttpOwnerAuthority({ baseUrl: config.authServiceUrl }) },
        { provide: PAYMENT_DISPUTE_EXPOSURE, useValue: disputeExposure ?? new NoDisputeSourceBeforeS6e() },
      ],
    };
  }
}
