import { Module, type DynamicModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import type { PaymentConfig } from '../config/payment-config.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { HttpOwnerCompanyAuthority, OWNER_COMPANY_AUTHORITY, type OwnerCompanyAuthority } from '../disputes/owner-company.authority.js';
import { ReconciliationOwnerController, ReconciliationServiceController } from './reconciliation.controller.js';
import { ReconciliationService } from './reconciliation.service.js';

/**
 * Core V2 S6h-P reconciliation (register PAY-12, PAY-13; the Owner's R6H-1 to R6H-12). PRODUCTION REFUSAL, first line: exactly where refunds exist
 * (never production), else the module provides NOTHING: no route. It uses the refunds module's Auth receipt client (AUTH-02, AUTH-03).
 * Unmatched verified facts are recorded by the webhook pipeline itself (FC-1), wherever it runs. `ownerAuthority` is for tests only.
 */
@Module({})
export class ReconciliationModule {
  static register(config: PaymentConfig, opts: { ownerAuthority?: OwnerCompanyAuthority } = {}): DynamicModule {
    if (!config.refunds || config.isProduction) return { module: ReconciliationModule };
    return {
      module: ReconciliationModule,
      imports: [AuthModule, PaymentsModule],
      controllers: [ReconciliationOwnerController, ReconciliationServiceController],
      providers: [
        ReconciliationService,
        { provide: OWNER_COMPANY_AUTHORITY, useValue: opts.ownerAuthority ?? new HttpOwnerCompanyAuthority({ baseUrl: config.authServiceUrl }) },
      ],
    };
  }
}
