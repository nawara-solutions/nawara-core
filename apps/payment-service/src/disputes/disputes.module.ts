import { Global, Module, type DynamicModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import type { PaymentConfig } from '../config/payment-config.js';
import { DISPUTE_EVIDENCE_FILES, HttpDisputeEvidenceFiles, NoEvidenceFiles, type DisputeEvidenceFiles } from './dispute-evidence-files.js';
import { DisputeIngestionService } from './dispute-ingestion.service.js';
import { DisputeOwnerService } from './dispute-owner.service.js';
import { DisputeOwnerController, DisputeServiceController } from './disputes.controller.js';
import { HttpOwnerCompanyAuthority, OWNER_COMPANY_AUTHORITY, type OwnerCompanyAuthority } from './owner-company.authority.js';

/**
 * Core V2 S6e-D payment disputes (register PAY-09 to PAY-11, EVT-03; the Owner's R6E-1 to R6E-9). PRODUCTION REFUSAL, first line: exactly where
 * refunds exist (never production), else the module provides NOTHING: no route, and no ingestion, so a dispute notification is `ignored`.
 * Global when enabled, so the webhook pipeline can apply dispute notifications. It uses the refunds module's Auth receipt client (AUTH-02,
 * AUTH-03). `ownerAuthority` and `evidenceFiles` replace the HTTP clients in tests only.
 */
@Global()
@Module({})
export class DisputesModule {
  static register(config: PaymentConfig, opts: { ownerAuthority?: OwnerCompanyAuthority; evidenceFiles?: DisputeEvidenceFiles } = {}): DynamicModule {
    if (!config.refunds || config.isProduction) return { module: DisputesModule };
    const files = opts.evidenceFiles
      ?? (config.disputeEvidence ? new HttpDisputeEvidenceFiles({ baseUrl: config.disputeEvidence.fileServiceUrl, serviceToken: config.disputeEvidence.fileServiceToken }) : new NoEvidenceFiles());
    return {
      module: DisputesModule,
      imports: [AuthModule, PaymentsModule],
      controllers: [DisputeOwnerController, DisputeServiceController],
      providers: [
        DisputeIngestionService, DisputeOwnerService,
        { provide: OWNER_COMPANY_AUTHORITY, useValue: opts.ownerAuthority ?? new HttpOwnerCompanyAuthority({ baseUrl: config.authServiceUrl }) },
        { provide: DISPUTE_EVIDENCE_FILES, useValue: files },
      ],
      exports: [DisputeIngestionService],
    };
  }
}
