import { createHash, randomBytes } from 'node:crypto';
import { ConfigError } from '../config/config.js';

/** One accepted credential: which calling service it identifies and the SHA-256 digest of its token. */
export interface ServiceTokenEntry {
  caller: string;
  digest: string;
}

const CALLER = /^[a-z][a-z0-9-]{1,62}$/;
const DIGEST = /^[0-9a-f]{64}$/;
export const MAX_TOKENS_PER_CALLER = 2; // two at most, so a token can be rotated without downtime

export function hashServiceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Creates a new service token (shown once to the caller's operator) and the digest the callee stores. */
export function generateServiceToken(): { token: string; digest: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, digest: hashServiceToken(token) };
}

/**
 * Parses `SERVICE_TOKENS=<caller>:<sha256-hex>[,<caller>:<sha256-hex>...]`. The callee never stores a raw token, so a leaked
 * callee environment does not reveal what the caller sends. Errors never echo the input.
 */
export function parseServiceTokens(raw: string | undefined): ServiceTokenEntry[] {
  const entries: ServiceTokenEntry[] = [];
  if (!raw) return entries;
  const seen = new Set<string>();
  const perCaller = new Map<string, number>();
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(':');
    const caller = idx > 0 ? part.slice(0, idx) : '';
    const digest = idx > 0 ? part.slice(idx + 1) : '';
    if (!CALLER.test(caller) || !DIGEST.test(digest)) {
      throw new ConfigError('SERVICE_TOKENS entries must look like <caller>:<64 hex characters of a SHA-256 digest>');
    }
    if (seen.has(digest)) throw new ConfigError('SERVICE_TOKENS contains a duplicate digest');
    seen.add(digest);
    const n = (perCaller.get(caller) ?? 0) + 1;
    if (n > MAX_TOKENS_PER_CALLER) throw new ConfigError(`SERVICE_TOKENS allows at most ${MAX_TOKENS_PER_CALLER} tokens per caller`);
    perCaller.set(caller, n);
    entries.push({ caller, digest });
  }
  return entries;
}
