import { Module } from '@nestjs/common';
import { CleanupWorker } from '../cleanup/cleanup.worker.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { DeletionController } from './deletion.controller.js';
import { DeletionService } from './deletion.service.js';

/** Stage 17.7: the delete route and the cleanup workers (orphan expiry, delete worker, upload-lease sweep, ticket retention). */
@Module({
  imports: [PersistenceModule],
  controllers: [DeletionController],
  providers: [DeletionService, CleanupWorker],
  exports: [CleanupWorker],
})
export class DeletionModule {}
