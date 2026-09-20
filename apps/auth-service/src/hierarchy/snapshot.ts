import { createHash } from 'node:crypto';

/**
 * The hierarchy snapshot (ADR-0040 decision 5), exporter side. auth-service holds the hierarchy until the cutover; organization-service
 * validates and imports the artifact. The two services SHARE NO CODE (Auth deploys on its own): they share this documented shape, and
 * the same golden fixture in both test suites (compared byte for byte by `npm run check:repo`) proves the two implementations agree.
 * The canonical form is: object keys sorted, no whitespace, UTC microsecond ISO timestamps, rows ordered by id (ordinal).
 */
export const HIERARCHY_FORMAT = { format: 'nawara.hierarchy-snapshot', version: 1 } as const;
export const HIERARCHY_TABLES = ['company', 'platform', 'organization'] as const;
export type HierarchyTable = (typeof HIERARCHY_TABLES)[number];

export const HIERARCHY_COLUMNS: Record<HierarchyTable, string[]> = {
  company: ['id', 'name', 'createdAt', 'updatedAt'],
  platform: ['id', 'companyId', 'name', 'key', 'createdAt', 'updatedAt'],
  organization: ['id', 'platformId', 'name', 'taxCode', 'address', 'phone', 'type', 'createdAt', 'updatedAt'],
};

export type Scalar = string | number | boolean | null;
export type SnapshotRow = Record<string, Scalar>;

export function selectSql(table: HierarchyTable): string {
  const cols = HIERARCHY_COLUMNS[table].map((c) => {
    if (c === 'createdAt' || c === 'updatedAt') return `to_char("${c}" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "${c}"`;
    if (c === 'id' || c.endsWith('Id')) return `"${c}"::text AS "${c}"`;
    return `"${c}"`;
  });
  return `SELECT ${cols.join(', ')} FROM ${table} ORDER BY id::text COLLATE "C"`;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('a non-finite number has no canonical form');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
      const o = value as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => {
        if (o[k] === undefined) throw new Error(`undefined value for "${k}" has no canonical form`);
        return `${JSON.stringify(k)}:${canonicalJson(o[k])}`;
      }).join(',')}}`;
    }
    default:
      throw new Error(`a ${typeof value} has no canonical form`);
  }
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
export const digestRows = (rows: SnapshotRow[]): string => sha256Hex(canonicalJson(rows));

/** Digest of the CONTENT (the three tables' digests), independent of the source and the freeze flag: the cross-check with organization-service. */
export const contentDigest = (d: Record<string, string>): string => sha256Hex(canonicalJson({ company: d.company, platform: d.platform, organization: d.organization }));

export interface SealedSnapshot {
  format: string;
  version: number;
  source: Record<string, Scalar>;
  frozen: boolean;
  counts: Record<string, number>;
  digests: { tables: Record<string, string>; whole: string };
  tables: Record<string, SnapshotRow[]>;
}

const orderRows = (rows: SnapshotRow[]): SnapshotRow[] => [...rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

export function sealSnapshot(input: { source: SealedSnapshot['source']; frozen: boolean; tables: Record<string, SnapshotRow[]> }): SealedSnapshot {
  const tables: Record<string, SnapshotRow[]> = {};
  const counts: Record<string, number> = {};
  const tableDigests: Record<string, string> = {};
  for (const name of Object.keys(input.tables).sort()) {
    tables[name] = orderRows(input.tables[name]!);
    counts[name] = tables[name]!.length;
    tableDigests[name] = digestRows(tables[name]!);
  }
  const whole = sha256Hex(canonicalJson({ format: HIERARCHY_FORMAT.format, version: HIERARCHY_FORMAT.version, source: input.source, frozen: input.frozen, counts, tables: tableDigests }));
  return { ...HIERARCHY_FORMAT, source: input.source, frozen: input.frozen, counts, digests: { tables: tableDigests, whole }, tables };
}

/** The bytes written to disk: canonical JSON and one trailing newline. */
export const serializeSnapshot = (s: SealedSnapshot): string => `${canonicalJson(s)}\n`;
