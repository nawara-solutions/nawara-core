/**
 * Layered sensitive-data defense (ADR-0049 A29, A30). The PRIMARY defense is structural: every level of the payload has a closed key
 * set and `changes` keys are an allow-list per action, and every value has a grammar or a closed enumeration. These checks are the
 * second layer, run first so a credential-shaped field is refused with a specific reason (and counted as such by 18.5) rather than as a
 * mere unknown field. They cannot detect every secret: a secret disguised as a legitimate enum value is outside what any validator can
 * know (T10 residual). No check here ever echoes the value it refused.
 */

/** Fragments searched in the key after removing every non-alphanumeric character and lowercasing (`api_key`, `apiKey`, `API-KEY`). */
const FORBIDDEN_FRAGMENTS = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'authorization', 'bearer', 'cookie', 'credential',
  'privatekey', 'recoverycode', 'resetcode', 'ticket', 'storagekey', 'objectkey', 'signedurl', 'presigned', 'cardnumber',
  'iban', 'swift', 'email', 'phone', 'msisdn', 'ipaddress', 'useragent', 'fullname', 'firstname', 'lastname', 'address',
  'birth', 'assertion', 'attestation', 'hash', 'salt', 'nonce', 'session',
] as const;

/** Whole words (after splitting on `_`, `-`, `.` and camelCase) that are too short to search as fragments without false positives. */
const FORBIDDEN_WORDS = new Set(['otp', 'pin', 'pan', 'cvv', 'cvc', 'ip', 'jwt', 'sid', 'mfa', 'totp', 'key', 'ua', 'name', 'dob']);

function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** True when a key names a credential, secret or personal-contact concept. */
export function isSensitiveKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (FORBIDDEN_FRAGMENTS.some((f) => flat.includes(f))) return true;
  return words(key).some((w) => FORBIDDEN_WORDS.has(w));
}

const JWT_LIKE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const LONG_HEX = /[0-9a-fA-F]{32,}/;
const LONG_OPAQUE_RUN = /[A-Za-z0-9+/_-]{32,}/;
const UUID_ANYWHERE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * True when a string looks like a secret: a JWT, a long hex digest or key, or a long unbroken base64 / base64url run. UUIDs are
 * removed first (they are identifiers). A long run of lowercase letters and underscores alone does not match (no digits, no case mix);
 * a test proves no value of the catalog's enumerations is secret-shaped.
 */
export function isSecretShaped(value: string): boolean {
  if (JWT_LIKE.test(value)) return true;
  const withoutUuids = value.replace(UUID_ANYWHERE, ' ');
  if (LONG_HEX.test(withoutUuids)) return true;
  for (const m of withoutUuids.matchAll(new RegExp(LONG_OPAQUE_RUN.source, 'g'))) {
    const run = m[0];
    // A long run is secret-shaped when it mixes character classes the way encoded key material does (digits with letters, or case).
    if (/\d/.test(run) && /[A-Za-z]/.test(run)) return true;
    if (/[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  return false;
}
