import { Module, type DynamicModule } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import { AssistanceAuthority } from '../assistance/assistance-authority.js';
import { AssistanceCommandIdempotency } from '../assistance/assistance-idempotency.js';
import { AssistanceUserGuard } from '../assistance/assistance-user.guard.js';
import type { BillingConfig } from '../config/billing-config.js';
import { HttpOwnerAuthority, OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import { RefundOwnerGuard } from '../refunds/refund-owner.guard.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { LateSettlementAdminController, LateSettlementController } from './late-settlement.controller.js';
import { LateSettlementService } from './late-settlement.service.js';

/**
 * Core V2 S6g late assisted settlement application (register BIL-32; the Owner's R6G-1 to R6G-9). PRODUCTION REFUSAL, first line: in
 * production the module mounts NOTHING (no route); there is no flag. It reuses the global refund module's Auth receipt and File evidence
 * clients (Billing's own tokens). No worker: an application is one synchronous, idempotent transaction.
 */
@Module({})
export class LateSettlementModule {
  static register(config: BillingConfig, ownerAuthority?: OwnerAuthority): DynamicModule {
    if (config.isProduction) return { module: LateSettlementModule };
    return {
      module: LateSettlementModule,
      imports: [RateLimitModule, SubscriptionsModule],
      controllers: [LateSettlementController, LateSettlementAdminController],
      providers: [
        LateSettlementService, AssistanceAuthority, AssistanceCommandIdempotency, AssistanceUserGuard, RefundOwnerGuard,
        { provide: OWNER_AUTHORITY, useValue: ownerAuthority ?? new HttpOwnerAuthority({ baseUrl: config.authServiceUrl }) },
      ],
    };
  }
}
