import type { Queryable } from '../db/db.service.js';
import { HIERARCHY_TABLES, contentDigest, digestRows, sealSnapshot, selectSql, sha256Hex, canonicalJson, type SealedSnapshot } from './snapshot.js';

/** The database side of the ownership transition, as auth-service sees it (ADR-0040). Reachable only from the CLI. */
export type HierarchyMode = 'local' | 'frozen' | 'org_authoritative';

export class HierarchyAuthorityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'HierarchyAuthorityError';
  }
}

interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

export async function hierarchyMode(q: Queryable): Promise<HierarchyMode> {
  const { rows } = await q.query<{ mode: HierarchyMode }>('SELECT mode FROM hierarchy_authority');
  return rows[0]!.mode;
}

/** The reference-cache protocol (later: `ensure`) writes through this and nothing else: the guard accepts it only in this transaction. */
export async function withReferenceWrite(q: Queryable): Promise<void> {
  await q.query(`SELECT set_config('nawara.reference_write', 'on', true)`);
}

async function event(q: Queryable, operation: string, actor: string, from: string | null, to: string | null, detail: object = {}): Promise<void> {
  await q.query('INSERT INTO hierarchy_authority_event (operation, actor, from_mode, to_mode, detail) VALUES ($1,$2,$3,$4,$5::jsonb)', [operation, actor, from, to, JSON.stringify(detail)]);
}

async function refuse(db: Db, operation: string, actor: string, code: string, message: string): Promise<never> {
  const mode = await hierarchyMode(db);
  await event(db, operation, actor, mode, mode, { outcome: 'rejected', code, message });
  throw new HierarchyAuthorityError(code, message);
}

/** A fingerprint of the three tables' column definitions: it changes if Auth's hierarchy schema does, so an artifact records what it was made from. */
export async function schemaFingerprint(q: Queryable): Promise<string> {
  const { rows } = await q.query(
    `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name, column_name`, [[...HIERARCHY_TABLES]]);
  return sha256Hex(canonicalJson(rows));
}

export async function status(db: Db): Promise<Record<string, unknown>> {
  const { rows } = await db.query('SELECT mode, frozen_at, frozen_by, activation_evidence, retired_at, retired_by FROM hierarchy_authority');
  return { ...rows[0], contentDigest: await contentDigestNow(db) };
}

export async function contentDigestNow(q: Queryable): Promise<string> {
  const d: Record<string, string> = {};
  for (const t of HIERARCHY_TABLES) d[t] = digestRows((await q.query(selectSql(t))).rows);
  return contentDigest(d);
}

/** ADR-0040 E2: lock, then marker. Waits for in-flight writers (bounded), then no hierarchy write can happen until unfreeze or the switch. */
export async function freeze(db: Db, actor: string): Promise<void> {
  const mode = await hierarchyMode(db);
  if (mode !== 'local') return refuse(db, 'freeze', actor, 'not_freezable', `the hierarchy is ${mode}; only a local hierarchy can be frozen`);
  await db.tx(async (q) => {
    await q.query(`SET LOCAL lock_timeout = '5s'`);
    await q.query('LOCK TABLE company, platform, organization IN SHARE ROW EXCLUSIVE MODE');
    await q.query(`UPDATE hierarchy_authority SET mode = 'frozen', frozen_at = now(), frozen_by = $1`, [actor]);
    await event(q, 'freeze', actor, 'local', 'frozen');
  });
}

/** Only before the switch. After it there is no way back. */
export async function unfreeze(db: Db, actor: string): Promise<void> {
  const mode = await hierarchyMode(db);
  if (mode !== 'frozen') return refuse(db, 'unfreeze', actor, 'not_frozen', `the hierarchy is ${mode}; only a frozen hierarchy can be unfrozen (and after the switch there is no way back)`);
  await db.tx(async (q) => {
    await q.query(`UPDATE hierarchy_authority SET mode = 'local', frozen_at = NULL, frozen_by = NULL`);
    await event(q, 'unfreeze', actor, 'frozen', 'local');
  });
}

/**
 * The exporter: ONE REPEATABLE READ snapshot, canonical bytes, checksums. `final` means taken under the freeze and is refused otherwise;
 * a preparation export is refused once the hierarchy is only a reference cache (it would export a cache as if it were the authority).
 */
export async function exportHierarchy(db: Db, actor: string, opts: { final: boolean }): Promise<SealedSnapshot> {
  const mode = await hierarchyMode(db);
  if (mode === 'org_authoritative') return refuse(db, 'export', actor, 'not_authoritative', 'auth-service no longer holds the authoritative hierarchy; it cannot export one');
  if (opts.final && mode !== 'frozen') return refuse(db, 'export', actor, 'final_needs_freeze', 'a final export is taken under the freeze; freeze the hierarchy first');
  if (!opts.final && mode === 'frozen') return refuse(db, 'export', actor, 'freeze_needs_final', 'the hierarchy is frozen: take the final export (--final)');
  const sealed = await db.tx(async (q) => {
    await q.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const tables: Record<string, never[]> = {};
    for (const t of HIERARCHY_TABLES) tables[t] = (await q.query(selectSql(t))).rows as never[];
    const m = await hierarchyMode(q);
    if (m !== mode) throw new HierarchyAuthorityError('mode_changed', 'the hierarchy authority changed during the export');
    return sealSnapshot({ source: { service: 'auth-service', schemaFingerprint: await schemaFingerprint(q) }, frozen: opts.final, tables });
  });
  await event(db, 'export', actor, mode, mode, { outcome: 'succeeded', final: opts.final, whole: sealed.digests.whole, counts: sealed.counts });
  return sealed;
}

/**
 * The mirror: retire Auth's hierarchy writes after ACTIVATE AUTHORITY in organization-service. The evidence names that activation. An
 * existing environment must be FROZEN first; a fresh environment (nothing to freeze) says so explicitly. There is no way back.
 */
export async function retireWrites(db: Db, actor: string, evidence: string, opts: { fresh?: boolean } = {}): Promise<void> {
  const mode = await hierarchyMode(db);
  if (!evidence.trim()) return refuse(db, 'retire', actor, 'evidence_required', 'cite the evidence that organization-service was activated (its activation event or content digest)');
  if (mode === 'org_authoritative') return refuse(db, 'retire', actor, 'already_retired', 'the hierarchy writes are already retired');
  if (mode === 'local' && !opts.fresh) return refuse(db, 'retire', actor, 'freeze_first', 'an existing environment must be FROZEN before the switch; a fresh environment passes --fresh');
  await db.tx(async (q) => {
    await q.query(`UPDATE hierarchy_authority SET mode = 'org_authoritative', activation_evidence = $1, retired_at = now(), retired_by = $2`, [evidence, actor]);
    await event(q, 'retire', actor, mode, 'org_authoritative', { evidence });
  });
}
