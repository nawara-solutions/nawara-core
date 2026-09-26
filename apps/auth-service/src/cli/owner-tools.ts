import { randomUUID } from 'node:crypto';
import type { HierarchyReference } from '../hierarchy/hierarchy-reference.js';
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
  a: { companyName: string; email: string; password: string; companyId?: string },
  /**
   * Stage 21.C.2 (ADR-0040 A1.2 and A2.5 F4; ADR-0042 AD-4): when an authoritative Company id is given, its validated reference row is placed
   * by the reference-cache protocol (`ensure`, from Organization Service) BEFORE the owner is created, and auth-service never inserts a
   * Company of its own. Needs Auth's Organization Service credential; fails closed without it or when Organization Service cannot answer.
   */
  hierarchy?: HierarchyReference,
): Promise<{ created: boolean; ownerId?: string }> {
  assertPasswordPolicy(a.password);
  const hash = await passwords.hash(a.password);
  if (a.companyId && hierarchy) {
    const exists = await (async () => {
      try {
        return await hierarchy.ensure('company', a.companyId!);
      } catch {
        throw new Error('Organization Service could not confirm that Company (unavailable, not yet readable, or the reference write was refused); nothing was created');
      }
    })();
    if (!exists) throw new Error('Organization Service does not know that Company id (or it is outside auth-service\'s credential); nothing was created');
  }
  return db.tx(async (q) => {
    // Check-then-insert is only safe when bootstraps are serialised: otherwise two concurrent runs each
    // see "no owner" and each create a Company + Owner (the one-owner-per-company index cannot stop two
    // DIFFERENT companies).
    await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('auth.bootstrap_owner', 0))`);
    const existing = await q.query(`SELECT "userId" FROM owner LIMIT 1`);
    if (existing.rowCount) return { created: false };
    // ADR-0042 AD-4 / ADR-0040 A1.2: once organization-service is the authority, auth-service NEVER creates a Company. The bootstrap
    // continues with the authoritative Company id, whose validated reference row was placed beforehand (the reference-cache protocol).
    const authority = (await q.query(`SELECT mode FROM hierarchy_authority`)).rows[0]?.mode as string | undefined;
    let companyId: string;
    if (authority === 'org_authoritative') {
      if (!a.companyId) throw new Error('organization-service is the hierarchy authority: pass the authoritative Company id (BOOTSTRAP_COMPANY_ID); auth-service does not create a Company');
      const ref = await q.query(`SELECT id FROM company WHERE id = $1`, [a.companyId]);
      if (!ref.rowCount) throw new Error('no validated reference row exists for that Company id; place it with the reference-cache protocol first (nothing is created here)');
      companyId = ref.rows[0].id;
    } else if (a.companyId && hierarchy) {
      companyId = a.companyId.toLowerCase(); // the validated reference row placed above (a fresh environment's F4): no Company insert
    } else {
      // Stage 21.C.2 (ADR-0040 A1.2 "the local hierarchy write paths are already off"): with Organization Service as the source, even a
      // not-yet-activated (fresh) environment never gets an Auth-created Company.
      if (hierarchy?.fromOrganizationService) throw new Error('the hierarchy source is organization-service: pass the authoritative Company id (BOOTSTRAP_COMPANY_ID); auth-service does not create a Company');
      const company = await q.query(`SELECT id FROM company ORDER BY "createdAt" LIMIT 1`);
      companyId = company.rows[0]?.id ?? (await q.query(`INSERT INTO company(id,name) VALUES ($1,$2) RETURNING id`, [randomUUID(), a.companyName])).rows[0].id;
    }
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

/**
 * Retire-a-key preflight: counts TOTP factors whose sealing key id is NOT in the key ring, i.e. factors
 * that can no longer be opened. It must be 0 before a startup with a reduced ring (and is what makes
 * "remove the old key" safe). Read-only; prints ids and counts only, never key material or secrets.
 */
export async function checkTotpKeys(db: DbService, cipher: TotpSecretCipher): Promise<{ total: number; unreadable: number; byKeyId: Record<string, number> }> {
  const { rows } = await db.query(`SELECT "secretKeyId" AS id, count(*)::int AS n FROM owner_auth_factor WHERE type='totp' AND "revokedAt" IS NULL GROUP BY 1`);
  let total = 0;
  let unreadable = 0;
  const byKeyId: Record<string, number> = {};
  for (const r of rows) {
    total += r.n;
    byKeyId[r.id] = r.n;
    if (!cipher.hasKey(r.id)) unreadable += r.n;
  }
  return { total, unreadable, byKeyId };
}
