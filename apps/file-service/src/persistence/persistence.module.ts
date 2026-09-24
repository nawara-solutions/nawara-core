import { Module } from '@nestjs/common';
import { FileRepository } from './file.repository.js';
import { TicketRepository } from './ticket.repository.js';

/** The file-service persistence layer (Stage 17.3): the `file` and `file_access_ticket` repositories over the kit database. */
@Module({
  providers: [FileRepository, TicketRepository],
  exports: [FileRepository, TicketRepository],
})
export class PersistenceModule {}
