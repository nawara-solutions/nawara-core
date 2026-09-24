import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { canonicalJson } from '@nawara/service-kit';

/**
 * Seals a notification's secret template variables (one-time codes) at rest (SDD §12.1; Auth's TOTP key-ring pattern). A code must be
 * RECOVERABLE until it is sent, so it is encrypted, never hashed, and never stored in `notification.data`.
 *
 *   algorithm : AES-256-GCM (authenticated encryption)
 *   key       : 32 bytes from the key ring (configuration), identified by `secretKeyId` beside the ciphertext; never in the database
 *   nonce     : 96-bit, fresh from the CSPRNG per seal
 *   AAD       : "nawara.notification.v1|<notificationId>": a ciphertext copied onto another notification fails authentication
 *   plaintext : the canonical JSON of all the notification's secret variables, sealed together
 *   layout    : version(1) | nonce(12) | ciphertext | tag(16)
 *
 * Rotation: add a key and make it active; old rows still open with their recorded key id; remove a key once no row references it
 * (codes live until their `expiresAt`, and the ciphertext is purged by then: Stage 16.7).
 */
const VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;

export interface SealedSecrets {
  ciphertext: Buffer;
  keyId: string;
}

export class NotificationSecretCipher {
  constructor(
    private readonly keys: Map<string, Buffer>,
    private readonly activeKeyId: string,
  ) {
    if (keys.get(activeKeyId)?.length !== 32) throw new Error('the active notification secret key is missing or not 32 bytes');
  }

  private aad(notificationId: string): Buffer {
    return Buffer.from(`nawara.notification.v1|${notificationId}`);
  }

  seal(secrets: Record<string, string>, notificationId: string): SealedSecrets {
    const nonce = randomBytes(NONCE_LEN);
    const c = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, nonce);
    c.setAAD(this.aad(notificationId));
    const ct = Buffer.concat([c.update(canonicalJson(secrets), 'utf8'), c.final()]);
    return { ciphertext: Buffer.concat([Buffer.from([VERSION]), nonce, ct, c.getAuthTag()]), keyId: this.activeKeyId };
  }

  /** Throws on an unknown key id, a malformed ciphertext or ANY tampering (including a ciphertext moved to another notification). */
  open(sealed: Buffer, keyId: string, notificationId: string): Record<string, string> {
    const key = this.keys.get(keyId);
    if (!key) throw new Error('the notification secret key is not in the key ring');
    if (sealed.length < 1 + NONCE_LEN + TAG_LEN || sealed[0] !== VERSION) throw new Error('malformed notification secret ciphertext');
    const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 1 + NONCE_LEN));
    d.setAAD(this.aad(notificationId));
    d.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
    return JSON.parse(Buffer.concat([d.update(sealed.subarray(1 + NONCE_LEN, sealed.length - TAG_LEN)), d.final()]).toString('utf8'));
  }
}
