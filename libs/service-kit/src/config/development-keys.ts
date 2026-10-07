import { createHash } from 'node:crypto';

/**
 * V2 A2.1 (OD-A2-2): the development secrets this repository publishes (the root `.env.example`, consumed by the local Compose stack),
 * known only by their SHA-256 fingerprint: no published value is repeated in code. Production refuses each of them; development and tests
 * keep working with them. Each entry names the runtime variable that receives it.
 *
 * Fingerprint input: the DECODED bytes of a base64 key (so padded and unpadded spellings match), or the UTF-8 text of a textual secret
 * (a service token), with surrounding whitespace removed, as `EnvReader` reads it. A new published development secret must be added
 * here (A2.5 checks the templates against this catalog).
 */
export const DEVELOPMENT_SECRET_FINGERPRINTS: ReadonlyMap<string, string> = new Map([
  ['f6e3994a11b1e208ef60915cb3b85abe72f4792476c86ea120d1deb98db6bc96', 'FILE_RATE_LIMIT_KEY'], // decoded key bytes
  ['32d5b7dc343c40804b13ff4f1d910d6d082ab68d34c9c2a0922340ba9bd54d76', 'FILE_REQUEST_HASH_KEY'], // decoded key bytes
  ['c9df5a31d270af1026b416b7eb1170e0e1dae1d3314933b8dc06dc3f6642df5c', 'JOIN_CODE_PEPPER'], // decoded key bytes
  ['5b0d9e4caa197262fc32810f31126c64bf907b3ad3ff9367ebf85184c5b2a251', 'JWT_SECRET'], // decoded key bytes
  ['debb5bcc42ea2c448ca4df51179e0458ca8a319a77b585acb851baf05e241840', 'NOTIFICATION_DESTINATION_LIMIT_KEY'], // decoded key bytes
  ['00dc11d97b09a19e474c41199d94ee2fd5c217bb6f5a04eb25500bb9be52e98d', 'NOTIFICATION_REQUEST_HASH_KEY'], // decoded key bytes
  ['7d360ae4d70b474d51887536414d75ea6e1126ce72722e16c644d306472b860d', 'NOTIFICATION_SECRET_KEYS'], // decoded key bytes
  ['bffc7995fa6ba37acc90c002a4d2ed25e531c2f5c9b8005ca05328aa33781da4', 'OPERATOR_CODE_PEPPER'], // decoded key bytes
  ['fec60ecdc8b99d7b4e78db04b2214909841dc483db0535e93dd6f4667fd27833', 'PAYMENT_SERVICE_TOKEN'], // UTF-8 text
  ['3ea5a808366b64f73bc1573d3f92f5dcf15e77f97fe00e415a43060f0e453b2e', 'SECRET_KEY_PEPPER'], // decoded key bytes
  ['d969d25cdd7a01e2964f64dd939a14f5f183085c365cb14ae2dc6baf78933a6b', 'THROTTLE_KEY_PEPPER'], // decoded key bytes
  ['a51115731dfcb1dc52a605dd3f77c9f774ca91a96f62fbb09b97e8839f1bbdca', 'TOTP_ENCRYPTION_KEYS'], // decoded key bytes
]);

/** True when `material` is a development secret published in this repository: a decoded key (Buffer) or a textual secret (string). */
export function isPublishedDevelopmentSecret(material: Buffer | string): boolean {
  const bytes = typeof material === 'string' ? Buffer.from(material.trim(), 'utf8') : material;
  return DEVELOPMENT_SECRET_FINGERPRINTS.has(createHash('sha256').update(bytes).digest('hex'));
}

/**
 * V2 A2.2 (OD-A2.2-1): true when a SHA-256 hex digest is the fingerprint of a published development secret. A callee stores only the
 * digest of a service token (`SERVICE_TOKENS`), and that digest is exactly the token's catalog fingerprint, so the callee can recognise a
 * published token without its plaintext. Internal to the kit: services call `assertNoPublishedServiceTokens`.
 */
export function isPublishedDevelopmentFingerprint(sha256Hex: string): boolean {
  return DEVELOPMENT_SECRET_FINGERPRINTS.has(sha256Hex.toLowerCase());
}
