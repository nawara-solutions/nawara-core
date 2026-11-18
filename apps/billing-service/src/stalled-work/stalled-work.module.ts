import { Module, type DynamicModule } from '@nestjs/common';
import { AssistanceOwnerGuard } from '../assistance/assistance-owner.guard.js';
import type { BillingConfig } from '../config/billing-config.js';
import { HttpOwnerAuthority, OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import { RefundOwnerGuard } from '../refunds/refund-owner.guard.js';
import { AssistanceStalledWorkController, StalledWorkController } from './stalled-work.controller.js';
import { StalledWorkService, StalledWorkSweepService } from './stalled-work.service.js';

/**
 * Core V2 G3 stalled-work review (DO-31, DO-33, DO-41, DO-42; the Owner's G3 GO, 2026-11-18). ESCALATION ONLY. PRODUCTION REFUSAL, first line: in
 * production the module mounts NOTHING (no route, no sweep, no auth_fault record); there is no flag — the same gate as assistance and reconciliation.
 * Global, so the payment dispatcher can record an auth_fault where (and only where) it is mounted. `worker: false` is for tests.
 */
@Module({})
export class StalledWorkModule {
  static register(config: BillingConfig, ownerAuthority?: OwnerAuthority, opts: { worker?: boolean } = {}): DynamicModule {
    if (config.isProduction) return { module: StalledWorkModule };
    return {
      module: StalledWorkModule,
      controllers: [StalledWorkController, AssistanceStalledWorkController],
      providers: [
        StalledWorkService, RefundOwnerGuard, AssistanceOwnerGuard,
        ...(opts.worker === false ? [] : [StalledWorkSweepService]),
        { provide: OWNER_AUTHORITY, useValue: ownerAuthority ?? new HttpOwnerAuthority({ baseUrl: config.authServiceUrl }) },
      ],
      global: true,
      exports: [StalledWorkService],
    };
  }
}
