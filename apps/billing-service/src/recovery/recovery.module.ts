import { Module, type DynamicModule } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import { AssistanceAuthority } from '../assistance/assistance-authority.js';
import { AssistanceCommandIdempotency } from '../assistance/assistance-idempotency.js';
import { AssistanceUserGuard } from '../assistance/assistance-user.guard.js';
import type { BillingConfig } from '../config/billing-config.js';
import { InvoicesModule } from '../invoices/invoices.module.js';
import { HttpOwnerAuthority, OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import { RefundOwnerGuard } from '../refunds/refund-owner.guard.js';
import { RecoveryAdminController, RecoveryController } from './recovery.controller.js';
import { RecoveryService, RecoveryWorkerService } from './recovery.service.js';

/**
 * Core V2 S6f Organization recovery (register BIL-26 T3, BIL-28 to BIL-31; the Owner's R6F-1 to R6F-8). PRODUCTION REFUSAL, first line: in
 * production the module mounts NOTHING (no route, no worker); there is no flag. It reuses the global refund module's Auth receipt and File
 * evidence clients (Billing's own tokens). `worker: false` is for tests, which drive `drainOnce` themselves.
 */
@Module({})
export class RecoveryModule {
  static register(config: BillingConfig, ownerAuthority?: OwnerAuthority, opts: { worker?: boolean } = {}): DynamicModule {
    if (config.isProduction) return { module: RecoveryModule };
    return {
      module: RecoveryModule,
      imports: [RateLimitModule, InvoicesModule],
      controllers: [RecoveryController, RecoveryAdminController],
      providers: [
        RecoveryService, ...(opts.worker === false ? [] : [RecoveryWorkerService]),
        AssistanceAuthority, AssistanceCommandIdempotency, AssistanceUserGuard, RefundOwnerGuard,
        { provide: OWNER_AUTHORITY, useValue: ownerAuthority ?? new HttpOwnerAuthority({ baseUrl: config.authServiceUrl }) },
      ],
    };
  }
}
