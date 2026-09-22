import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { ClientInfo } from '../common/client-info.js';
import { CLOCK, EVENT_BUS, type Clock, type EventBus } from '../common/ports.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { hmacHex } from '../crypto/hmac.js';
import { authError } from '../errors.js';
import { randomSixDigitCode, safeEqualHex } from '../crypto/random.js';
import { DbService } from '../db/db.service.js';
import { ThrottleService } from '../throttle/throttle.service.js';

export const MAX_CONTACT_ATTEMPTS = 5; // mirrors the DB CHECK on member_contact_verification."attemptCount"
const GENERIC = 'Invalid or expired code.';

/**
 * Proves that a member's e-mail or phone belongs to them (ADR-0028). Same construction as operator
 * working codes: a 6-digit CSPRNG code stored only as an HMAC (the pepper lives outside the database),
 * single live code per member (partial unique index), 5 attempts, short expiry, rate limited per user
 * and per IP. The raw code leaves the service only inside the delivery event.
 *
 * It only GATES organization access when REQUIRE_CONTACT_VERIFICATION=true. No channel delivers the
 * event yet (notification-service and a broker do not exist), so the flag is off in production and the
 * gap is recorded as a production blocker for enabling it.
 */
@Injectable()
export class ContactVerificationService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private digest(userId: string, code: string) {
    // Same key as join codes, distinct HMAC domain label and bound to the member.
    return hmacHex(this.cfg.secrets.joinCodePepper, 'contact_verification', userId, code);
  }

  async request(userId: string, client: ClientInfo): Promise<void> {
    await this.throttle.hit('contact_request_user', userId);
    const { rows } = await this.db.query(`SELECT email, phone, "contactVerifiedAt" FROM "user" WHERE id=$1 AND kind='member' AND "isActive"`, [userId]);
    const u = rows[0];
    if (!u || u.contactVerifiedAt) return; // nothing to verify; the answer never differs
    const channel = u.email ? 'email' : 'phone';
    const now = this.clock.now();
    const code = randomSixDigitCode();
    const expiresAt = new Date(now.getTime() + this.cfg.onboarding.contactCodeTtlSec * 1000);
    await this.db.tx(async (q) => {
      await q.query(`UPDATE member_contact_verification SET "supersededAt"=$2 WHERE "userId"=$1 AND "consumedAt" IS NULL AND "supersededAt" IS NULL`, [userId, now]);
      await q.query(
        `INSERT INTO member_contact_verification("userId",channel,"codeHash","createdAt","expiresAt") VALUES ($1,$2,$3,$4,$5)`,
        [userId, channel, this.digest(userId, code), now, expiresAt],
      );
      await this.audit.record({ type: 'member.contact.code_requested', outcome: 'success', actorId: userId, ip: client.ip, metadata: { channel } }, q);
    });
    // The code travels only in this delivery event (like the operator working code), never in a log or audit row.
    this.bus.publish('member.contact_verification_requested', { userId, channel, destination: channel === 'email' ? u.email : u.phone, code, expiresAt: expiresAt.toISOString() });
  }

  async verify(userId: string, code: string, client: ClientInfo): Promise<void> {
    await this.throttle.hit('contact_verify_ip', client.ip);
    await this.throttle.hit('contact_verify_user', userId);
    const now = this.clock.now();
    const ok = await this.db.tx(async (q) => {
      const { rows } = await q.query(
        `SELECT id, "codeHash", "expiresAt", "attemptCount" FROM member_contact_verification
          WHERE "userId"=$1 AND "consumedAt" IS NULL AND "supersededAt" IS NULL FOR UPDATE`,
        [userId],
      );
      const c = rows[0];
      if (!c || c.expiresAt <= now || c.attemptCount >= MAX_CONTACT_ATTEMPTS) return false;
      if (!safeEqualHex(c.codeHash, this.digest(userId, code))) {
        await q.query(`UPDATE member_contact_verification SET "attemptCount" = "attemptCount" + 1 WHERE id=$1`, [c.id]);
        return false;
      }
      await q.query(`UPDATE member_contact_verification SET "consumedAt"=$2 WHERE id=$1`, [c.id, now]);
      await q.query(`UPDATE "user" SET "contactVerifiedAt"=$2, "updatedAt"=$2 WHERE id=$1 AND "contactVerifiedAt" IS NULL`, [userId, now]);
      await this.audit.record({ type: 'member.contact.verified', outcome: 'success', actorId: userId, ip: client.ip }, q);
      return true;
    });
    if (!ok) {
      await this.audit.tryRecord({ type: 'member.contact.verified', outcome: 'failure', actorId: userId, ip: client.ip });
      throw authError(400, 'contact_code_invalid', GENERIC);
    }
  }
}
