import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/ports.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { TotpSecretCipher } from '../crypto/totp-cipher.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { CloneSuspected, WebAuthnService, type StoredPasskey } from './webauthn.service.js';

export interface FactorSummary {
  id: string;
  type: 'totp' | 'webauthn';
  confirmed: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const CONFIRMED = `"confirmedAt" IS NOT NULL AND "revokedAt" IS NULL`;

/**
 * Owner second factors.
 *
 * TOTP: RFC 6238, HMAC-SHA-1 (the interoperable authenticator-app default), 6 digits, 30 s step,
 * ±1 step tolerance (config), secret = 160-bit CSPRNG (otplib). A time step is accepted AT MOST ONCE
 * per factor (owner_auth_factor.lastUsedCounter, updated atomically), so an observed code cannot be
 * replayed inside its validity window. Secrets are sealed with AES-256-GCM (TotpSecretCipher).
 *
 * WebAuthn: verification delegated to @simplewebauthn/server; see WebAuthnService for policy.
 */
@Injectable()
export class FactorService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TotpSecretCipher) private readonly cipher: TotpSecretCipher,
    @Inject(WebAuthnService) private readonly webauthn: WebAuthnService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(ownerId: string, q: Queryable = this.db): Promise<FactorSummary[]> {
    const { rows } = await q.query(
      `SELECT id, type, ("confirmedAt" IS NOT NULL) AS confirmed, "createdAt", "lastUsedAt" FROM owner_auth_factor
        WHERE "ownerId"=$1 AND "revokedAt" IS NULL ORDER BY "createdAt"`,
      [ownerId],
    );
    return rows as FactorSummary[];
  }

  async countConfirmed(ownerId: string, q: Queryable = this.db): Promise<number> {
    const { rows } = await q.query(`SELECT count(*)::int AS n FROM owner_auth_factor WHERE "ownerId"=$1 AND ${CONFIRMED}`, [ownerId]);
    return rows[0].n;
  }

  /** Has this owner EVER had a confirmed factor (even one since revoked)? */
  async everConfirmed(ownerId: string, q: Queryable = this.db): Promise<boolean> {
    const { rowCount } = await q.query(`SELECT 1 FROM owner_auth_factor WHERE "ownerId"=$1 AND "confirmedAt" IS NOT NULL LIMIT 1`, [ownerId]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Once factors are revoked, every outstanding enrollment token dies with them. Otherwise a token
   * obtained earlier (while the owner was still un-enrolled) could be used to plant a new factor
   * after a revocation — bypassing the recovery flow.
   */
  private killEnrollmentTokens(q: Queryable, ownerId: string) {
    return q.query(`UPDATE owner_auth_challenge SET "consumedAt"=$2 WHERE "ownerId"=$1 AND kind='enrollment' AND "consumedAt" IS NULL`, [ownerId, this.clock.now()]);
  }

  async methods(ownerId: string, q: Queryable = this.db): Promise<Array<'totp' | 'webauthn'>> {
    const { rows } = await q.query(`SELECT DISTINCT type FROM owner_auth_factor WHERE "ownerId"=$1 AND ${CONFIRMED}`, [ownerId]);
    return rows.map((r) => r.type);
  }

  // ------------------------------------------------------------------------------------- TOTP
  /** Starts enrollment: stores an UNCONFIRMED factor (unusable until a code is confirmed). */
  async beginTotp(q: Queryable, ownerId: string, accountLabel: string) {
    const factorId = randomUUID();
    const secret = generateSecret();
    const sealed = this.cipher.seal(secret, ownerId, factorId);
    // An abandoned, never-confirmed enrollment is replaced rather than accumulating.
    await q.query(`DELETE FROM owner_auth_factor WHERE "ownerId"=$1 AND type='totp' AND "confirmedAt" IS NULL`, [ownerId]);
    await q.query(
      `INSERT INTO owner_auth_factor(id,"ownerId",type,"secretCiphertext","secretKeyId","createdAt") VALUES ($1,$2,'totp',$3,$4,$5)`,
      [factorId, ownerId, sealed.ciphertext, sealed.keyId, this.clock.now()],
    );
    const otpauthUri = generateURI({ strategy: 'totp', issuer: this.cfg.totp.issuer, label: accountLabel, secret });
    return { factorId, secret, otpauthUri };
  }

  private checkCode(secret: string, code: string): { valid: boolean; timeStep?: number } {
    if (!/^\d{6}$/.test(code)) return { valid: false };
    const r = verifySync({
      secret,
      token: code,
      strategy: 'totp',
      epoch: Math.floor(this.clock.now().getTime() / 1000),
      epochTolerance: this.cfg.totp.epochToleranceSec,
    } as any) as { valid: boolean; timeStep?: number };
    return r.valid ? { valid: true, timeStep: r.timeStep } : { valid: false };
  }

  /** Confirms an enrollment by proving possession (one valid code). Returns true on success. */
  async confirmTotp(q: Queryable, ownerId: string, factorId: string, code: string): Promise<boolean> {
    const { rows } = await q.query(
      `SELECT "secretCiphertext", "secretKeyId" FROM owner_auth_factor WHERE id=$1 AND "ownerId"=$2 AND type='totp' AND "confirmedAt" IS NULL AND "revokedAt" IS NULL`,
      [factorId, ownerId],
    );
    if (!rows[0]) return false;
    const chk = this.checkCode(this.cipher.open(rows[0].secretCiphertext, rows[0].secretKeyId, ownerId, factorId), code);
    if (!chk.valid) return false;
    await q.query(`UPDATE owner_auth_factor SET "confirmedAt"=$2, "lastUsedCounter"=$3, "lastUsedAt"=$2 WHERE id=$1`, [factorId, this.clock.now(), chk.timeStep]);
    return true;
  }

  /** Verifies a TOTP code against any confirmed factor; consumes its time step (replay-proof). */
  async verifyTotp(q: Queryable, ownerId: string, code: string): Promise<{ factorId: string } | null> {
    const { rows } = await q.query(
      `SELECT id, "secretCiphertext", "secretKeyId" FROM owner_auth_factor WHERE "ownerId"=$1 AND type='totp' AND ${CONFIRMED}`,
      [ownerId],
    );
    for (const f of rows) {
      const chk = this.checkCode(this.cipher.open(f.secretCiphertext, f.secretKeyId, ownerId, f.id), code);
      if (!chk.valid) continue;
      // Atomic replay guard: the step must be strictly newer than the last one accepted.
      const { rowCount } = await q.query(
        `UPDATE owner_auth_factor SET "lastUsedCounter"=$2, "lastUsedAt"=$3
          WHERE id=$1 AND ("lastUsedCounter" IS NULL OR "lastUsedCounter" < $2)`,
        [f.id, chk.timeStep, this.clock.now()],
      );
      if (rowCount === 1) return { factorId: f.id };
    }
    return null;
  }

  // -------------------------------------------------------------------------------- WebAuthn
  private async passkeys(ownerId: string, q: Queryable): Promise<StoredPasskey[]> {
    const { rows } = await q.query(
      `SELECT "credentialId", "publicKey", "signCount", transports FROM owner_auth_factor WHERE "ownerId"=$1 AND type='webauthn' AND ${CONFIRMED}`,
      [ownerId],
    );
    return rows.map((r) => ({ credentialId: r.credentialId, publicKey: r.publicKey, signCount: Number(r.signCount), transports: r.transports }));
  }

  async webauthnRegistrationOptions(ownerId: string, label: string, q: Queryable = this.db) {
    return this.webauthn.registrationOptions({ id: ownerId, label }, await this.passkeys(ownerId, q));
  }

  /** Verifies a registration against the server-held challenge and stores the new (confirmed) passkey. */
  async registerWebauthn(q: Queryable, ownerId: string, response: RegistrationResponseJSON, expectedChallenge: string): Promise<string> {
    const c = await this.webauthn.verifyRegistration(response, expectedChallenge);
    const id = randomUUID();
    try {
      const now = this.clock.now();
      await q.query(
        `INSERT INTO owner_auth_factor(id,"ownerId",type,"credentialId","publicKey","signCount",transports,"confirmedAt","createdAt")
         VALUES ($1,$2,'webauthn',$3,$4,$5,$6,$7,$7)`,
        [id, ownerId, c.credentialId, c.publicKey, c.signCount, c.transports, now],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('Credential already registered.');
      throw e;
    }
    return id;
  }

  async webauthnAuthenticationOptions(ownerId: string, q: Queryable = this.db) {
    const creds = await this.passkeys(ownerId, q);
    if (creds.length === 0) throw new BadRequestException('No passkey registered.');
    return this.webauthn.authenticationOptions(creds);
  }

  /**
   * Verifies an assertion. The credential is looked up by the id the client presents but ONLY among
   * this owner's confirmed, non-revoked passkeys, and the signature is verified against the stored
   * public key — a matching credentialId alone proves nothing.
   */
  async verifyWebauthn(q: Queryable, ownerId: string, response: AuthenticationResponseJSON, expectedChallenge: string): Promise<{ factorId: string } | null> {
    let credId: Buffer;
    try {
      credId = Buffer.from(response.id, 'base64url');
    } catch {
      return null;
    }
    const { rows } = await q.query(
      `SELECT id, "credentialId", "publicKey", "signCount", transports FROM owner_auth_factor
        WHERE "ownerId"=$1 AND type='webauthn' AND "credentialId"=$2 AND ${CONFIRMED}`,
      [ownerId, credId],
    );
    const f = rows[0];
    if (!f) return null;
    try {
      const newCounter = await this.webauthn.verifyAssertion(
        response,
        expectedChallenge,
        { credentialId: f.credentialId, publicKey: f.publicKey, signCount: Number(f.signCount), transports: f.transports },
      );
      await q.query(`UPDATE owner_auth_factor SET "signCount"=$2, "lastUsedAt"=$3 WHERE id=$1`, [f.id, newCounter, this.clock.now()]);
      return { factorId: f.id };
    } catch (e) {
      if (e instanceof CloneSuspected) {
        // Do not just fail: a non-advancing counter means the private key may be duplicated.
        await this.revoke(this.db, ownerId, f.id);
        await this.audit.tryRecord({ type: 'owner.webauthn.clone_suspected', outcome: 'denied', actorId: ownerId, targetId: f.id });
      }
      return null;
    }
  }

  // ------------------------------------------------------------------------------- lifecycle
  async revoke(q: Queryable, ownerId: string, factorId: string): Promise<boolean> {
    const { rowCount } = await q.query(
      `UPDATE owner_auth_factor SET "revokedAt"=$3 WHERE id=$1 AND "ownerId"=$2 AND "revokedAt" IS NULL`,
      [factorId, ownerId, this.clock.now()],
    );
    if (rowCount) await this.killEnrollmentTokens(q, ownerId);
    return (rowCount ?? 0) === 1;
  }

  /** Removal that can never leave an owner with zero confirmed factors. */
  async removeSafely(q: Queryable, ownerId: string, factorId: string): Promise<void> {
    const { rows } = await q.query(`SELECT ("confirmedAt" IS NOT NULL) AS confirmed FROM owner_auth_factor WHERE id=$1 AND "ownerId"=$2 AND "revokedAt" IS NULL FOR UPDATE`, [factorId, ownerId]);
    if (!rows[0]) throw new NotFoundException();
    if (rows[0].confirmed && (await this.countConfirmed(ownerId, q)) <= 1) {
      throw new ConflictException('You cannot remove your only authentication factor.');
    }
    await this.revoke(q, ownerId, factorId);
  }

  async revokeAll(q: Queryable, ownerId: string) {
    await q.query(`UPDATE owner_auth_factor SET "revokedAt"=$2 WHERE "ownerId"=$1 AND "revokedAt" IS NULL`, [ownerId, this.clock.now()]);
    await this.killEnrollmentTokens(q, ownerId);
  }
}
