import { createHash } from 'node:crypto';

/**
 * Deterministic, checksummed snapshot artifacts (ADR-0040 decision 5). TECHNICAL infrastructure only: it knows nothing about what
 * the rows mean. A service supplies the tables and their schema; this module makes the artifact reproducible byte for byte and
 * lets anyone re-verify it offline. A snapshot NEVER records when it was made (that belongs to the audit event), so the same data
 * always produces the same bytes and the same digests.
 */

export type Scalar = string | number | boolean | null;
export type SnapshotRow = Record<string, Scalar>;

export interface SealedSnapshot {
  format: string;
  version: number;
  /** Where the data came from and under which schema (for example migration checksums). Part of the whole-artifact digest. */
  source: Record<string, Scalar | Scalar[]>;
  /** True only when the export was taken under the source's freeze. Part of the whole-artifact digest. */
  frozen: boolean;
  counts: Record<string, number>;
  digests: { tables: Record<string, string>; whole: string };
  tables: Record<string, SnapshotRow[]>;
}

export interface SealInput {
  format: string;
  version: number;
  source: SealedSnapshot['source'];
  frozen: boolean;
  tables: Record<string, SnapshotRow[]>;
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** Deterministic JSON: object keys sorted, no whitespace. Rejects everything that has no single canonical form. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new SnapshotError('a non-finite number has no canonical form');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o).sort();
      return `{${keys
        .map((k) => {
          if (o[k] === undefined) throw new SnapshotError(`undefined value for "${k}" has no canonical form`);
          return `${JSON.stringify(k)}:${canonicalJson(o[k])}`;
        })
        .join(',')}}`;
    }
    default:
      throw new SnapshotError(`a ${typeof value} has no canonical form`);
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Rows are ordered by `id` (ordinal string comparison), the same on every machine and locale. */
function orderRows(rows: SnapshotRow[]): SnapshotRow[] {
  return [...rows].sort((a, b) => {
    const x = String(a.id ?? '');
    const y = String(b.id ?? '');
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

export function digestRows(rows: SnapshotRow[]): string {
  return sha256Hex(canonicalJson(rows));
}

function wholeDigest(s: Pick<SealedSnapshot, 'format' | 'version' | 'source' | 'frozen' | 'counts'> & { tableDigests: Record<string, string> }): string {
  return sha256Hex(canonicalJson({ format: s.format, version: s.version, source: s.source, frozen: s.frozen, counts: s.counts, tables: s.tableDigests }));
}

export function sealSnapshot(input: SealInput): SealedSnapshot {
  const tables: Record<string, SnapshotRow[]> = {};
  const counts: Record<string, number> = {};
  const tableDigests: Record<string, string> = {};
  for (const name of Object.keys(input.tables).sort()) {
    const rows = orderRows(input.tables[name]!);
    tables[name] = rows;
    counts[name] = rows.length;
    tableDigests[name] = digestRows(rows);
  }
  const whole = wholeDigest({ format: input.format, version: input.version, source: input.source, frozen: input.frozen, counts, tableDigests });
  return { format: input.format, version: input.version, source: input.source, frozen: input.frozen, counts, digests: { tables: tableDigests, whole }, tables };
}

/** The bytes written to disk: canonical JSON and one trailing newline. Identical data gives identical bytes. */
export function serializeSnapshot(s: SealedSnapshot): string {
  return `${canonicalJson(s)}\n`;
}

export type VerifyResult = { ok: true; snapshot: SealedSnapshot } | { ok: false; errors: string[] };

/**
 * Independent verification: recomputes every digest and count from the rows. Anything that does not match, or is missing, is an
 * error; nothing is repaired. `expected` pins the format and version so an artifact of another shape is refused.
 */
export function verifySnapshot(input: unknown, expected: { format: string; version: number }): VerifyResult {
  const errors: string[] = [];
  const fail = (m: string): VerifyResult => ({ ok: false, errors: [...errors, m] });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('the artifact is not an object');
  const s = input as Partial<SealedSnapshot>;
  if (s.format !== expected.format) errors.push(`unexpected format: ${String(s.format)}`);
  if (s.version !== expected.version) errors.push(`unexpected version: ${String(s.version)}`);
  if (typeof s.frozen !== 'boolean') errors.push('frozen must be a boolean');
  if (typeof s.source !== 'object' || s.source === null || Array.isArray(s.source)) errors.push('source is missing');
  if (typeof s.tables !== 'object' || s.tables === null || Array.isArray(s.tables)) return fail('tables are missing');
  if (typeof s.digests !== 'object' || s.digests === null || typeof s.digests.tables !== 'object' || typeof s.digests.whole !== 'string') return fail('digests are missing');
  if (typeof s.counts !== 'object' || s.counts === null) return fail('counts are missing');
  if (errors.length > 0) return { ok: false, errors };

  const names = Object.keys(s.tables);
  const digestNames = Object.keys(s.digests.tables);
  if (names.slice().sort().join() !== digestNames.slice().sort().join()) errors.push('the tables and their digests do not list the same tables');
  const recomputed: Record<string, string> = {};
  for (const name of names) {
    const rows = s.tables[name];
    if (!Array.isArray(rows)) {
      errors.push(`table ${name} is not a list of rows`);
      continue;
    }
    let ordered: SnapshotRow[];
    try {
      ordered = orderRows(rows);
      recomputed[name] = digestRows(ordered);
    } catch (e) {
      errors.push(`table ${name}: ${(e as Error).message}`);
      continue;
    }
    if (canonicalJson(ordered) !== canonicalJson(rows)) errors.push(`table ${name} is not in canonical order`);
    if (s.counts[name] !== rows.length) errors.push(`table ${name}: the count ${String(s.counts[name])} does not match ${rows.length} rows`);
    if (s.digests.tables[name] !== recomputed[name]) errors.push(`table ${name}: the digest does not match its rows`);
  }
  if (errors.length === 0) {
    const whole = wholeDigest({ format: s.format!, version: s.version!, source: s.source as SealedSnapshot['source'], frozen: s.frozen!, counts: s.counts, tableDigests: recomputed });
    if (whole !== s.digests.whole) errors.push('the whole-artifact digest does not match');
  }
  return errors.length === 0 ? { ok: true, snapshot: s as SealedSnapshot } : { ok: false, errors };
}
