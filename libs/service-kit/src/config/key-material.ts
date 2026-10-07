import { ConfigError, type EnvReader } from './config.js';
import { isPublishedDevelopmentSecret } from './development-keys.js';

/**
 * V2 A2.1 (OD-A2-3): the one strict reading of configured key material (HMAC keys, encryption keys, key rings), replacing the copies the
 * services carried. Every error is a `ConfigError` naming the variable and the rule, never the value, the decoded bytes or a fingerprint.
 */
export interface KeyRules {
  /** Production refuses published development keys and keys that do not look random. */
  isProduction: boolean;
  /** Minimum decoded length in bytes (default 32). Ignored when `exactBytes` is set. */
  minBytes?: number;
  /** Exact decoded length in bytes (for example an AES-256 key). */
  exactBytes?: number;
}

/** A key-ring id: what `NOTIFICATION_SECRET_KEYS` and Auth's `TOTP_ENCRYPTION_KEYS` already accept. */
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Standard base64 only (A-Z a-z 0-9 + /), canonical: padding is optional but, when present, exactly what the length needs, and the text
 * must be what re-encoding the decoded bytes gives. `Buffer.from(x, 'base64')` alone silently drops invalid characters and accepts the
 * URL-safe alphabet, so a typo could shorten a key without anyone noticing.
 */
function strictBase64(raw: string): Buffer | undefined {
  const m = /^([A-Za-z0-9+/]+)(={0,2})$/.exec(raw);
  if (!m) return undefined;
  const [, body, padding] = m;
  if (body.length % 4 === 1) return undefined;
  if (padding !== '' && (body.length + padding.length) % 4 !== 0) return undefined;
  const bytes = Buffer.from(body, 'base64');
  return bytes.toString('base64').replace(/=+$/, '') === body ? bytes : undefined;
}

/**
 * The production-only randomness floor carried over from Notification (Stage 16.9): fewer than 12 distinct byte values among the first 32
 * bytes. A random 32-byte key has about 30; a key typed by hand or derived from a short phrase does not.
 */
const looksRandom = (key: Buffer): boolean => new Set(key.subarray(0, 32)).size >= 12;

/** Decodes and checks one key. `name` is the variable reported in errors. */
export function decodeKey(name: string, raw: string, rules: KeyRules): Buffer {
  const key = strictBase64(raw);
  if (key === undefined) throw new ConfigError(`${name} must be standard base64 (A-Z, a-z, 0-9, + and /; padding optional but correct)`);
  if (rules.exactBytes !== undefined) {
    if (key.length !== rules.exactBytes) throw new ConfigError(`${name} must decode to exactly ${rules.exactBytes} bytes`);
  } else {
    const min = rules.minBytes ?? 32;
    if (key.length < min) throw new ConfigError(`${name} must decode to at least ${min} bytes`);
  }
  if (rules.isProduction) {
    if (isPublishedDevelopmentSecret(key)) throw new ConfigError(`${name} is a published development key and is refused in production`);
    if (!looksRandom(key)) throw new ConfigError(`${name} does not look random and is refused in production`);
  }
  return key;
}

/** A required key. */
export function readKey(reader: EnvReader, name: string, rules: KeyRules): Buffer {
  return decodeKey(name, reader.required(name), rules);
}

/** An optional key: undefined when unset. */
export function readOptionalKey(reader: EnvReader, name: string, rules: KeyRules): Buffer | undefined {
  const raw = reader.get(name);
  return raw === undefined ? undefined : decodeKey(name, raw, rules);
}

/**
 * A key ring `id:base64[,id:base64]` plus the variable naming its active id. Ids follow `KEY_ID`; an id or a key may not repeat; the active
 * id must name a ring entry.
 */
export function readKeyRing(
  reader: EnvReader,
  name: string,
  activeIdName: string,
  rules: KeyRules,
): { keys: Map<string, Buffer>; activeKeyId: string } {
  const keys = new Map<string, Buffer>();
  for (const entry of reader.required(name).split(',')) {
    const i = entry.indexOf(':');
    const id = i < 0 ? '' : entry.slice(0, i).trim();
    if (!KEY_ID.test(id)) throw new ConfigError(`${name} must be "id:base64[,id:base64]" with ids of 1 to 32 letters, digits, _ or -`);
    if (keys.has(id)) throw new ConfigError(`${name} must not repeat a key id`);
    keys.set(id, decodeKey(name, entry.slice(i + 1).trim(), rules));
  }
  assertDistinctKeys([...keys.values()].map((key) => [name, key] as const));
  const activeKeyId = reader.required(activeIdName);
  if (!keys.has(activeKeyId)) throw new ConfigError(`${activeIdName} does not name a key in ${name}`);
  return { keys, activeKeyId };
}

/** One key, one purpose: no key material may appear twice, within one variable or across variables. */
export function assertDistinctKeys(entries: ReadonlyArray<readonly [label: string, key: Buffer]>): void {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (!entries[i][1].equals(entries[j][1])) continue;
      throw new ConfigError(entries[i][0] === entries[j][0]
        ? `${entries[i][0]} must not repeat a key`
        : `${entries[j][0]} must differ from ${entries[i][0]} (one key, one purpose)`);
    }
  }
}
