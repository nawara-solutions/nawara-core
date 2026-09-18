import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/ports.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { sha256Hex, randomToken } from '../crypto/random.js';
import { DbService, type Queryable } from '../db/db.service.js';

export interface IssuedRefresh {
  raw: string;
  id: string;
  familyId: string;
  expiresAt: Date;
  sessionExpiresAt: Date | null;
}

export type RotateOutcome =
  | ({ ok: true; userId: string } & IssuedRefresh)
  | { ok: false; reason: 'unknown' | 'expired' | 'reuse' | 'revoked' | 'inactive' | 'session_ceiling_reached' };

/**
 * Refresh tokens: 256-bit CSPRNG values, only their SHA-256 is stored (a high-entropy random token
 * needs no slow or peppered hash). One-time use with rotation inside a family (= one session).
 * Reuse of a rotated/revoked token revokes the WHOLE family. An operator ceiling
 * (`sessionExpiresAt`) is copied forward unchanged and clamps every token's expiry; the database
 * also refuses a token that outlives it.
 */
@Injectable()
export class RefreshTokenService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private expiry(now: Date, ceiling: Date | null): Date {
    const e = new Date(now.getTime() + this.cfg.refreshTtlSec * 1000);
    return ceiling && ceiling < e ? ceiling : e;
  }

  async issue(
    q: Queryable,
    a: { userId: string; familyId?: string; sessionExpiresAt?: Date | null },
  ): Promise<IssuedRefresh> {
    const now = this.clock.now();
    const raw = randomToken();
    const id = randomUUID();
    const familyId = a.familyId ?? randomUUID();
    const ceiling = a.sessionExpiresAt ?? null;
    const expiresAt = this.expiry(now, ceiling);
    await q.query(
      `INSERT INTO refresh_token(id, "userId", "tokenHash", "familyId", "expiresAt", "sessionExpiresAt", "createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, a.userId, sha256Hex(raw), familyId, expiresAt, ceiling, now],
    );
    return { raw, id, familyId, expiresAt, sessionExpiresAt: ceiling };
  }

  async rotate(rawToken: string, ip?: string): Promise<RotateOutcome> {
    const now = this.clock.now();
    const outcome = await this.db.tx<RotateOutcome>(async (q) => {
      const { rows } = await q.query(
        `SELECT t.id, t."userId", t."familyId", t."revokedAt", t."replacedByTokenId", t."expiresAt", t."sessionExpiresAt", u."isActive"
           FROM refresh_token t JOIN "user" u ON u.id = t."userId"
          WHERE t."tokenHash" = $1 FOR UPDATE OF t`,
        [sha256Hex(rawToken)],
      );
      const t = rows[0];
      if (!t) return { ok: false, reason: 'unknown' };
      const revokeFamily = () => this.revokeFamily(q, t.familyId, now);

      // Session ceiling first (a clean session end is not a theft signal) ...
      if (t.sessionExpiresAt && now >= t.sessionExpiresAt) {
        await revokeFamily();
        return { ok: false, reason: 'session_ceiling_reached' };
      }
      // ... then reuse detection. A token that was already ROTATED OUT being presented again means
      // two parties hold it (theft signal): the whole session is revoked and the event audited.
      if (t.replacedByTokenId) {
        await revokeFamily();
        await this.audit.record({ type: 'session.refresh_reuse_detected', outcome: 'denied', actorId: t.userId, sessionFamilyId: t.familyId, ip }, q);
        return { ok: false, reason: 'reuse' };
      }
      // A token merely REVOKED (logout, block, recovery, password change) is just refused.
      if (t.revokedAt) return { ok: false, reason: 'revoked' };
      if (t.expiresAt <= now) return { ok: false, reason: 'expired' };
      if (!t.isActive) {
        await revokeFamily();
        return { ok: false, reason: 'inactive' };
      }
      const next = await this.issue(q, { userId: t.userId, familyId: t.familyId, sessionExpiresAt: t.sessionExpiresAt });
      await q.query(`UPDATE refresh_token SET "revokedAt"=$2, "replacedByTokenId"=$3 WHERE id=$1`, [t.id, now, next.id]);
      return { ok: true, userId: t.userId, ...next };
    });
    return outcome;
  }

  revokeFamily(q: Queryable, familyId: string, now: Date = this.clock.now()) {
    return q.query(`UPDATE refresh_token SET "revokedAt" = COALESCE("revokedAt", $2) WHERE "familyId" = $1 AND "revokedAt" IS NULL`, [familyId, now]);
  }

  /** Ends every session of a user (optionally sparing one family, e.g. the current one). */
  revokeAllForUser(q: Queryable, userId: string, exceptFamilyId?: string) {
    return q.query(
      `UPDATE refresh_token SET "revokedAt" = $2 WHERE "userId" = $1 AND "revokedAt" IS NULL AND ($3::uuid IS NULL OR "familyId" <> $3)`,
      [userId, this.clock.now(), exceptFamilyId ?? null],
    );
  }

  /** Is this session (family) still usable? Used by live access checks. */
  async isSessionActive(userId: string, familyId: string, q: Queryable = this.db): Promise<boolean> {
    const { rowCount } = await q.query(
      `SELECT 1 FROM refresh_token WHERE "familyId"=$1 AND "userId"=$2 AND "revokedAt" IS NULL AND "expiresAt" > $3 LIMIT 1`,
      [familyId, userId, this.clock.now()],
    );
    return (rowCount ?? 0) > 0;
  }

  async revokeByRaw(rawToken: string, userId: string) {
    await this.db.query(
      `UPDATE refresh_token SET "revokedAt" = COALESCE("revokedAt", $3) WHERE "familyId" = (SELECT "familyId" FROM refresh_token WHERE "tokenHash" = $1 AND "userId" = $2)`,
      [sha256Hex(rawToken), userId, this.clock.now()],
    );
  }
}
