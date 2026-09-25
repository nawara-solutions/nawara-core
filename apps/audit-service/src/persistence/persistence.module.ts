import { Module } from '@nestjs/common';
import { AuditRecordRepository } from './audit-record.repository.js';

/** Stage 18.3: the append-only audit_record repository (the kit DbModule is global). */
@Module({ providers: [AuditRecordRepository], exports: [AuditRecordRepository] })
export class PersistenceModule {}
