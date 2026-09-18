import { randomUUID } from 'node:crypto';
import { assertPasswordPolicy, PasswordService } from '../crypto/password.js';
import type { TotpSecretCipher } from '../crypto/totp-cipher.js';
import type { DbService } from '../db/db.service.js';
import type { UsersService } from '../users/users.service.js';

/**
 * First-owner bootstrap (ADR-0016, company-scoped per ADR-0022). Idempotent and refusing:
 *   - creates the Company if there is none,
 *   - refuses if an owner already exists (exactly one owner per company; nothing is ever replaced),
 *   - creates User(kind=owner) + Owner in ONE transaction,
 *   - mints NO secret key and enrolls NO factor: the owner's first sign-in is `enrollment_required`
 *     and they enroll a TOTP/passkey themselves. The bootstrap password is therefore a ONE-TIME
 *     credential — it must be delivered over a secure out-of-band channel and the owner must enroll
 *     before anyone else learns it (residual risk documented in docs/security).
 */
export async function bootstrapOwner(
  db: DbService, users: UsersService, passwords: PasswordService,
  a: { companyName: string; email: string; password: string },
): Promise<{ created: boolean; ownerId?: string }> {
  assertPasswordPolicy(a.password);
  const hash = await passwords.hash(a.password);
  return db.tx(async (q) => {
    const existing = await q.query(`SELECT "userId" FROM owner LIMIT 1`);
    if (existing.rowCount) return { created: false };
    const company = await q.query(`SELECT id FROM company ORDER BY "createdAt" LIMIT 1`);
    const companyId: string = company.rows[0]?.id ?? (await q.query(`INSERT INTO company(id,name) VALUES ($1,$2) RETURNING id`, [randomUUID(), a.companyName])).rows[0].id;
    const owner = await users.createOwner({ companyId, email: a.email.trim().toLowerCase(), passwordHash: hash }, q);
    return { created: true, ownerId: owner.id };
  });
}

/**
 * TOTP key rotation step: re-encrypts every TOTP secret still sealed under an OLD key with the ACTIVE
 * key. Run after adding a new key to TOTP_ENCRYPTION_KEYS and switching TOTP_ENCRYPTION_ACTIVE_KEY_ID;
 * only when `remaining` is 0 may the old key be removed from the ring. Each row is rewritten
 * atomically; a failure on one row aborts that row only. Secrets are never printed or logged.
 */
export async function resealTotpSecrets(db: DbService, cipher: TotpSecretCipher, activeKeyId: string): Promise<{ resealed: number; remaining: number }> {
  const { rows } = await db.query(`SELECT id, "ownerId", "secretCiphertext", "secretKeyId" FROM owner_auth_factor WHERE type='totp' AND "secretKeyId" <> $1`, [activeKeyId]);
  let resealed = 0;
  for (const r of rows) {
    const s = cipher.reseal(r.secretCiphertext, r.secretKeyId, r.ownerId, r.id);
    const upd = await db.query(`UPDATE owner_auth_factor SET "secretCiphertext"=$2, "secretKeyId"=$3 WHERE id=$1 AND "secretKeyId"=$4`, [r.id, s.ciphertext, s.keyId, r.secretKeyId]);
    resealed += upd.rowCount ?? 0;
  }
  const left = await db.query(`SELECT count(*)::int n FROM owner_auth_factor WHERE type='totp' AND "secretKeyId" <> $1`, [activeKeyId]);
  return { resealed, remaining: left.rows[0].n };
}
