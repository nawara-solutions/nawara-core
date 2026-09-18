import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Seals owner TOTP shared secrets at rest. A TOTP secret must be RECOVERABLE (the server has to
 * recompute codes), so it is encrypted — never hashed, never plaintext.
 *
 *   algorithm : AES-256-GCM (authenticated encryption)
 *   key       : 32 bytes from the key ring (config), identified by a key id stored beside the
 *               ciphertext (owner_auth_factor.secretKeyId). The key is NEVER stored in the database.
 *   nonce     : 96-bit, fresh from the CSPRNG per encryption (a nonce is never reused under one key)
 *   AAD       : "nawara.totp.v1|ownerId|factorId" — a ciphertext copied onto another factor/owner
 *               row fails authentication instead of decrypting
 *   layout    : version(1) | nonce(12) | ciphertext | tag(16)
 *
 * Rotation: add the new key to the ring, make it active; new/re-sealed rows use it, old rows still
 * open with their recorded key id; `reseal()` moves a row to the active key; remove the old key
 * only after `SELECT count(*) FROM owner_auth_factor WHERE "secretKeyId" = '<old>'` is zero.
 */
const VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;

export interface SealedSecret {
  ciphertext: Buffer;
  keyId: string;
}

export class TotpSecretCipher {
  constructor(
    private readonly keys: Map<string, Buffer>,
    private readonly activeKeyId: string,
  ) {
    const active = keys.get(activeKeyId);
    if (!active || active.length !== 32) throw new Error('active TOTP key missing or not 32 bytes');
  }

  private aad(ownerId: string, factorId: string): Buffer {
    return Buffer.from(`nawara.totp.v1|${ownerId}|${factorId}`);
  }

  seal(plaintext: string, ownerId: string, factorId: string): SealedSecret {
    const nonce = randomBytes(NONCE_LEN);
    const c = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, nonce);
    c.setAAD(this.aad(ownerId, factorId));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return {
      ciphertext: Buffer.concat([Buffer.from([VERSION]), nonce, ct, c.getAuthTag()]),
      keyId: this.activeKeyId,
    };
  }

  open(sealed: Buffer, keyId: string, ownerId: string, factorId: string): string {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`TOTP key "${keyId}" is not in the key ring`);
    if (sealed.length < 1 + NONCE_LEN + TAG_LEN || sealed[0] !== VERSION) throw new Error('bad TOTP ciphertext');
    const nonce = sealed.subarray(1, 1 + NONCE_LEN);
    const tag = sealed.subarray(sealed.length - TAG_LEN);
    const ct = sealed.subarray(1 + NONCE_LEN, sealed.length - TAG_LEN);
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(this.aad(ownerId, factorId));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8'); // throws on any tampering
  }

  /** Re-encrypts under the active key (rotation). */
  reseal(sealed: Buffer, keyId: string, ownerId: string, factorId: string): SealedSecret {
    return this.seal(this.open(sealed, keyId, ownerId, factorId), ownerId, factorId);
  }
}
