import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AuditConsumer } from './audit-consumer.js';
import { IngestionCounters } from './ingestion-counters.js';
import { IngestionService } from './ingestion.service.js';

/** Stage 18.5: the RabbitMQ ingestion (the bus itself, `AUDIT_EVENT_BUS`, is provided by `AppModule.register`). */
@Module({
  imports: [PersistenceModule],
  providers: [{ provide: IngestionCounters, useValue: new IngestionCounters() }, IngestionService, AuditConsumer],
  exports: [IngestionService, IngestionCounters, AuditConsumer],
})
export class IngestionModule {}
