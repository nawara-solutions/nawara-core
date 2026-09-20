import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapOwner } from '../src/cli/owner-tools.js';
import { PasswordService } from '../src/crypto/password.js';
import { DbService } from '../src/db/db.service.js';
import { HierarchyAuthorityError, contentDigestNow, exportHierarchy, freeze, hierarchyMode, retireWrites, status, unfreeze, withReferenceWrite } from '../src/hierarchy/hierarchy-authority.js';
import { serializeSnapshot } from '../src/hierarchy/snapshot.js';
import { UsersService } from '../src/users/users.service.js';
import { createTestApp, type TestCtx } from './helpers/app.js';

/** The same ids and values as organization-service's test builder; the golden fixture below is compared byte for byte in both suites. */
const ID = {
  co: 'c0000000-0000-4000-8000-000000000001',
  p1: 'a0000000-0000-4000-8000-000000000001',
  p2: 'a0000000-0000-4000-8000-000000000002',
  o1: 'b0000000-0000-4000-8000-000000000001',
  o2: 'b0000000-0000-4000-8000-000000000002',
};
const FIXTURE = join(import.meta.dirname, 'fixtures/hierarchy-snapshot.v1.json');

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
}
async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HierarchyAuthorityError);
    return (e as HierarchyAuthorityError).code;
  }
  throw new Error('expected a refusal');
}

describe('hierarchy authority: freeze, deterministic export, the mirror and the reference cache (ADR-0040)', () => {
  let t: TestCtx;
  let db: DbService;
  beforeAll(async () => {
    t = await createTestApp();
    db = t.app.get(DbService);
  });
  afterAll(() => t.close());

  it('is inert: the migration leaves the hierarchy local, and every existing write path still works', async () => {
    expect(await hierarchyMode(db)).toBe('local');
    await db.query(`INSERT INTO company (id, name, "createdAt", "updatedAt") VALUES ($1, 'Acme Holdings', '2024-01-02T03:04:05.123456Z', '2024-01-02T03:04:05.123456Z')`, [ID.co]);
    await db.query(`INSERT INTO platform (id, "companyId", name, key, "createdAt", "updatedAt") VALUES ($1, $3, 'Alpha', 'alpha', '2024-01-02T03:04:05.123456Z', '2024-02-03T04:05:06.654321Z'), ($2, $3, 'Beta', NULL, '2024-01-02T03:04:05.123456Z', '2024-01-02T03:04:05.123456Z')`, [ID.p1, ID.p2, ID.co]);
    await db.query(`INSERT INTO organization (id, "platformId", name, "taxCode", address, phone, type, "createdAt", "updatedAt") VALUES
      ($1, $3, 'Org One', 'TX-1', '1 Main St', '+21611111111', 'school', '2024-01-02T03:04:05.123456Z', '2024-02-03T04:05:06.654321Z'),
      ($2, $4, 'Org Two', NULL, NULL, NULL, NULL, '2024-01-02T03:04:05.123456Z', '2024-01-02T03:04:05.123456Z')`, [ID.o1, ID.o2, ID.p1, ID.p2]);
    expect((await db.query('SELECT count(*)::int n FROM organization')).rows[0].n).toBe(2);
  });

  it('exports deterministically: identical bytes every time, matching the golden fixture that organization-service also verifies', async () => {
    const a = serializeSnapshot(await exportHierarchy(db, 'op', { final: false }));
    const b = serializeSnapshot(await exportHierarchy(db, 'op', { final: false }));
    expect(a).toBe(b);
    if (process.env.UPDATE_FIXTURE === '1') writeFileSync(FIXTURE, a);
    expect(existsSync(FIXTURE), 'run once with UPDATE_FIXTURE=1 to create the golden fixture').toBe(true);
    expect(a).toBe(readFileSync(FIXTURE, 'utf8'));
    const s = JSON.parse(a);
    expect(s).toMatchObject({ format: 'nawara.hierarchy-snapshot', version: 1, frozen: false, counts: { company: 1, platform: 2, organization: 2 } });
    expect(s.source.service).toBe('auth-service');
  });

  it('a final export is refused unless the hierarchy is frozen', async () => {
    expect(await refused(exportHierarchy(db, 'op', { final: true }))).toBe('final_needs_freeze');
  });

  it('freeze: no hierarchy write of any kind; only a final export; unfreeze restores the writes', async () => {
    await freeze(db, 'op');
    expect(await hierarchyMode(db)).toBe('frozen');
    expect(await code(db.query(`INSERT INTO company (name) VALUES ('X')`))).toBe('55000');
    expect(await code(db.query(`UPDATE company SET name = 'X'`))).toBe('55000');
    expect(await code(db.query(`DELETE FROM organization`))).toBe('55000');
    expect(await code(db.query(`TRUNCATE company CASCADE`))).toBe('55000');
    expect(await refused(freeze(db, 'op'))).toBe('not_freezable');
    expect(await refused(exportHierarchy(db, 'op', { final: false }))).toBe('freeze_needs_final');
    const fin = await exportHierarchy(db, 'op', { final: true });
    expect(fin.frozen).toBe(true);
    // the same hierarchy content, however it was exported
    expect(await contentDigestNow(db)).toBeTruthy();
    await unfreeze(db, 'op');
    expect(await hierarchyMode(db)).toBe('local');
    await db.query(`UPDATE company SET name = 'Acme Holdings' WHERE id = $1`, [ID.co]);
    expect(await refused(unfreeze(db, 'op'))).toBe('not_frozen');
  });

  it('every operation, rejected ones included, is audited with the actor', async () => {
    const ev = (await db.query('SELECT operation, actor, from_mode, to_mode, detail FROM hierarchy_authority_event ORDER BY id')).rows;
    expect(ev.map((e) => e.operation)).toEqual(expect.arrayContaining(['export', 'freeze', 'unfreeze']));
    expect(ev.every((e) => e.actor === 'op')).toBe(true);
    expect(ev.some((e) => e.detail.outcome === 'rejected')).toBe(true);
    expect(await code(db.query(`UPDATE hierarchy_authority_event SET actor = 'x'`))).toBe('55000');
  });

  it('the mirror: retirement needs evidence and (in an existing environment) the freeze; after it there is no way back', async () => {
    expect(await refused(retireWrites(db, 'op', 'activation-event-1'))).toBe('freeze_first');
    await freeze(db, 'op');
    expect(await refused(retireWrites(db, 'op', '  '))).toBe('evidence_required');
    await retireWrites(db, 'op', 'organization-service activation event #1, content digest ' + (await contentDigestNow(db)));
    expect(await hierarchyMode(db)).toBe('org_authoritative');
    expect((await status(db)).retired_by).toBe('op');
    expect(await refused(retireWrites(db, 'op', 'again'))).toBe('already_retired');
    expect(await refused(unfreeze(db, 'op'))).toBe('not_frozen');
    expect(await refused(exportHierarchy(db, 'op', { final: false }))).toBe('not_authoritative');
    for (const back of ['local', 'frozen']) expect(await code(db.query(`UPDATE hierarchy_authority SET mode = '${back}'`))).toBe('55000');
    expect(await code(db.query(`DELETE FROM hierarchy_authority`))).toBe('55000');
  });

  it('after the switch auth-service is only a reference cache: no free write, no delete, no reparenting, and never a second authority', async () => {
    expect(await code(db.query(`INSERT INTO company (name) VALUES ('Rogue')`))).toBe('55000');
    expect(await code(db.query(`UPDATE company SET name = 'Rogue' WHERE id = $1`, [ID.co]))).toBe('55000');
    expect(await code(db.query(`DELETE FROM organization`))).toBe('55000');
    expect(await code(db.query(`TRUNCATE company CASCADE`))).toBe('55000');
    // The reference-cache protocol may place a validated row and refresh a descriptive field...
    await db.tx(async (q) => {
      await withReferenceWrite(q);
      await q.query(`INSERT INTO company (id, name) VALUES ('c0000000-0000-4000-8000-000000000009', 'Reference Co')`);
      await q.query(`UPDATE platform SET name = 'Alpha (renamed upstream)' WHERE id = $1`, [ID.p1]);
    });
    expect((await db.query(`SELECT name FROM platform WHERE id = $1`, [ID.p1])).rows[0].name).toBe('Alpha (renamed upstream)');
    // ...but never deletes, and never changes an anchor (I2(a)).
    expect(await code(db.tx(async (q) => { await withReferenceWrite(q); await q.query(`DELETE FROM organization`); }))).toBe('55000');
    expect(await code(db.tx(async (q) => { await withReferenceWrite(q); await q.query(`UPDATE organization SET "platformId" = $2 WHERE id = $1`, [ID.o1, ID.p2]); }))).not.toBeUndefined();
  });

  it('bootstrap-owner in the authoritative mode never creates a Company: it needs the Company id and an existing validated reference row', async () => {
    const args = [db, t.app.get(UsersService), t.app.get(PasswordService)] as const;
    const before = (await db.query('SELECT count(*)::int n FROM company')).rows[0].n;
    await expect(bootstrapOwner(...args, { companyName: 'Whatever', email: 'own@a.test', password: 'bootstrap-pass-123' })).rejects.toThrow(/does not create a Company/);
    await expect(bootstrapOwner(...args, { companyName: 'Whatever', email: 'own@a.test', password: 'bootstrap-pass-123', companyId: 'c0000000-0000-4000-8000-0000000000ff' })).rejects.toThrow(/no validated reference row/);
    expect((await db.query('SELECT count(*)::int n FROM company')).rows[0].n).toBe(before);
    const r = await bootstrapOwner(...args, { companyName: 'Whatever', email: 'own@a.test', password: 'bootstrap-pass-123', companyId: ID.co });
    expect(r.created).toBe(true);
    expect((await db.query(`SELECT "companyId" FROM owner`)).rows[0].companyId).toBe(ID.co);
    expect((await db.query('SELECT count(*)::int n FROM company')).rows[0].n).toBe(before); // no Company was created
  });

  it('the down migration refuses once the hierarchy is no longer local', async () => {
    const down = readFileSync(join(import.meta.dirname, '../db/migrations/down/0008_hierarchy_authority.down.sql'), 'utf8');
    await expect(db.query(down)).rejects.toThrow(/down\/0008 refused/);
  });
});
