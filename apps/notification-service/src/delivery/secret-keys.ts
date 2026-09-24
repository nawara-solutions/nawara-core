import type { Queryable } from '@nawara/service-kit';

export interface SecretKeyUsage {
  keyId: string;
  /** Intents whose sealed secret still references this key (not yet purged). */
  liveCiphertexts: number;
  /** The latest `expiresAt` among them (null when one has no expiry: then only its terminal state purges it). */
  latestExpiresAt: Date | null;
  anyWithoutExpiry: boolean;
}

/**
 * Which secret-encryption keys live ciphertext still references (Stage 16.9). Reads key ids and counts only, never a ciphertext, over
 * the partial `notification_secret_expiry_idx` (live secrets only, which the purge keeps small).
 */
export async function secretKeyUsage(q: Queryable): Promise<SecretKeyUsage[]> {
  const { rows } = await q.query<{ keyId: string; n: number; latest: Date | null; noExpiry: boolean }>(
    `SELECT "secretKeyId" AS "keyId", count(*)::int AS n, max("expiresAt") AS latest, bool_or("expiresAt" IS NULL) AS "noExpiry"
       FROM notification WHERE "secretCiphertext" IS NOT NULL GROUP BY "secretKeyId" ORDER BY "secretKeyId"`,
  );
  return rows.map((r) => ({ keyId: r.keyId, liveCiphertexts: r.n, latestExpiresAt: r.latest, anyWithoutExpiry: r.noExpiry }));
}

export type RetirementVerdict = { safe: true } | { safe: false; reason: 'active_key' | 'live_ciphertext'; liveCiphertexts?: number };

/**
 * May `keyId` be removed from NOTIFICATION_SECRET_KEYS? Only if it is not the active key and NO live ciphertext references it (the purge
 * clears every secret at terminal state or `expiresAt`, so waiting past the latest `expiresAt` of rows sealed with it is enough; a
 * secret without expiry holds the key until its deliveries end). Removing a key still in use would make those codes undeliverable
 * (`FAILED render_failed`).
 */
export async function retirementVerdict(q: Queryable, keyId: string, activeKeyId?: string): Promise<RetirementVerdict> {
  if (activeKeyId !== undefined && keyId === activeKeyId) return { safe: false, reason: 'active_key' };
  const use = (await secretKeyUsage(q)).find((u) => u.keyId === keyId);
  return use && use.liveCiphertexts > 0 ? { safe: false, reason: 'live_ciphertext', liveCiphertexts: use.liveCiphertexts } : { safe: true };
}
