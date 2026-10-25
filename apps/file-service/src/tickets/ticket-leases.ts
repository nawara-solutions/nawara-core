import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';
import { FileAudit, type GrantedAccess } from '../audit/file-audit.js';
import { OPS_COUNTERS_TOKEN, type OpsCounters } from '../ops/ops-counters.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import type { TicketDigest } from '../persistence/ticket-digest.js';
import { TicketRepository, type LeasedTicket } from '../persistence/ticket.repository.js';

export type LeaseOutcome = 'committed' | 'uncertain' | 'released';

const ACCESS: Record<LeaseOutcome, GrantedAccess> = {
  committed: 'ticket_redemption_committed',
  uncertain: 'ticket_redemption_uncertain',
  released: 'ticket_redemption_released',
};

/**
 * Core V2 S2-File.4 (register FIL-07; OD-FILE F5): settling the reservation of a single-use download ticket. Each settlement is ONE short
 * transaction that also records it for a grant ticket (`file.granted_read`, the settled `access`), and is counted. A settlement that
 * cannot be written is logged and left alone: the reservation then runs out and is settled as `uncertain` (fail closed). Never a ticket,
 * token, URL or byte in a log line.
 */
@Injectable()
export class TicketLeases {
  private readonly logger = new Logger('FileTicketLease');

  constructor(
    private readonly db: DbService,
    private readonly tickets: TicketRepository,
    @Inject(FileAudit) private readonly audit: FileAudit,
    @Inject(OPS_COUNTERS_TOKEN) private readonly counters: OpsCounters,
  ) {}

  /** Settles THIS lease; `false` when it was not (already settled otherwise, or the write failed: the lease then runs out). */
  async settle(ticketId: string, leaseId: string, to: LeaseOutcome): Promise<boolean> {
    try {
      const settled = await this.db.tx(async (q) => {
        const s = await this.tickets.settleLease(ticketId, leaseId, to, q);
        if (s?.grant) await this.audit.grantedRead(q, s.grant, ACCESS[to]);
        return s;
      });
      if (!settled) return false;
      this.counters.bump(`ticket_lease_${to}`);
      this.logger.log(`file_ticket_lease_settled ticket=${ticketId} outcome=${to}`);
      return true;
    } catch (e) {
      this.counters.bump('ticket_lease_settle_failed');
      this.logger.warn(`file_ticket_lease_settle_failed ticket=${ticketId} outcome=${to} error=${e instanceof Error ? e.name : 'error'}`);
      return false;
    }
  }

  /** After a refused claim: settles a reservation that ran out unsettled (`uncertain`), and says whether one is still in progress. */
  async afterRefusedClaim(digest: TicketDigest): Promise<boolean> {
    const { inProgress, settled } = await this.db.tx(async (q) => {
      const r = await this.tickets.afterRefusedClaim(digest, q);
      if (r.settled) await this.record(q, r.settled);
      return r;
    });
    if (settled) this.logSettledByExpiry(settled);
    return inProgress;
  }

  /** The cleanup pass: reservations past their lease, settled `uncertain` in one bounded batch. */
  async settleExpired(limit: number): Promise<number> {
    const settled = await this.db.tx(async (q) => {
      const rows = await this.tickets.settleExpiredLeases(limit, q);
      for (const s of rows) await this.record(q, s);
      return rows;
    });
    for (const s of settled) this.logSettledByExpiry(s);
    return settled.length;
  }

  private async record(q: Parameters<FileAudit['grantedRead']>[0], s: LeasedTicket): Promise<void> {
    if (s.grant) await this.audit.grantedRead(q, s.grant, ACCESS.uncertain);
  }

  private logSettledByExpiry(s: LeasedTicket): void {
    this.counters.bump('ticket_lease_uncertain');
    this.logger.warn(`file_ticket_lease_expired ticket=${s.ticket.id} outcome=uncertain`);
  }
}

/** The settlement of single-use ticket reservations, shared by redemption and the cleanup pass. */
@Module({
  imports: [PersistenceModule],
  providers: [TicketLeases],
  exports: [TicketLeases],
})
export class TicketLeaseModule {}
