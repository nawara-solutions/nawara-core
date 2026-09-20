import { canonicalJson, sha256Hex, verifySnapshot, type SealedSnapshot, type SnapshotRow } from '@nawara/service-kit';

/**
 * The hierarchy snapshot contract (ADR-0040 decision 5). The exporter lives in auth-service (which holds the hierarchy until the
 * cutover); this service validates and imports it. The two services share NO code: they share this documented shape, checked by
 * the same golden fixture in both test suites. A row carries every column the two schemas have in common and nothing else.
 */
export const HIERARCHY_FORMAT = { format: 'nawara.hierarchy-snapshot', version: 1 } as const;

export const HIERARCHY_TABLES = ['company', 'platform', 'organization'] as const;
export type HierarchyTable = (typeof HIERARCHY_TABLES)[number];

/** Columns per table, in insert order. Timestamps travel as UTC ISO text with microseconds so nothing is lost or reformatted. */
export const HIERARCHY_COLUMNS: Record<HierarchyTable, string[]> = {
  company: ['id', 'name', 'createdAt', 'updatedAt'],
  platform: ['id', 'companyId', 'name', 'key', 'createdAt', 'updatedAt'],
  organization: ['id', 'platformId', 'name', 'taxCode', 'address', 'phone', 'type', 'createdAt', 'updatedAt'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const KEY = /^[a-z][a-z0-9-]{1,39}$/;
const NULLABLE: Record<HierarchyTable, string[]> = { company: [], platform: ['key'], organization: ['taxCode', 'address', 'phone', 'type'] };

/** SQL that reads a table in the snapshot's canonical column form (UTC microsecond ISO timestamps, ids as text). */
export function selectSql(table: HierarchyTable): string {
  const cols = HIERARCHY_COLUMNS[table].map((c) => {
    if (c === 'createdAt' || c === 'updatedAt') return `to_char("${c}" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "${c}"`;
    if (c === 'id' || c.endsWith('Id')) return `"${c}"::text AS "${c}"`;
    return `"${c}"`;
  });
  return `SELECT ${cols.join(', ')} FROM ${table} ORDER BY id::text COLLATE "C"`;
}

/** Digest of the CONTENT (the three tables' digests), independent of the artifact's source and freeze flag. */
export function contentDigest(tableDigests: Record<string, string>): string {
  return sha256Hex(canonicalJson({ company: tableDigests.company, platform: tableDigests.platform, organization: tableDigests.organization }));
}

export interface ValidatedSnapshot {
  snapshot: SealedSnapshot;
  rows: Record<HierarchyTable, SnapshotRow[]>;
  content: string;
}

/**
 * Everything that can be wrong with a snapshot BEFORE it touches a database: integrity (checksums, counts, canonical order),
 * shape (exactly the expected tables and columns), values, duplicate ids, ids used in two tables (I1), and broken relationships.
 * Returns every problem found, never a partial repair.
 */
export function validateHierarchySnapshot(input: unknown): { ok: true; value: ValidatedSnapshot } | { ok: false; errors: string[] } {
  const v = verifySnapshot(input, HIERARCHY_FORMAT);
  if (!v.ok) return { ok: false, errors: v.errors };
  const s = v.snapshot;
  const errors: string[] = [];
  const names = Object.keys(s.tables).sort();
  if (names.join() !== [...HIERARCHY_TABLES].sort().join()) errors.push(`the snapshot must contain exactly the tables ${HIERARCHY_TABLES.join(', ')}`);
  if (errors.length > 0) return { ok: false, errors };

  const seen = new Map<string, HierarchyTable>();
  const ids: Record<HierarchyTable, Set<string>> = { company: new Set(), platform: new Set(), organization: new Set() };
  const keys = new Set<string>();
  for (const t of HIERARCHY_TABLES) {
    const expected = HIERARCHY_COLUMNS[t];
    for (const [i, row] of s.tables[t]!.entries()) {
      const at = `${t}[${i}]`;
      const cols = Object.keys(row).sort();
      if (cols.join() !== [...expected].sort().join()) {
        errors.push(`${at}: unexpected or missing columns (${cols.join(', ')})`);
        continue;
      }
      for (const c of expected) {
        const val = row[c];
        if (val === null) {
          if (!NULLABLE[t].includes(c)) errors.push(`${at}.${c} must not be null`);
        } else if (typeof val !== 'string') errors.push(`${at}.${c} must be text`);
        else if ((c === 'id' || c.endsWith('Id')) && !UUID.test(val)) errors.push(`${at}.${c} is not a canonical uuid`);
        else if ((c === 'createdAt' || c === 'updatedAt') && !ISO.test(val)) errors.push(`${at}.${c} is not a UTC microsecond timestamp`);
        else if (c === 'name' && val.trim() === '') errors.push(`${at}.name is blank`);
        else if (c === 'key' && !KEY.test(val)) errors.push(`${at}.key has an invalid format`);
      }
      const id = row.id as string;
      if (seen.has(id)) errors.push(`${at}: the id ${id} is already used in ${seen.get(id)} (an id is never reused, I1)`);
      else seen.set(id, t);
      ids[t].add(id);
      if (t === 'platform' && typeof row.key === 'string') {
        if (keys.has(row.key)) errors.push(`${at}.key ${row.key} is duplicated`);
        keys.add(row.key);
      }
    }
  }
  for (const [i, row] of s.tables.platform!.entries()) {
    if (!ids.company.has(row.companyId as string)) errors.push(`platform[${i}]: the company ${String(row.companyId)} is not in the snapshot`);
  }
  for (const [i, row] of s.tables.organization!.entries()) {
    if (!ids.platform.has(row.platformId as string)) errors.push(`organization[${i}]: the platform ${String(row.platformId)} is not in the snapshot`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      snapshot: s,
      rows: { company: s.tables.company!, platform: s.tables.platform!, organization: s.tables.organization! },
      content: contentDigest(s.digests.tables),
    },
  };
}
