import { Module, type DynamicModule } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import type { AuditConfig } from '../config/audit-config.js';
import { DeadLetterDiagnosticsController } from './dead-letter-diagnostics.controller.js';
import { DeadLetterDiagnosticsService } from './dead-letter-diagnostics.service.js';
import { DeadLetterObservationRepository } from './dead-letter-observation.repository.js';
import { DeadLetterObservationService } from './dead-letter-observation.service.js';

/**
 * Core V2 DO-43a: the dead-letter observation storage (always provided, so the schema has one owner) and its service-token diagnostics read,
 * mounted ONLY when `AUDIT_DEAD_LETTER_OBSERVATION=enabled` (development and simulation; production refuses the setting). DO-43c: the
 * observation service (global, so the ingestion consumer can ask it for an observer; it gives none while the setting is disabled).
 */
@Module({})
export class DiagnosticsModule {
  static register(config: AuditConfig): DynamicModule {
    return {
      module: DiagnosticsModule,
      global: true,
      imports: [RateLimitModule],
      controllers: config.deadLetterObservation ? [DeadLetterDiagnosticsController] : [],
      providers: [DeadLetterObservationRepository, DeadLetterObservationService, ...(config.deadLetterObservation ? [DeadLetterDiagnosticsService] : [])],
      exports: [DeadLetterObservationRepository, DeadLetterObservationService],
    };
  }
}
