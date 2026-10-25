import { Module } from '@nestjs/common';
import { CleanupWorker } from '../cleanup/cleanup.worker.js';
import { UsageLimitsModule } from '../limits/usage-limiter.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { TicketLeaseModule } from '../tickets/ticket-leases.js';
import { DeletionController } from './deletion.controller.js';
import { DeletionService } from './deletion.service.js';

/** Stage 17.7: the delete route and the cleanup workers (orphan expiry, delete worker, upload-lease sweep, ticket
 * retention; S2-File.4: settling single-use ticket reservations past their lease). */
@Module({
  imports: [PersistenceModule, UsageLimitsModule, TicketLeaseModule],
  controllers: [DeletionController],
  providers: [DeletionService, CleanupWorker],
  exports: [CleanupWorker],
})
export class DeletionModule {}
