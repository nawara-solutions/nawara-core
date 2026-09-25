import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { validateAuditPayload } from '@nawara/audit-contract';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { FileAudit, deterministicEventId } from '../src/audit/file-audit.js';
import { reconcile } from '../src/cli/reconcile-core.js';
import { STORAGE_PORT, type StoragePort } from '../src/storage/storage.port.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { DELETE_POLICY } from './support/deletion.js';
import { describeWithEnv } from './support/env.js';
import { Sql } from './support/fixtures.js';
import { SAMPLES } from './support/media.js';

type Row = { id: string; name: string; payload: Record<string, any> };

/**
 * Stage 18.7.4: File's two catalog actions, on the REAL application (real PostgreSQL, the filesystem store):
 * - `file.deleted` in the deletion request's transaction, once per file (the AVAILABLE → DELETING transition only);
 * - `file.integrity_incident` from a download that finds the stored bytes contradicting the record, and from the reconcile tool; ONE
 *   event per (file, reason) however often it is seen, and recording it never changes what the client receives.
 */
describeWithEnv('file-service audit intent (Stage 18.7.4) — real PostgreSQL, filesystem store', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  let storage: StoragePort;
  const drive = generateServiceToken();
  const billing = generateServiceToken();
  const reader = generateServiceToken();
  const tokens = [{ caller: 'core-drive', digest: drive.digest }, { caller: 'core-billing', digest: billing.digest }, { caller: 'core-reader', digest: reader.digest }];
  const server = () => t.app.getHttpServer();
  const auth = (tok: { token: string }, org?: string | null) => ({ authorization: `Bearer ${tok.token}`, ...(org ? { 'x-organization-id': org } : {}) });
  const sig = () => new AbortController().signal;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileaudit');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(DELETE_POLICY) });
    await t.app.listen(0, '127.0.0.1');
    storage = t.app.get<StoragePort>(STORAGE_PORT);
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await db?.drop();
  });

  async function uploaded(org: string | null, who = drive, bytes = SAMPLES.pdf(2000)) {
    const r = await request(server()).post('/file/files').set({ ...auth(who, org), 'idempotency-key': randomUUID(), 'x-attach': 'true' }).send(bytes);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }
  const audits = (fileId: string) =>
    s.query(`SELECT id, name, payload FROM outbox WHERE name LIKE 'audit.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", id`, [fileId]) as Promise<Row[]>;
  const status = async (id: string) => ((await s.query('SELECT status FROM file WHERE id = $1', [id]))[0] as { status: string }).status;
  const keyOf = async (id: string) => ((await s.query('SELECT "storageKey" FROM file WHERE id = $1', [id]))[0] as { storageKey: string }).storageKey;
  const del = (id: string, who = drive, org?: string | null, extra: Record<string, string> = {}) => request(server()).delete(`/file/files/${id}`).set({ ...auth(who, org), ...extra });
  const content = (id: string, org: string | null) => request(server()).get(`/file/files/${id}/content`).set(auth(drive, org));
  const replaceObject = async (id: string, bytes: Buffer) => {
    const key = await keyOf(id);
    await storage.delete(key, { signal: sig() });
    await storage.put(key, Readable.from([bytes]), { sizeBytes: bytes.length, contentType: 'application/pdf', signal: sig() });
  };
  const refuseOutbox = (name: string) =>
    s.query(`CREATE OR REPLACE FUNCTION s187_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox refused (test)'; END $$;
             CREATE TRIGGER s187_refuse BEFORE INSERT ON outbox FOR EACH ROW WHEN (NEW.name = '${name}') EXECUTE FUNCTION s187_refuse()`);
  afterEach(async () => {
    await s.query('DROP TRIGGER IF EXISTS s187_refuse ON outbox');
  });

  describe('file.deleted', () => {
    it('written in the deletion transaction: the owner service is the actor, the organization is the file row\'s; a repeated request writes nothing more', async () => {
      const org = randomUUID();
      const id = await uploaded(org);
      expect((await del(id, drive, org, { 'x-caller': 'someone-else', 'x-correlation-id': 'file-audit-corr-01' })).status).toBe(202);
      expect((await del(id, drive, org)).status).toBe(202); // DELETING: idempotent
      const rows = await audits(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!).toMatchObject({ id: deterministicEventId(id, 'audit.file.deleted'), name: 'audit.file.deleted' });
      expect(rows[0]!.payload).toMatchObject({ action: 'file.deleted', actor: { type: 'service', id: 'core-drive' }, organizationId: org, resource: { type: 'file', id }, outcome: 'succeeded' });
      expect(() => validateAuditPayload(rows[0]!.payload, 'file-service')).not.toThrow();
      expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/files\/|\.pdf|storage|sha256|sizeBytes/); // identifiers only
    });

    it('an organization-less file records null; a request naming another organization reaches no file (404) and writes nothing', async () => {
      const id = await uploaded(null, billing);
      const other = randomUUID();
      expect((await del(id, drive, other)).status).toBe(404);
      expect(await audits(id)).toEqual([]);
      expect((await del(id, billing)).status).toBe(202);
      expect((await audits(id))[0]!.payload).toMatchObject({ actor: { type: 'service', id: 'core-billing' }, organizationId: null });
    });

    it('atomicity: if the audit intent cannot be written, the deletion rolls back (still AVAILABLE, still readable); the retry writes once', async () => {
      const org = randomUUID();
      const id = await uploaded(org);
      await refuseOutbox('audit.file.deleted');
      expect((await del(id, drive, org)).status).toBe(500);
      expect(await status(id)).toBe('AVAILABLE');
      expect((await content(id, org)).status).toBe(200);
      await s.query('DROP TRIGGER s187_refuse ON outbox');
      expect((await del(id, drive, org)).status).toBe(202);
      expect(await status(id)).toBe('DELETING');
      expect((await audits(id)).map((r) => r.name)).toEqual(['audit.file.deleted']);
    });
  });

  describe('file.integrity_incident', () => {
    it('object_missing on download: the same 500 as before, one event (system file_download_integrity_check, the row\'s organization), however many downloads', async () => {
      const org = randomUUID();
      const id = await uploaded(org);
      await storage.delete(await keyOf(id), { signal: sig() });
      for (let i = 0; i < 3; i++) {
        const r = await content(id, org);
        expect([r.status, r.body.code]).toEqual([500, 'file_content_missing']);
      }
      const rows = await audits(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!).toMatchObject({ id: deterministicEventId(id, 'audit.file.integrity_incident', 'object_missing') });
      expect(rows[0]!.payload).toMatchObject({
        action: 'file.integrity_incident', actor: { type: 'system', id: 'file_download_integrity_check' }, organizationId: org, resource: { type: 'file', id }, changes: { reason: 'object_missing' },
      });
      expect(() => validateAuditPayload(rows[0]!.payload, 'file-service')).not.toThrow();
      expect(await status(id)).toBe('AVAILABLE'); // a detection changes no row
    });

    it('size_mismatch (a stored object of another length) and digest_mismatch (same length, altered bytes) are each recorded once', async () => {
      const sized = await uploaded(null);
      await replaceObject(sized, SAMPLES.pdf(1500));
      expect((await content(sized, null)).body.code).toBe('file_content_missing');
      const altered = await uploaded(null);
      const original = SAMPLES.pdf(2000);
      const flipped = Buffer.from(original);
      flipped[flipped.length - 10] = flipped[flipped.length - 10]! ^ 0xff;
      await replaceObject(altered, flipped);
      for (let i = 0; i < 2; i++) await content(altered, null).catch(() => undefined); // the connection is cut before the last chunk
      await expect.poll(async () => (await audits(altered)).length, { timeout: 5_000 }).toBe(1);
      expect((await audits(sized))[0]!.payload.changes).toEqual({ reason: 'size_mismatch' });
      expect((await audits(altered))[0]!.payload).toMatchObject({ organizationId: null, changes: { reason: 'digest_mismatch' } });
    });

    it('recording never changes the client outcome: when the intent cannot be written the download answers exactly as before, the failure is logged by id; the next detection writes it', async () => {
      const id = await uploaded(null);
      await storage.delete(await keyOf(id), { signal: sig() });
      await refuseOutbox('audit.file.integrity_incident');
      const r = await content(id, null);
      expect([r.status, r.body.code]).toEqual([500, 'file_content_missing']);
      expect(await audits(id)).toEqual([]);
      expect(ALL_LOGS.some((l) => String(l.msg).startsWith(`file_audit_intent_failed file=${id} action=file.integrity_incident reason=object_missing`))).toBe(true);
      await s.query('DROP TRIGGER s187_refuse ON outbox');
      await content(id, null);
      expect(await audits(id)).toHaveLength(1);
    });

    it('the reconcile tool records object_missing / size_mismatch as system file_reconciliation, once per (file, reason) across runs; orphans and healthy files record nothing', async () => {
      const org = randomUUID();
      const missing = await uploaded(org);
      const healthy = await uploaded(org);
      await storage.delete(await keyOf(missing), { signal: sig() });
      const audit = t.app.get(FileAudit);
      const dbs = t.app.get(DbService);
      const onIncident = (file: { id: string; organizationId: string | null }, reason: 'object_missing' | 'size_mismatch') =>
        dbs.tx((q) => audit.integrityIncident(q, file, 'file_reconciliation', reason));
      for (let i = 0; i < 2; i++) await reconcile(dbs, storage, { repair: false, limit: 100_000, onIncident }, () => undefined);
      const rows = await audits(missing);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({ actor: { type: 'system', id: 'file_reconciliation' }, organizationId: org, changes: { reason: 'object_missing' } });
      expect(await audits(healthy)).toEqual([]);
      // Seen later by a download too: still the one event of that fault.
      await content(missing, org);
      expect(await audits(missing)).toHaveLength(1);
    });

    it('a reconcile run whose audit write fails stops (fail loudly; resumable), and reports nothing for the incident it could not record', async () => {
      const id = await uploaded(null);
      await storage.delete(await keyOf(id), { signal: sig() });
      await refuseOutbox('audit.file.integrity_incident');
      const audit = t.app.get(FileAudit);
      const dbs = t.app.get(DbService);
      const lines: Record<string, unknown>[] = [];
      await expect(reconcile(dbs, storage, { repair: false, limit: 100_000, onIncident: (f, r) => dbs.tx((q) => audit.integrityIncident(q, f, 'file_reconciliation', r)) }, (l) => lines.push(l)))
        .rejects.toThrow(/outbox refused/);
      expect(lines.filter((l) => l.fileId === id)).toEqual([]);
    });
  });
});
