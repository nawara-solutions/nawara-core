import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, DOMAIN_EVENTS, type Clock, type DomainEvents } from '../common/ports.js';
import { sha256Hex } from '../crypto/random.js';
import { DbService } from '../db/db.service.js';

/**
 * New-device ALERTING for owner logins. The fingerprint is a hash of the normalized User-Agent —
 * a weak signal, NEVER an authentication factor and never a reason to allow anything: it can only
 * raise an alert. IP and User-Agent are server-observed.
 */
@Injectable()
export class AdminDeviceService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DOMAIN_EVENTS) private readonly events: DomainEvents,
  ) {}

  async checkAndRecord(ownerId: string, userAgent: string, ip: string, contact: { channel: 'email' | 'phone'; destination: string } | null) {
    const fp = sha256Hex(userAgent.trim().toLowerCase().replace(/\d+(\.\d+)*/g, '#'));
    const now = this.clock.now();
    // Stage 21.C.2 (ADR-0052 decision 4): the device row and the new-device alert commit together (the alert was previously lost on a crash
    // or a broker outage after the upsert, and it cannot be reconstructed).
    return this.db.tx(async (q) => {
      const { rows } = await q.query(
        `INSERT INTO admin_device("userId","fingerprintHash","ipAddress","firstSeenAt","lastSeenAt") VALUES ($1,$2,$3,$4,$4)
         ON CONFLICT ("userId","fingerprintHash") DO UPDATE SET "lastSeenAt"=$4, "ipAddress"=$3
         RETURNING (xmax = 0) AS inserted`,
        [ownerId, fp, ip, now],
      );
      if (rows[0].inserted && contact) {
        await this.events.emit(q, 'admin.owner_login_from_new_device', { userId: ownerId, ...contact, ipAddress: ip, timestamp: now.toISOString() });
      }
      return rows[0].inserted as boolean;
    });
  }
}
