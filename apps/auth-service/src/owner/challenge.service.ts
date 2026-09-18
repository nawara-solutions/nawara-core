import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CLOCK, type Clock } from '../common/ports.js';
import { randomToken, sha256Hex } from '../crypto/random.js';
import { DbService, type Queryable } from '../db/db.service.js';

export type ChallengeKind = 'login_mfa' | 'enrollment' | 'webauthn_registration' | 'step_up';
export const MAX_CHALLENGE_ATTEMPTS = 5;

export interface ChallengeRow {
  id: string;
  ownerId: string;
  kind: ChallengeKind;
  webauthnChallenge: string | null;
  sessionFamilyId: string | null;
  purpose: string | null;
  attempts: number;
  createdAt: Date;
}

/**
 * Single-use, short-lived challenges. Bearer-style kinds (login_mfa, enrollment) hand the client an
 * opaque 256-bit token and store only its SHA-256. A challenge has NO API authority by itself: it can
 * only be redeemed at the one endpoint family it was issued for, is consumed on success, and dies
 * after MAX_CHALLENGE_ATTEMPTS failed attempts.
 */
@Injectable()
export class ChallengeService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(
    q: Queryable,
    a: { ownerId: string; kind: ChallengeKind; ttlSec: number; bearer?: boolean; webauthnChallenge?: string; sessionFamilyId?: string; purpose?: string },
  ): Promise<{ id: string; token?: string }> {
    const now = this.clock.now();
    const id = randomUUID();
    const token = a.bearer ? randomToken() : undefined;
    await q.query(
      `INSERT INTO owner_auth_challenge(id,"ownerId",kind,"tokenHash","webauthnChallenge","sessionFamilyId",purpose,"createdAt","expiresAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, a.ownerId, a.kind, token ? sha256Hex(token) : null, a.webauthnChallenge ?? null, a.sessionFamilyId ?? null, a.purpose ?? null, now, new Date(now.getTime() + a.ttlSec * 1000)],
    );
    return { id, token };
  }

  /** Live (unconsumed, unexpired) challenge by its bearer token. */
  async findByToken(kind: ChallengeKind, rawToken: string, q: Queryable = this.db): Promise<ChallengeRow | null> {
    const { rows } = await q.query<ChallengeRow>(
      `SELECT id,"ownerId",kind,"webauthnChallenge","sessionFamilyId",purpose,attempts,"createdAt" FROM owner_auth_challenge
        WHERE "tokenHash"=$1 AND kind=$2 AND "consumedAt" IS NULL AND "expiresAt" > $3`,
      [sha256Hex(rawToken), kind, this.clock.now()],
    );
    return rows[0] ?? null;
  }

  async findById(id: string, kind: ChallengeKind, ownerId: string, q: Queryable = this.db): Promise<ChallengeRow | null> {
    const { rows } = await q.query<ChallengeRow>(
      `SELECT id,"ownerId",kind,"webauthnChallenge","sessionFamilyId",purpose,attempts,"createdAt" FROM owner_auth_challenge
        WHERE id=$1 AND kind=$2 AND "ownerId"=$3 AND "consumedAt" IS NULL AND "expiresAt" > $4`,
      [id, kind, ownerId, this.clock.now()],
    );
    return rows[0] ?? null;
  }

  async setWebauthnChallenge(q: Queryable, id: string, challenge: string) {
    await q.query(`UPDATE owner_auth_challenge SET "webauthnChallenge"=$2 WHERE id=$1 AND "consumedAt" IS NULL`, [id, challenge]);
  }

  /** Counts a failed attempt; the challenge is consumed (dead) once attempts are exhausted. */
  async recordFailure(id: string) {
    await this.db.query(
      `UPDATE owner_auth_challenge SET attempts = attempts + 1,
              "consumedAt" = CASE WHEN attempts + 1 >= $2 THEN $3::timestamptz ELSE "consumedAt" END
        WHERE id=$1 AND "consumedAt" IS NULL`,
      [id, MAX_CHALLENGE_ATTEMPTS, this.clock.now()],
    );
  }

  /** Atomic single-use consumption; false if already consumed/expired (race-safe). */
  async consume(q: Queryable, id: string): Promise<boolean> {
    const { rowCount } = await q.query(
      `UPDATE owner_auth_challenge SET "consumedAt"=$2 WHERE id=$1 AND "consumedAt" IS NULL AND "expiresAt" > $2`,
      [id, this.clock.now()],
    );
    return (rowCount ?? 0) === 1;
  }
}
