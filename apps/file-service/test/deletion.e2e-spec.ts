import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { reconcile } from '../src/cli/reconcile-core.js';
import { CleanupWorker } from '../src/cleanup/cleanup.worker.js';
import { FileRepository } from '../src/persistence/file.repository.js';
import { ticketDigest } from '../src/persistence/ticket-digest.js';
import { TicketRepository } from '../src/persistence/ticket.repository.js';
import { STORAGE_PORT, type StoragePort } from '../src/storage/storage.port.js';
import { uploadRequestTimeoutMs } from '../src/upload/http-server.js';
import { UPLOAD_LEASE_MARGIN_SECONDS } from '../src/upload/upload.service.js';
import { ALL_LOGS, createTestApp, TEST_STORAGE_ROOT, type TestApp } from './support/app.js';
import { DELETE_POLICY } from './support/deletion.js';
import { describeWithEnv } from './support/env.js';
import { newToken, Sql } from './support/fixtures.js';
import { SAMPLES } from './support/media.js';

/**
 * Stage 17.7: deletion and cleanup on the REAL application (real PostgreSQL, the filesystem store): the delete route, the cleanup
 * workers (driven by hand through `CleanupWorker.runOnce`), crash windows, concurrency and the races with attach, ticket issuance and
 * redemption.
 */
describeWithEnv('delete + cleanup lifecycle (real PostgreSQL, filesystem store)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  let worker: CleanupWorker;
  let files: FileRepository;
  let storage: StoragePort;
  const drive = generateServiceToken();
  const billing = generateServiceToken();
  const reader = generateServiceToken();
  const tokens = [{ caller: 'core-drive', digest: drive.digest }, { caller: 'core-billing', digest: billing.digest }, { caller: 'core-reader', digest: reader.digest }];
  const policy = JSON.stringify(DELETE_POLICY);
  const server = () => t.app.getHttpServer();
  const auth = (tok: { token: string }, org?: string | null) => ({ authorization: `Bearer ${tok.token}`, ...(org ? { 'x-organization-id': org } : {}) });
  const sig = () => new AbortController().signal;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'filedelete');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy, env: { FILE_TICKET_FAILURE_LIMIT: '1000' } });
    await t.app.listen(0, '127.0.0.1');
    worker = t.app.get(CleanupWorker);
    files = t.app.get(FileRepository);
    storage = t.app.get<StoragePort>(STORAGE_PORT);
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await db?.drop();
  });

  async function uploaded(opts: { org?: string | null; who?: { token: string }; attach?: boolean; bytes?: Buffer } = {}) {
    const headers: Record<string, string> = { ...auth(opts.who ?? drive, opts.org), 'idempotency-key': randomUUID() };
    if (opts.attach !== false) headers['x-attach'] = 'true';
    const r = await request(server()).post('/file/files').set(headers).send(opts.bytes ?? SAMPLES.pdf(2000));
    expect(r.status).toBe(201);
    return r.body.id as string;
  }
  const row = async (id: string) => (await s.query('SELECT * FROM file WHERE id = $1', [id]))[0] as Record<string, unknown>;
  const keyOf = async (id: string) => (await row(id)).storageKey as string;
  const present = async (id: string) => (await storage.head(await keyOf(id), { signal: sig() })) !== undefined;
  const del = (id: string, who = drive, org?: string | null) => request(server()).delete(`/file/files/${id}`).set(auth(who, org));
  const issue = (id: string, org?: string | null) => request(server()).post(`/file/files/${id}/tickets`).set(auth(drive, org)).send({ operation: 'download' });
  const tpath = (url: string) => new URL(url).pathname;
  /** A due DELETING row processed now (tests do not wait for real backoff). */
  const dueNow = (id: string) => s.query(`UPDATE file SET "deleteNextAttemptAt" = now() - interval '1 second', "deleteLeaseUntil" = NULL WHERE id = $1`, [id]);

  // ───────────────────────────────────────────────────────────────────────────────────────────────── the delete route

  it('delete: AVAILABLE → DELETING at once (tickets revoked, access stops, the object still in the store), then the worker → DELETED', async () => {
    const org = randomUUID();
    const id = await uploaded({ org });
    const tk = await issue(id, org);
    expect(tk.status).toBe(201);
    const r = await del(id, drive, org);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ id, status: 'DELETING' });
    expect(await row(id)).toMatchObject({ status: 'DELETING', deleteAttempts: 0, deleteLeaseUntil: null });
    expect((await s.query(`SELECT "revokedAt" FROM file_access_ticket WHERE id = $1`, [tk.body.ticketId]))[0]).toMatchObject({ revokedAt: expect.any(Date) });
    // Access is denied while the bytes still exist.
    expect(await present(id)).toBe(true);
    expect((await request(server()).get(`/file/files/${id}/content`).set(auth(drive, org))).body.code).toBe('file_deleted');
    expect((await request(server()).get(tpath(tk.body.url as string))).body.code).toBe('ticket_invalid');
    expect((await issue(id, org)).body.code).toBe('file_deleted');
    expect((await request(server()).get(`/file/files/${id}`).set(auth(drive, org))).body).toMatchObject({ status: 'DELETING' });
    // The worker removes the bytes and closes the row (a tombstone, never hard-deleted).
    await dueNow(id);
    await worker.runOnce();
    expect(await present(id)).toBe(false);
    expect(await row(id)).toMatchObject({ status: 'DELETED', deletedAt: expect.any(Date), deleteNextAttemptAt: null, deleteLeaseUntil: null, deleteAttempts: 1 });
    expect((await del(id, drive, org)).body).toMatchObject({ status: 'DELETED' }); // idempotent after completion
  });

  it('delete is idempotent while DELETING (the same 202, the same request time, one completion)', async () => {
    const id = await uploaded();
    const first = await del(id);
    const second = await del(id);
    expect([first.status, second.status]).toEqual([202, 202]);
    const before = await row(id);
    await del(id);
    expect((await row(id)).deletionRequestedAt).toEqual(before.deletionRequestedAt);
    await dueNow(id);
    await worker.runOnce();
    expect(ALL_LOGS.filter((l) => String(l.msg).startsWith(`file_deletion_completed file=${id}`))).toHaveLength(1);
  });

  it('non-disclosure: another owner, organization, missing organization, malformed or unknown id: the same 404; no permission 403; tickets cannot delete', async () => {
    const org = randomUUID();
    const id = await uploaded({ org });
    const bodies: string[] = [];
    for (const [who, target, o] of [[billing, id, null], [drive, id, randomUUID()], [drive, id, null], [drive, 'not-a-uuid', org], [drive, randomUUID(), org]] as const) {
      const r = await del(target, who, o);
      expect(r.status).toBe(404);
      const { requestId: _r, ...rest } = r.body as Record<string, unknown>;
      bodies.push(JSON.stringify(rest));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ code: 'file_not_found' });
    expect((await del(id, reader)).body.code).toBe('operation_not_allowed');
    // Only the owner differs (a platform file: no organization to mismatch): still the same 404, and nothing changes.
    const platform = await uploaded();
    expect((await del(platform, billing)).body.code).toBe('file_not_found');
    expect((await row(platform)).status).toBe('AVAILABLE');
    expect((await request(server()).delete(`/file/files/${id}`).set({ ...auth(billing), 'x-owner-service': 'core-drive' })).status).toBe(404);
    const url = (await issue(id, org)).body.url as string;
    expect((await request(server()).delete(`/file/files/${id}`).set({ authorization: `Bearer ${url.split('/file/t/')[1]}` })).status).toBe(401);
    expect((await request(server()).delete(`/file/t/${url.split('/file/t/')[1]}`)).status).toBe(404); // no delete through a ticket path
    expect((await row(id)).status).toBe('AVAILABLE');
  });

  it('only AVAILABLE files enter deletion: UPLOADING is 409 upload_in_progress, FAILED / REJECTED 409 file_not_available', async () => {
    const uploading = randomUUID();
    await s.query(`INSERT INTO file (id, "ownerService", "storageProvider", "storageKey", "uploadExpiresAt", "attachDeadline") VALUES ($1, 'core-drive', 'filesystem', $2, now() + interval '1 hour', now() + interval '1 day')`,
      [uploading, `files/${uploading}/${randomBytes(16).toString('hex')}`]);
    expect((await del(uploading)).body.code).toBe('upload_in_progress');
    for (const status of ['FAILED', 'REJECTED']) {
      const id = randomUUID();
      await s.query(`INSERT INTO file (id, "ownerService", "storageProvider", "storageKey", "uploadExpiresAt", "attachDeadline") VALUES ($1, 'core-drive', 'filesystem', $2, now() + interval '1 hour', now() + interval '1 day')`,
        [id, `files/${id}/${randomBytes(16).toString('hex')}`]);
      await s.query(`UPDATE file SET status = $2, "failureCode" = 'x_code' WHERE id = $1`, [id, status]);
      expect((await del(id)).body.code, status).toBe('file_not_available');
    }
  });

  it('the logical deletion is ONE transaction: if the ticket revocation fails, the file stays AVAILABLE and its tickets live', async () => {
    const id = await uploaded();
    const tk = await issue(id);
    await s.query(`CREATE FUNCTION test_fail_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$`);
    await s.query(`CREATE TRIGGER test_fail_revoke BEFORE UPDATE OF "revokedAt" ON file_access_ticket FOR EACH ROW EXECUTE FUNCTION test_fail_revoke()`);
    try {
      expect((await del(id)).status).toBe(500);
    } finally {
      await s.query('DROP TRIGGER test_fail_revoke ON file_access_ticket');
      await s.query('DROP FUNCTION test_fail_revoke()');
    }
    expect((await row(id)).status).toBe('AVAILABLE');
    expect((await request(server()).get(tpath(tk.body.url as string))).status).toBe(200);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────── worker: retry, lease

  it.skipIf(process.getuid?.() === 0)('a storage failure keeps the file DELETING (never restored), rescheduled with backoff; it completes once the store recovers', async () => {
    const id = await uploaded();
    const key = await keyOf(id);
    await del(id);
    const dir = dirname(join(TEST_STORAGE_ROOT, key));
    chmodSync(dir, 0o500); // the object cannot be unlinked: storage_rejected
    try {
      await dueNow(id);
      const pass = await worker.runOnce();
      expect(pass.retried).toBeGreaterThanOrEqual(1);
      const r = await row(id);
      expect(r).toMatchObject({ status: 'DELETING', deleteAttempts: 1, deleteLastError: 'storage_rejected', deleteLeaseUntil: null });
      const wait = ((r.deleteNextAttemptAt as Date).getTime() - Date.now()) / 1000;
      expect(wait).toBeGreaterThan(20); // the 30 s base backoff: no hot loop
      expect(wait).toBeLessThanOrEqual(31);
      await worker.runOnce(); // not due yet: untouched
      expect((await row(id)).deleteAttempts).toBe(1);
      expect((await request(server()).get(`/file/files/${id}/content`).set(auth(drive))).body.code).toBe('file_deleted');
    } finally {
      chmodSync(dir, 0o700);
    }
    await dueNow(id);
    await worker.runOnce();
    expect(await row(id)).toMatchObject({ status: 'DELETED', deleteAttempts: 2, deleteLastError: null });
  });

  it('crash windows: a claimed row is reserved by its lease, then reclaimed; a stale worker can neither reschedule nor corrupt it', async () => {
    const id = await uploaded();
    await del(id);
    await dueNow(id);
    const claimsA = await files.claimDeletions(10, 300); // worker A claims … and "crashes" (crash B: before the storage call)
    const mine = claimsA.find((c) => c.id === id)!;
    expect(mine.attempt).toBe(1);
    expect((await worker.runOnce()).deleted).toBe(0); // the lease holds: no second worker touches it
    expect(await present(id)).toBe(true);
    await s.query(`UPDATE file SET "deleteLeaseUntil" = now() - interval '1 second' WHERE id = $1`, [id]); // the lease expires
    await storage.delete(await keyOf(id), { signal: sig() }); // crash C: an earlier attempt removed the object, the row was not finalized
    await worker.runOnce(); // B reclaims (attempt 2): the object is already absent → DELETED (idempotent)
    expect(await row(id)).toMatchObject({ status: 'DELETED', deleteAttempts: 2 });
    expect(await files.retryDeletion(id, mine.attempt, 30, 'storage_unavailable')).toBe(false); // the stale holder is fenced out
    expect(await files.completeDeletion(id)).toBe(false); // … and its late completion is a no-op (crash D: terminal)
    expect((await row(id)).status).toBe('DELETED');
  });

  it('two replicas claim disjoint batches; together they delete every file exactly once', async () => {
    const ids = await Promise.all(Array.from({ length: 30 }, () => uploaded({ bytes: SAMPLES.pdf(300) })));
    for (const id of ids) await del(id);
    await s.query(`UPDATE file SET "deleteNextAttemptAt" = now() - interval '1 second' WHERE id = ANY($1::uuid[])`, [ids]);
    const [a, b] = await Promise.all([files.claimDeletions(20, 300), files.claimDeletions(20, 300)]);
    const claimed = [...a, ...b].map((c) => c.id).filter((id) => ids.includes(id));
    expect(new Set(claimed).size).toBe(claimed.length); // never the same row twice
    await s.query(`UPDATE file SET "deleteLeaseUntil" = NULL WHERE id = ANY($1::uuid[])`, [ids]); // release for the real race below
    const second = await createTestApp({ databaseUrl: db.url, tokens, policy });
    try {
      const results = await Promise.all([worker.runOnce(), second.app.get(CleanupWorker).runOnce(), worker.runOnce()]);
      const done = await s.query<{ n: number }>(`SELECT count(*)::int AS n FROM file WHERE id = ANY($1::uuid[]) AND status = 'DELETED'`, [ids]);
      if (done[0]!.n < 30) await worker.runOnce(); // the batch bound (20) may leave a remainder for the next pass
      expect((await s.query<{ n: number }>(`SELECT count(*)::int AS n FROM file WHERE id = ANY($1::uuid[]) AND status = 'DELETED'`, [ids]))[0]!.n).toBe(30);
      expect(results.reduce((n, r) => n + r.deleted, 0)).toBeLessThanOrEqual(30);
      for (const id of ids) expect(ALL_LOGS.filter((l) => String(l.msg).startsWith(`file_deletion_completed file=${id}`))).toHaveLength(1);
    } finally {
      await second.app.close();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────── abandoned uploads

  it('abandoned uploads (past the lease) become FAILED upload_abandoned; a published object is removed first; live uploads are untouched', async () => {
    const insertUploading = async (expired: boolean) => {
      const id = randomUUID();
      await s.query(`INSERT INTO file (id, "ownerService", "storageProvider", "storageKey", "createdAt", "uploadExpiresAt", "attachDeadline")
        VALUES ($1, 'core-drive', 'filesystem', $2, now() - interval '2 hours', now() + ($3 || ' seconds')::interval, now() + interval '1 day')`,
        [id, `files/${id}/${randomBytes(16).toString('hex')}`, expired ? '-60' : '600']);
      return id;
    };
    const noObject = await insertUploading(true); // crash E: the process died before publishing
    const withObject = await insertUploading(true); // crash F: published, then died before finalizing
    await storage.put(await keyOf(withObject), (await import('node:stream')).Readable.from([SAMPLES.pdf(100)]), { sizeBytes: SAMPLES.pdf(100).length, contentType: 'application/pdf', signal: sig() });
    const live = await insertUploading(false); // an upload still within its lease
    await storage.put(await keyOf(live), (await import('node:stream')).Readable.from([SAMPLES.pdf(100)]), { sizeBytes: SAMPLES.pdf(100).length, contentType: 'application/pdf', signal: sig() });
    await worker.runOnce();
    expect(await row(noObject)).toMatchObject({ status: 'FAILED', failureCode: 'upload_abandoned' });
    expect(await row(withObject)).toMatchObject({ status: 'FAILED', failureCode: 'upload_abandoned', mediaType: null }); // never promoted
    expect(await present(withObject)).toBe(false);
    expect(await row(live)).toMatchObject({ status: 'UPLOADING' });
    expect(await present(live)).toBe(true);
  });

  it('the upload lease outlasts the server\'s request bound (no live request can still be writing when the sweep acts)', async () => {
    const token = new URL((await request(server()).post('/file/uploads/tickets').set(auth(drive)).send({ maxBytes: 1000, mediaTypes: ['application/pdf'] })).body.url as string).pathname;
    const up = await request(server()).put(token).send(SAMPLES.pdf(500));
    const r = await row(up.body.id as string);
    const leaseS = ((r.uploadExpiresAt as Date).getTime() - (r.createdAt as Date).getTime()) / 1000;
    expect(leaseS).toBeGreaterThanOrEqual(uploadRequestTimeoutMs(t.config) / 1000 + UPLOAD_LEASE_MARGIN_SECONDS - 1);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────── temporary files

  it('an unattached AVAILABLE file past its deadline enters the normal deletion path (tickets revoked); attached and in-time files stay', async () => {
    const insertAvailable = async (opts: { attached: boolean; pastDeadline: boolean }) => {
      const id = randomUUID();
      await s.query(`INSERT INTO file (id, "ownerService", "storageProvider", "storageKey", "createdAt", "uploadExpiresAt", "attachDeadline", "attachedAt")
        VALUES ($1, 'core-drive', 'filesystem', $2, now() - interval '2 days', now() - interval '47 hours', now() + ($3 || ' seconds')::interval, $4)`,
        [id, `files/${id}/${randomBytes(16).toString('hex')}`, opts.pastDeadline ? '-3600' : '3600', opts.attached ? new Date() : null]);
      await s.query(`UPDATE file SET status = 'AVAILABLE', "mediaType" = 'application/pdf', "sizeBytes" = 3, sha256 = repeat('b', 64), "availableAt" = now() WHERE id = $1`, [id]);
      return id;
    };
    const expired = await insertAvailable({ attached: false, pastDeadline: true });
    const tk = await issue(expired);
    const attached = await insertAvailable({ attached: true, pastDeadline: true });
    const inTime = await insertAvailable({ attached: false, pastDeadline: false });
    const pass = await worker.runOnce();
    expect(pass.expired).toBeGreaterThanOrEqual(1);
    expect(await row(expired)).toMatchObject({ status: 'DELETED' }); // expired, then deleted by the same worker in the same pass
    expect((await s.query(`SELECT "revokedAt" FROM file_access_ticket WHERE id = $1`, [tk.body.ticketId]))[0]).toMatchObject({ revokedAt: expect.any(Date) });
    expect((await row(attached)).status).toBe('AVAILABLE');
    expect((await row(inTime)).status).toBe('AVAILABLE');
    expect(ALL_LOGS.some((l) => String(l.msg) === `file_temporary_expired file=${expired}`)).toBe(true);
  });

  it('attach vs expiry race: whichever commits first wins; the loser changes nothing', async () => {
    const make = async () => {
      const id = randomUUID();
      await s.query(`INSERT INTO file (id, "ownerService", "storageProvider", "storageKey", "createdAt", "uploadExpiresAt", "attachDeadline")
        VALUES ($1, 'core-drive', 'filesystem', $2, now() - interval '2 days', now() - interval '47 hours', now() - interval '1 hour')`, [id, `files/${id}/${randomBytes(16).toString('hex')}`]);
      await s.query(`UPDATE file SET status = 'AVAILABLE', "mediaType" = 'application/pdf', "sizeBytes" = 3, sha256 = repeat('c', 64), "availableAt" = now() WHERE id = $1`, [id]);
      return id;
    };
    const attach = (id: string) => request(server()).post(`/file/files/${id}/attach`).set(auth(drive));
    const a = new pg.Client({ connectionString: db.url });
    await a.connect();
    try {
      // 1. The attach commits first (it holds the row): the expiry skips it now and finds it attached later.
      const first = await make();
      await a.query('BEGIN');
      await a.query(`UPDATE file SET "attachedAt" = now() WHERE id = $1 AND "attachedAt" IS NULL`, [first]);
      expect(await files.expireUnattached(100)).not.toContain(first); // SKIP LOCKED: not taken while the attach is open
      await a.query('COMMIT');
      expect(await files.expireUnattached(100)).not.toContain(first);
      expect((await row(first)).status).toBe('AVAILABLE');
      // 2. The expiry commits first: the owner's attach waits, then finds the file DELETING: refused, nothing attached.
      const second = await make();
      await a.query('BEGIN');
      await a.query(`UPDATE file SET status = 'DELETING', "deletionRequestedAt" = now(), "deleteNextAttemptAt" = now() WHERE id = $1 AND status = 'AVAILABLE' AND "attachedAt" IS NULL`, [second]);
      const late = attach(second).then((r) => r); // sent NOW (a supertest request is lazy until awaited): it runs against the open transaction
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      expect((await late).body.code).toBe('file_not_available');
      expect(await row(second)).toMatchObject({ status: 'DELETING', attachedAt: null });
    } finally {
      await a.end();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────────────── races with the byte routes

  it('delete vs ticket issuance: an issuance committed first is revoked by the deletion; an issuance after the deletion creates nothing', async () => {
    const tickets = t.app.get(TicketRepository);
    const a = new pg.Client({ connectionString: db.url });
    await a.connect();
    try {
      const first = await uploaded();
      await a.query('BEGIN');
      const d = ticketDigest(newToken().token)!;
      const tk = await tickets.recordDownload({ scope: { ownerService: 'core-drive', organizationId: null }, fileId: first, tokenDigest: d, lifetimeSeconds: 120, singleUse: false, disposition: 'attachment' }, a);
      expect(tk).toBeDefined(); // it holds a share lock on the file row
      const deletion = del(first).then((r) => r); // sent now: it waits for the issuance's share lock
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      expect((await deletion).status).toBe(202);
      expect((await s.query(`SELECT "revokedAt" FROM file_access_ticket WHERE id = $1`, [tk!.id]))[0]).toMatchObject({ revokedAt: expect.any(Date) });
      const second = await uploaded();
      await a.query('BEGIN');
      await a.query(`UPDATE file SET status = 'DELETING', "deletionRequestedAt" = now(), "deleteNextAttemptAt" = now() WHERE id = $1`, [second]);
      const issuance = issue(second).then((r) => r); // sent now: it waits for the deletion's row lock
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      expect((await issuance).body.code).toBe('file_deleted');
      expect(await s.query(`SELECT id FROM file_access_ticket WHERE "fileId" = $1`, [second])).toEqual([]);
    } finally {
      await a.end();
    }
  });

  it('delete vs download: authorized before the deletion commits → the stream completes; after → refused (ticket and service paths)', async () => {
    const pdf = Buffer.concat([SAMPLES.pdf(), randomBytes(3 * 1024 * 1024)]);
    const port = (server().address() as AddressInfo).port;
    const streamWhileDeleting = (path: string, headers: Record<string, string>, id: string) => new Promise<{ status: number; sha: string; complete: boolean }>((resolve) => {
      const h = createHash('sha256');
      let first = true;
      httpGet({ host: '127.0.0.1', port, path, headers }, (res) => {
        res.on('data', (c: Buffer) => {
          h.update(c);
          if (!first) return;
          first = false;
          res.pause();
          void del(id).then(() => res.resume()); // the deletion commits while the authorized stream is paused
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, sha: h.digest('hex'), complete: res.complete }));
      });
    });
    const viaTicket = await uploaded({ bytes: pdf });
    const url = (await issue(viaTicket)).body.url as string;
    expect(await streamWhileDeleting(tpath(url), {}, viaTicket)).toEqual({ status: 200, sha: createHash('sha256').update(pdf).digest('hex'), complete: true });
    expect((await request(server()).get(tpath(url))).body.code).toBe('ticket_invalid');
    const viaService = await uploaded({ bytes: pdf });
    expect(await streamWhileDeleting(`/file/files/${viaService}/content`, auth(drive), viaService)).toMatchObject({ status: 200, complete: true });
    expect((await request(server()).get(`/file/files/${viaService}/content`).set(auth(drive))).body.code).toBe('file_deleted');
    // A redemption racing an open deletion transaction waits on the ticket row and is refused once it commits.
    const racing = await uploaded();
    const racingUrl = (await issue(racing)).body.url as string;
    const a = new pg.Client({ connectionString: db.url });
    await a.connect();
    try {
      await a.query('BEGIN');
      await a.query(`UPDATE file SET status = 'DELETING', "deletionRequestedAt" = now(), "deleteNextAttemptAt" = now() WHERE id = $1`, [racing]);
      await a.query(`UPDATE file_access_ticket SET "revokedAt" = now() WHERE "fileId" = $1 AND "revokedAt" IS NULL`, [racing]);
      const redemption = request(server()).get(tpath(racingUrl)).then((r) => r); // sent now: it waits on the revoked ticket row
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      expect((await redemption).body.code).toBe('ticket_invalid');
    } finally {
      await a.end();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────── retention, reconcile

  it('ticket retention removes rows expired past the window, in a bounded batch; recent and live tickets stay', async () => {
    const id = await uploaded();
    const old = randomUUID();
    const recent = randomUUID();
    for (const [tid, age] of [[old, '3 days'], [recent, '1 hour']] as const) {
      await s.query(`INSERT INTO file_access_ticket (id, operation, "fileId", "issuedBy", "tokenDigest", disposition, "singleUse", "createdAt", "expiresAt")
        VALUES ($1, 'download', $2, 'core-drive', $3, 'attachment', false, now() - $4::interval, now() - $4::interval + interval '120 seconds')`, [tid, id, newToken().digest, age]);
    }
    const live = (await issue(id)).body.ticketId as string;
    await worker.runOnce();
    const left = (await s.query<{ id: string }>(`SELECT id FROM file_access_ticket WHERE id = ANY($1::uuid[])`, [[old, recent, live]])).map((r) => r.id);
    expect(left.sort()).toEqual([recent, live].sort());
    expect((await row(id)).status).toBe('AVAILABLE'); // a file is never touched by ticket retention
  });

  it('reconcile (operator tool): a missing object is reported and never reclassified; a leftover object of a failed row is reported, removed with --repair', async () => {
    const missing = await uploaded();
    await storage.delete(await keyOf(missing), { signal: sig() });
    const failed = randomUUID();
    await s.query(`INSERT INTO file (id, "ownerService", "storageProvider", "storageKey", "uploadExpiresAt", "attachDeadline") VALUES ($1, 'core-drive', 'filesystem', $2, now() + interval '1 hour', now() + interval '1 day')`,
      [failed, `files/${failed}/${randomBytes(16).toString('hex')}`]);
    await storage.put(await keyOf(failed), (await import('node:stream')).Readable.from([SAMPLES.pdf(50)]), { sizeBytes: SAMPLES.pdf(50).length, contentType: 'application/pdf', signal: sig() });
    await s.query(`UPDATE file SET status = 'FAILED', "failureCode" = 'finalize_failed' WHERE id = $1`, [failed]);
    const lines: Record<string, unknown>[] = [];
    const dry = await reconcile(t.app.get(DbService), storage, { repair: false, limit: 100_000 }, (l) => lines.push(l));
    expect(lines).toEqual(expect.arrayContaining([{ fileId: missing, status: 'AVAILABLE', finding: 'object_missing' }, { fileId: failed, status: 'FAILED', finding: 'orphan_object' }]));
    expect(JSON.stringify(lines)).not.toMatch(/files\/|storage/);
    expect(dry.next_after).toBeNull();
    expect((await row(missing)).status).toBe('AVAILABLE'); // not "repaired" into a deletion
    expect(await present(failed)).toBe(true); // a dry run changes nothing
    const repaired: Record<string, unknown>[] = [];
    await reconcile(t.app.get(DbService), storage, { repair: true, limit: 100_000 }, (l) => repaired.push(l));
    expect(repaired).toContainEqual({ fileId: failed, status: 'FAILED', finding: 'orphan_object_removed' });
    expect(await present(failed)).toBe(false);
    expect((await row(missing)).status).toBe('AVAILABLE');
    const bounded = await reconcile(t.app.get(DbService), storage, { repair: false, limit: 2 }, () => undefined);
    expect(bounded.scanned).toBe(2);
    expect(bounded.next_after).toMatch(/^[0-9a-f-]{36}$/); // resumable
  });

  it('the cleanup scans use their indexes at scale', async () => {
    await s.query(`INSERT INTO file (id, "ownerService", "storageProvider", "storageKey", "uploadExpiresAt", "attachDeadline")
      SELECT g.id, 'core-drive', 'filesystem', 'files/' || g.id || '/' || md5(g.id::text), now() + interval '1 hour', now() + interval '1 day'
      FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 20000)) g`);
    await s.query(`UPDATE file SET status = 'AVAILABLE', "mediaType" = 'application/pdf', "sizeBytes" = 1, sha256 = repeat('d', 64), "availableAt" = now()
      WHERE id IN (SELECT id FROM file WHERE status = 'UPLOADING' AND "uploadExpiresAt" > now() + interval '30 minutes' LIMIT 15000)`);
    await s.query(`UPDATE file SET status = 'DELETING', "deletionRequestedAt" = now(), "deleteNextAttemptAt" = now() + interval '1 hour'
      WHERE id IN (SELECT id FROM file WHERE status = 'AVAILABLE' LIMIT 3000)`);
    await s.query('ANALYZE file');
    const plan = async (q: string) => (await s.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${q}`)).map((r) => r['QUERY PLAN']).join('\n');
    expect(await plan(`SELECT id FROM file WHERE status = 'DELETING' AND "deleteNextAttemptAt" <= now() AND ("deleteLeaseUntil" IS NULL OR "deleteLeaseUntil" < now()) ORDER BY "deleteNextAttemptAt" LIMIT 20`)).toMatch(/file_delete_due_idx/);
    expect(await plan(`SELECT id FROM file WHERE status = 'UPLOADING' AND "uploadExpiresAt" <= now() ORDER BY "uploadExpiresAt" LIMIT 20`)).toMatch(/file_upload_lease_idx/);
    expect(await plan(`SELECT id FROM file WHERE status = 'AVAILABLE' AND "attachedAt" IS NULL AND "attachDeadline" <= now() ORDER BY "attachDeadline" LIMIT 20`)).toMatch(/file_orphan_deadline_idx/);
    expect(await plan(`SELECT id FROM file_access_ticket WHERE "expiresAt" < now() - interval '1 day' ORDER BY "expiresAt" LIMIT 20`)).toMatch(/file_access_ticket_expiry_idx/);
  });

  it('logs: lifecycle events with ids only; never a storage key, path, token or digest', async () => {
    const logs = JSON.stringify(ALL_LOGS);
    expect(logs).toContain('file_deletion_requested');
    expect(logs).toContain('file_deletion_completed');
    expect(logs).toContain('file_upload_abandoned');
    expect(logs).not.toMatch(/files\/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(logs).not.toContain(TEST_STORAGE_ROOT);
  });
});
