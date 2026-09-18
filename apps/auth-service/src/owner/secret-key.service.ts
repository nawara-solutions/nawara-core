import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/ports.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { hmacHex } from '../crypto/hmac.js';
import { generateSecretKey, normalizeSecretKey, safeEqualHex } from '../crypto/random.js';
import { DbService, type Queryable } from '../db/db.service.js';

/**
 * Owner secret key = a HIGH-ENTROPY RANDOM (256-bit, CSPRNG) step-up/recovery credential — never
 * the daily login and never human-chosen. Storage: HMAC-SHA-256 keyed with SECRET_KEY_PEPPER (kept
 * outside the DB) over (ownerId, key); lowercase hex, which the DB CHECK also enforces. Because the
 * input already has 256 bits of entropy a slow password hash would add nothing; the pepper means a
 * stolen table cannot even be used to test guesses. The raw key is returned ONCE at issuance and is
 * never stored, logged or returned again.
 */
@Injectable()
export class SecretKeyService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private digest(ownerId: string, normalizedKey: string) {
    return hmacHex(this.cfg.secrets.secretKeyPepper, 'owner.secret_key', ownerId, normalizedKey);
  }

  /** Issues a brand-new key (also used for rotation), invalidating any previous one atomically. */
  async issue(q: Queryable, ownerId: string): Promise<{ secretKey: string; issuedAt: Date }> {
    const key = generateSecretKey();
    const issuedAt = this.clock.now();
    await q.query(`UPDATE owner SET "secretKeyHash"=$2, "secretKeyIssuedAt"=$3, "updatedAt"=$3 WHERE "userId"=$1`, [
      ownerId,
      this.digest(ownerId, normalizeSecretKey(key)!),
      issuedAt,
    ]);
    return { secretKey: key, issuedAt };
  }

  /** Constant-time verification. A null stored hash (no key issued / spent) never matches. */
  async verify(ownerId: string, presented: string, q: Queryable = this.db): Promise<boolean> {
    const { rows } = await q.query<{ secretKeyHash: string | null }>(`SELECT "secretKeyHash" FROM owner WHERE "userId"=$1`, [ownerId]);
    const norm = normalizeSecretKey(presented);
    const candidate = this.digest(ownerId, norm ?? '');
    const stored = rows[0]?.secretKeyHash;
    return !!stored && !!norm && safeEqualHex(candidate, stored);
  }

  /** Spends the key (recovery): the same key can never be used again. */
  async spend(q: Queryable, ownerId: string) {
    await q.query(`UPDATE owner SET "secretKeyHash"=NULL, "secretKeyIssuedAt"=NULL, "updatedAt"=$2 WHERE "userId"=$1`, [ownerId, this.clock.now()]);
  }
}
