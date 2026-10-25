import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAuditPayload } from '@nawara/audit-contract';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { CleanupWorker } from '../src/cleanup/cleanup.worker.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { Sql } from './support/fixtures.js';
import { SAMPLES } from './support/media.js';

const PDF = ['application/pdf'];
const POLICY = {
  callers: {
    'core-drive': {
      operations: ['upload', 'read', 'attach', 'delete', 'issue_ticket', 'grant', 'hold'], organizations: 'request', mediaTypes: PDF, maxBytes: 1024 * 1024,
      grantPurposes: ['dispute_evidence'],
    },
    'core-records': { operations: ['upload', 'read', 'attach', 'delete', 'hold'], organizations: 'none', mediaTypes: PDF, maxBytes: 1024 * 1024 },
    'core-uploader': { operations: ['upload', 'read', 'attach', 'delete'], organizations: 'request', mediaTypes: PDF, maxBytes: 1024 * 1024 },
    'payment-service': { operations: ['read_granted'], organizations: 'none', readPurposes: ['dispute_evidence'] },
  },
};

/**
 * Core V2 S2-File.3 (register FIL-04 to FIL-06; OD-FILE F4): evidence holds on the REAL application (real PostgreSQL, the filesystem
 * store): owner-only placement and release, hold identity, several holds, preservation on every deletion path (the request, the
 * unattached-file expiry, the delete worker, the database itself), the races with deletion, the audit intent, and the unchanged reads.
 */
describeWithEnv('evidence holds (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  let worker: CleanupWorker;
  const drive = generateServiceToken();
  const records = generateServiceToken();
  const uploader = generateServiceToken();
  const payment = generateServiceToken();
  const tokens = [
    { caller: 'core-drive', digest: drive.digest }, { caller: 'core-records', digest: records.digest },
    { caller: 'core-uploader', digest: uploader.digest }, { caller: 'payment-service', digest: payment.digest },
  ];
  const server = () => t.app.getHttpServer();
  const auth = (tok: { token: string }, org?: string | null) => ({ authorization: `Bearer ${tok.token}`, ...(org ? { 'x-organization-id': org } : {}) });

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileholds');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(POLICY), env: { FILE_TICKET_FAILURE_LIMIT: '1000' } });
    await t.app.listen(0, '127.0.0.1');
    worker = t.app.get(CleanupWorker);
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await db?.drop();
  });

  async function uploaded(opts: { org?: string | null; who?: { token: string }; attach?: boolean } = {}): Promise<string> {
    const headers: Record<string, string> = { ...auth(opts.who ?? drive, opts.org), 'idempotency-key': randomUUID() };
    if (opts.attach !== false) headers['x-attach'] = 'true';
    const r = await request(server()).post('/file/files').set(headers).send(SAMPLES.pdf(2000));
    expect(r.status).toBe(201);
    return r.body.id as string;
  }
  const place = (id: string, holdRef: string, o: { who?: { token: string }; org?: string | null; body?: Record<string, unknown> } = {}) =>
    request(server()).post(`/file/files/${id}/holds`).set(auth(o.who ?? drive, o.org)).send(o.body ?? { holdRef });
  const release = (id: string, holdRef: string, o: { who?: { token: string }; org?: string | null } = {}) =>
    request(server()).post(`/file/files/${id}/holds/release`).set(auth(o.who ?? drive, o.org)).send({ holdRef });
  const del = (id: string, o: { who?: { token: string }; org?: string | null } = {}) => request(server()).delete(`/file/files/${id}`).set(auth(o.who ?? drive, o.org));
  const status = async (id: string) => (await s.query<{ status: string }>('SELECT status FROM file WHERE id = $1', [id]))[0]!.status;
  const holdRows = (id: string) => s.query<Record<string, unknown>>('SELECT * FROM file_hold WHERE "fileId" = $1 ORDER BY "placedAt"', [id]);
  const audits = (holdId: string) =>
    s.query<{ name: string; payload: Record<string, any> }>(`SELECT name, payload FROM outbox WHERE name LIKE 'audit.file.hold_%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", id`, [holdId]);
  const deletedAudits = (id: string) => s.query(`SELECT 1 FROM outbox WHERE name = 'audit.file.deleted' AND payload->'resource'->>'id' = $1`, [id]);
  async function failure(text: string, params: unknown[] = []): Promise<{ message: string; constraint?: string }> {
    try {
      await s.query(text, params);
    } catch (e) {
      return e as { message: string; constraint?: string };
    }
    throw new Error(`accepted: ${text}`);
  }

  // ───────────────────────────────────────────────────────────────────────────────────────── placement and release

  describe('placement and release', () => {
    it('the owner places a hold: 201 (no-store), the file\'s organization, one audit intent; again: 200, the same hold, nothing more', async () => {
      const org = randomUUID();
      const id = await uploaded({ org });
      const ref = randomUUID();
      const r = await place(id, ref, { org });
      expect(r.status).toBe(201);
      expect(r.headers['cache-control']).toBe('private, no-store');
      expect(r.body).toEqual({ holdId: expect.any(String), fileId: id, holdRef: ref, organizationId: org, status: 'active', placedAt: expect.any(String), releasedAt: null });
      const again = await place(id, ref, { org });
      expect([again.status, again.body]).toEqual([200, r.body]);
      expect(await holdRows(id)).toHaveLength(1);
      const events = await audits(r.body.holdId);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        action: 'file.hold_placed', actor: { type: 'service', id: 'core-drive' }, organizationId: org, resource: { type: 'file_hold', id: r.body.holdId },
        outcome: 'succeeded', changes: { file_id: id, hold_ref: ref },
      });
      expect(() => validateAuditPayload(events[0]!.payload, 'file-service')).not.toThrow();
    });

    it('release: 200 released, one audit intent; again: the first release, nothing more; a released reference is never placed again', async () => {
      const id = await uploaded();
      const ref = randomUUID();
      const p = await place(id, ref);
      const first = await release(id, ref);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ holdId: p.body.holdId, status: 'released', releasedAt: expect.any(String) });
      const again = await release(id, ref);
      expect([again.status, again.body]).toEqual([200, first.body]);
      const events = await audits(p.body.holdId);
      expect(events.map((e) => e.payload.action)).toEqual(['file.hold_placed', 'file.hold_released']);
      expect(events[1]!.payload).toMatchObject({ changes: { file_id: id, hold_ref: ref } });
      expect(() => validateAuditPayload(events[1]!.payload, 'file-service')).not.toThrow();
      const back = await place(id, ref);
      expect([back.status, back.body.code]).toEqual([409, 'hold_released']);
      expect(await holdRows(id)).toHaveLength(1);
    });

    it('a reference names one file for ever: reusing it for another file is 409 hold_ref_conflict', async () => {
      const a = await uploaded();
      const b = await uploaded();
      const ref = randomUUID();
      expect((await place(a, ref)).status).toBe(201);
      expect(await place(b, ref).then((r) => [r.status, r.body.code])).toEqual([409, 'hold_ref_conflict']);
      expect(await holdRows(b)).toEqual([]);
    });

    it('several independent holds: releasing one leaves the others active, and the file stays protected until the last is released', async () => {
      const id = await uploaded();
      const refs = [randomUUID(), randomUUID(), randomUUID()];
      for (const ref of refs) expect((await place(id, ref)).status).toBe(201);
      expect((await release(id, refs[1]!)).body.status).toBe('released');
      expect(await del(id).then((r) => [r.status, r.body.code])).toEqual([409, 'file_held']);
      expect((await place(id, refs[0]!)).body.status).toBe('active'); // untouched
      expect((await release(id, refs[0]!)).status).toBe(200);
      expect((await del(id)).body.code).toBe('file_held');
      expect((await release(id, refs[2]!)).status).toBe(200);
      expect((await del(id)).status).toBe(202);
      expect(await status(id)).toBe('DELETING');
    });

    it('a hold has no expiry: placedAt only, no lifetime', async () => {
      const id = await uploaded();
      expect(Object.keys((await place(id, randomUUID())).body).sort()).toEqual(['fileId', 'holdId', 'holdRef', 'organizationId', 'placedAt', 'releasedAt', 'status']);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────── authority

  describe('authority and isolation', () => {
    it('no or an unknown token is 401; a caller without `hold` is 403 for placement and release', async () => {
      const id = await uploaded({ who: uploader });
      expect((await request(server()).post(`/file/files/${id}/holds`).send({ holdRef: randomUUID() })).status).toBe(401);
      expect((await place(id, randomUUID(), { who: generateServiceToken() })).status).toBe(401);
      expect((await place(id, randomUUID(), { who: uploader })).body.code).toBe('operation_not_allowed');
      expect((await release(id, randomUUID(), { who: uploader })).body.code).toBe('operation_not_allowed');
      expect((await place(id, randomUUID(), { who: payment })).body.code).toBe('operation_not_allowed'); // a grantee holds nothing
    });

    it('only the owner: another service\'s file, another organization, a missing or malformed id are one 404 file_not_found', async () => {
      const org = randomUUID();
      const mine = await uploaded({ org });
      const theirs = await uploaded({ who: records });
      for (const [id, o] of [[theirs, {}], [mine, { org: randomUUID() }], [mine, {}], [randomUUID(), { org }], ['nope', { org }]] as const) {
        const r = await place(id, randomUUID(), o);
        expect([r.status, r.body.code], id).toEqual([404, 'file_not_found']);
      }
      expect((await place(theirs, randomUUID(), { who: records, org })).body.code).toBe('organization_not_allowed');
      expect([...(await holdRows(mine)), ...(await holdRows(theirs))]).toEqual([]);
    });

    it('a closed request: a malformed holdRef and any owner, organization, file or service in the body are 400', async () => {
      const id = await uploaded();
      for (const body of [{ holdRef: 'case-1' }, {}, { holdRef: randomUUID(), holderService: 'core-records' }, { holdRef: randomUUID(), organizationId: randomUUID() },
        { holdRef: randomUUID(), fileId: randomUUID() }, { holdRef: randomUUID(), ownerService: 'core-records' }]) {
        const r = await place(id, '', { body });
        expect([r.status, r.body.code], JSON.stringify(body)).toEqual([400, 'validation_error']);
      }
      expect(await holdRows(id)).toEqual([]);
    });

    it('release names exactly one hold: the holder, the reference and the file must all match (another service\'s, another file\'s, an unknown one: 404)', async () => {
      const id = await uploaded();
      const other = await uploaded();
      const ref = randomUUID();
      await place(id, ref);
      for (const [fileId, holdRef, o] of [[other, ref, {}], [id, randomUUID(), {}], [id, ref, { who: records }], [id, ref, { org: randomUUID() }], ['nope', ref, {}]] as const) {
        const r = await release(fileId, holdRef, o);
        expect([r.status, r.body.code]).toEqual([404, 'hold_not_found']);
      }
      expect((await del(id)).body.code).toBe('file_held');
    });

    it('ineligible files: an uploading or refused file is 409 file_not_available; a deleted one 410; an unattached AVAILABLE one can be held', async () => {
      const uploading = randomUUID();
      await s.query(`INSERT INTO file (id, "ownerService", "storageProvider", "storageKey", "uploadExpiresAt", "attachDeadline") VALUES ($1, 'core-drive', 'filesystem', $2, now() + interval '1 hour', now() + interval '1 day')`,
        [uploading, `files/${uploading}/${randomBytes(16).toString('hex')}`]);
      expect(await place(uploading, randomUUID()).then((r) => [r.status, r.body.code])).toEqual([409, 'file_not_available']);
      const gone = await uploaded();
      await del(gone);
      expect(await place(gone, randomUUID()).then((r) => [r.status, r.body.code])).toEqual([410, 'file_deleted']);
      expect((await place(await uploaded({ attach: false }), randomUUID())).status).toBe(201);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────── preservation, every path

  describe('preservation', () => {
    it('the deletion request: 409 file_held; nothing changes (status, tickets, no file.deleted)', async () => {
      const id = await uploaded();
      const tk = await request(server()).post(`/file/files/${id}/tickets`).set(auth(drive)).send({ operation: 'download' });
      await place(id, randomUUID());
      const r = await del(id);
      expect([r.status, r.body.code]).toEqual([409, 'file_held']);
      expect(await status(id)).toBe('AVAILABLE');
      expect((await s.query<{ revokedAt: Date | null }>('SELECT "revokedAt" FROM file_access_ticket WHERE id = $1', [tk.body.ticketId]))[0]!.revokedAt).toBeNull();
      expect(await deletedAudits(id)).toEqual([]);
    });

    it('the unattached-file expiry keeps a held file (and expires it after release)', async () => {
      const id = randomUUID();
      await s.query(`INSERT INTO file (id, "ownerService", "storageProvider", "storageKey", "createdAt", "uploadExpiresAt", "attachDeadline")
        VALUES ($1, 'core-drive', 'filesystem', $2, now() - interval '2 days', now() - interval '47 hours', now() + interval '1 hour')`, [id, `files/${id}/${randomBytes(16).toString('hex')}`]);
      await s.query(`UPDATE file SET status = 'AVAILABLE', "mediaType" = 'application/pdf', "sizeBytes" = 3, sha256 = repeat('b', 64), "availableAt" = now() WHERE id = $1`, [id]);
      const ref = randomUUID();
      expect((await place(id, ref)).status).toBe(201);
      // the deadline passes (the test moves it; the runtime never does)
      await s.query(`ALTER TABLE file DISABLE TRIGGER USER`);
      try {
        await s.query(`UPDATE file SET "attachDeadline" = now() - interval '1 hour' WHERE id = $1`, [id]);
      } finally {
        await s.query(`ALTER TABLE file ENABLE TRIGGER USER`);
      }
      await worker.runOnce();
      expect(await status(id)).toBe('AVAILABLE');
      await release(id, ref);
      await worker.runOnce();
      expect(await status(id)).not.toBe('AVAILABLE');
    });

    it('the delete worker never claims a held file, and the database refuses DELETED while a hold is active', async () => {
      const id = await uploaded();
      await place(id, randomUUID());
      // a DELETING row with an active hold can only be forced past the guards (replica mode): the worker's own filter still refuses it
      await s.query(`SET session_replication_role = replica`);
      try {
        await s.query(`UPDATE file SET status = 'DELETING', "deletionRequestedAt" = now(), "deleteNextAttemptAt" = now() - interval '1 second' WHERE id = $1`, [id]);
      } finally {
        await s.query(`SET session_replication_role = origin`);
      }
      await worker.runOnce();
      expect((await s.query<{ status: string; deleteAttempts: number }>('SELECT status, "deleteAttempts" FROM file WHERE id = $1', [id]))[0]).toEqual({ status: 'DELETING', deleteAttempts: 0 });
      const refused = await failure(`UPDATE file SET status = 'DELETED', "deletedAt" = now() WHERE id = $1`, [id]);
      expect(refused.constraint).toBe('file_held');
    });

    it('the database itself: no move to DELETING while held, whatever the path', async () => {
      const id = await uploaded();
      await place(id, randomUUID());
      const refused = await failure(`UPDATE file SET status = 'DELETING', "deletionRequestedAt" = now(), "deleteNextAttemptAt" = now() WHERE id = $1`, [id]);
      expect([refused.constraint, refused.message]).toEqual(['file_held', `file ${id} is held`]);
    });

    it('holds never touch reads, grants, granted reads or tickets', async () => {
      const org = randomUUID();
      const id = await uploaded({ org });
      await place(id, randomUUID(), { org });
      expect((await request(server()).get(`/file/files/${id}/content`).set(auth(drive, org))).status).toBe(200);
      const tk = await request(server()).post(`/file/files/${id}/tickets`).set(auth(drive, org)).send({ operation: 'download' });
      expect((await request(server()).get(new URL(tk.body.url as string).pathname)).status).toBe(200);
      const g = await request(server()).post(`/file/files/${id}/evidence-grants`).set({ ...auth(drive, org), 'idempotency-key': randomUUID() }).send({ purpose: 'dispute_evidence', caseRef: randomUUID() });
      expect(g.status).toBe(201);
      expect((await request(server()).get(`/file/evidence-grants/${g.body.grantId}/files/${id}`).set(auth(payment))).status).toBe(200);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────── the schema on its own

  describe('the schema', () => {
    it('placement binding: the holder owns the AVAILABLE file, in its organization', async () => {
      const org = randomUUID();
      const id = await uploaded({ org });
      const gone = await uploaded();
      await del(gone);
      for (const [fileId, over] of [[id, { holderService: 'core-records', organizationId: org }], [id, { organizationId: null }], [id, { organizationId: randomUUID() }], [gone, {}]] as const) {
        await expect(s.insert('file_hold', { id: randomUUID(), fileId, holderService: 'core-drive', holdRef: randomUUID(), organizationId: null, ...over }), JSON.stringify(over))
          .rejects.toThrow(/not the holder's AVAILABLE file/);
      }
    });

    it('append-only: placements and releases are never updated or deleted; one release per hold', async () => {
      const id = await uploaded();
      const ref = randomUUID();
      const h = (await place(id, ref)).body;
      await release(id, ref);
      for (const sql of [`UPDATE file_hold SET "holdRef" = gen_random_uuid() WHERE id = $1`, `DELETE FROM file_hold WHERE id = $1`,
        `UPDATE file_hold_release SET "releasedAt" = now() WHERE "holdId" = $1`, `DELETE FROM file_hold_release WHERE "holdId" = $1`]) {
        expect((await failure(sql, [h.holdId])).message, sql).toMatch(/append-only/);
      }
      expect((await failure(`INSERT INTO file_hold_release ("holdId") VALUES ($1)`, [h.holdId])).message).toMatch(/duplicate key/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── concurrency

  describe('concurrency and uncertain outcomes', () => {
    it('a deletion that waited for an uncommitted placement meets it once committed (409), and proceeds if it rolled back (202)', async () => {
      for (const end of ['COMMIT', 'ROLLBACK'] as const) {
        const id = await uploaded();
        const placing = new pg.Client({ connectionString: db.url });
        await placing.connect();
        try {
          await placing.query('BEGIN');
          await placing.query(`INSERT INTO file_hold (id, "fileId", "holderService", "holdRef", "organizationId") VALUES ($1, $2, 'core-drive', $3, NULL)`, [randomUUID(), id, randomUUID()]);
          const deletion = del(id).then((r) => r); // waits for the placement's share lock on the file row
          await new Promise((r) => setTimeout(r, 200));
          await placing.query(end);
          const d = await deletion;
          expect(d.status, end).toBe(end === 'COMMIT' ? 409 : 202);
          expect(await status(id)).toBe(end === 'COMMIT' ? 'AVAILABLE' : 'DELETING');
        } finally {
          await placing.end();
        }
      }
    });

    it('a placement racing a committed deletion is refused (410); placement and deletion never both succeed', async () => {
      for (let i = 0; i < 8; i++) {
        const id = await uploaded();
        const [p, d] = await Promise.all([place(id, randomUUID()), del(id)]);
        expect([[201, 409], [410, 202]]).toContainEqual([p.status, d.status]);
        expect(await status(id)).toBe(p.status === 201 ? 'AVAILABLE' : 'DELETING');
      }
    });

    it('an uncommitted or rolled-back release does not unlock the file; a committed one does', async () => {
      const id = await uploaded();
      const ref = randomUUID();
      const h = (await place(id, ref)).body;
      const releasing = new pg.Client({ connectionString: db.url });
      await releasing.connect();
      try {
        await releasing.query('BEGIN');
        await releasing.query(`INSERT INTO file_hold_release ("holdId") VALUES ($1)`, [h.holdId]);
        expect((await del(id)).body.code).toBe('file_held'); // not committed: still held
        await releasing.query('ROLLBACK');
      } finally {
        await releasing.end();
      }
      expect((await del(id)).body.code).toBe('file_held'); // rolled back: still held
      expect((await release(id, ref)).status).toBe(200);
      expect((await del(id)).status).toBe(202);
    });

    it('concurrent placements of one reference: ONE hold, ONE audit intent; concurrent releases: ONE release, ONE audit intent', async () => {
      const id = await uploaded();
      const ref = randomUUID();
      const placed = await Promise.all(Array.from({ length: 8 }, () => place(id, ref)));
      expect(placed.filter((r) => r.status === 201)).toHaveLength(1);
      expect(placed.every((r) => r.status === 201 || r.status === 200)).toBe(true);
      expect(new Set(placed.map((r) => r.body.holdId)).size).toBe(1);
      const released = await Promise.all(Array.from({ length: 8 }, () => release(id, ref)));
      expect(released.every((r) => r.status === 200)).toBe(true);
      expect(new Set(released.map((r) => r.body.releasedAt)).size).toBe(1);
      expect((await audits(placed[0]!.body.holdId)).map((e) => e.payload.action)).toEqual(['file.hold_placed', 'file.hold_released']);
    });

    it('releases racing a deletion: the deletion succeeds only once no hold is active', async () => {
      for (let i = 0; i < 5; i++) {
        const id = await uploaded();
        const refs = [randomUUID(), randomUUID()];
        for (const ref of refs) await place(id, ref);
        const [, , d] = await Promise.all([release(id, refs[0]!), release(id, refs[1]!), del(id)]);
        expect([202, 409]).toContain(d.status);
        if (d.status === 409) expect((await del(id)).status).toBe(202); // both released by now
        expect(await status(id)).toBe('DELETING');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────── audit atomicity, privacy

  describe('the record', () => {
    async function withRefusingOutbox<T>(fn: () => Promise<T>): Promise<T> {
      await s.query(`CREATE OR REPLACE FUNCTION s2f3_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox refused (test)'; END $$;
                     CREATE TRIGGER s2f3_refuse BEFORE INSERT ON outbox FOR EACH ROW WHEN (NEW.name LIKE 'audit.file.hold_%') EXECUTE FUNCTION s2f3_refuse()`);
      try {
        return await fn();
      } finally {
        await s.query('DROP TRIGGER IF EXISTS s2f3_refuse ON outbox');
      }
    }

    it('is atomic with the transition: no record, no hold; no record, no release (the file stays protected)', async () => {
      const id = await uploaded();
      const ref = randomUUID();
      expect((await withRefusingOutbox(() => place(id, ref))).status).toBe(500);
      expect(await holdRows(id)).toEqual([]);
      expect((await place(id, ref)).status).toBe(201);
      expect((await withRefusingOutbox(() => release(id, ref))).status).toBe(500);
      expect((await del(id)).body.code).toBe('file_held');
      expect((await release(id, ref)).body.status).toBe('released');
    });

    it('identifiers only: no token, file name or bytes in a record or a log line', async () => {
      const id = await uploaded();
      const ref = randomUUID();
      const h = (await place(id, ref)).body;
      await release(id, ref);
      const recs = JSON.stringify(await audits(h.holdId));
      expect(recs).not.toContain(drive.token);
      expect(recs).not.toMatch(/originalName|storage|sha256|sizeBytes|url/i);
      expect(JSON.stringify(ALL_LOGS)).not.toContain(drive.token);
      expect(JSON.stringify(ALL_LOGS)).toContain(`file_hold_placed owner=core-drive hold=${h.holdId} file=${id}`);
    });
  });
});
