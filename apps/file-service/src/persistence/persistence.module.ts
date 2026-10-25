import { Module } from '@nestjs/common';
import { FileRepository } from './file.repository.js';
import { GrantRepository } from './grant.repository.js';
import { HoldRepository } from './hold.repository.js';
import { TicketRepository } from './ticket.repository.js';

/** The file-service persistence layer (Stage 17.3): the `file`, `file_access_ticket` and `file_evidence_grant` (S2-File.1)
 * repositories over the kit database. */
@Module({
  providers: [FileRepository, TicketRepository, GrantRepository, HoldRepository],
  exports: [FileRepository, TicketRepository, GrantRepository, HoldRepository],
})
export class PersistenceModule {}
