import { createHash } from 'node:crypto';

/**
 * A stable JSON form: object keys sorted, bigint as a decimal string, Date as an ISO instant. The same logical request always gives the
 * same bytes, whatever order a client sent its keys in, so "identical replay" is a comparison of hashes (SDD 25).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalise);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, normalise((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function requestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
