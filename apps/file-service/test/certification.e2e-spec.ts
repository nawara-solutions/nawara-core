import { createHash, randomUUID } from 'node:crypto';
import { createServer as createTcpServer, connect as tcpConnect, type AddressInfo, type Server as TcpServer, type Socket } from 'node:net';
import { readdirSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { CleanupWorker } from '../src/cleanup/cleanup.worker.js';
import { contentDisposition } from '../src/download/content-disposition.js';
import { STORAGE_PORT, type StoragePort } from '../src/storage/storage.port.js';
import { ALL_LOGS, createTestApp, TEST_STORAGE_ROOT, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { Sql } from './support/fixtures.js';
import { SAMPLES } from './support/media.js';
import { rawRequest } from './support/upload.js';
import { TEST_S3_VARS, withTestBucket, type TestS3Env } from './support/s3.js';

/**
 * Stage 17.10: focused certification. The 17.2–17.9 suites prove each stage's own guarantees; this suite proves that they hold
 * TOGETHER, across stage boundaries, on the real application: the isolation and non-disclosure matrix over every owner operation,
 * the whole lifecycle end to end on both adapters, the database-outage contract, and recovery of durable crash leftovers after a
 * restart. Nothing here re-tests a single stage in isolation.
 */
const ALL_OPS = ['upload', 'read', 'attach', 'delete', 'issue_ticket'];
const TYPES = ['application/pdf', 'image/png'];
const POLICY = JSON.stringify({
  callers: {
    'core-drive': { operations: ALL_OPS, organizations: 'request', mediaTypes: TYPES, maxBytes: 4 * 1024 * 1024 },
    'core-billing': { operations: ALL_OPS, organizations: 'request', mediaTypes: TYPES, maxBytes: 4 * 1024 * 1024 },
  },
});
const drive = generateServiceToken();
const billing = generateServiceToken();
const TOKENS = [{ caller: 'core-drive', digest: drive.digest }, { caller: 'core-billing', digest: billing.digest }];
const auth = (tok: { token: string }, org?: string | null) => ({ authorization: `Bearer ${tok.token}`, ...(org ? { 'x-organization-id': org } : {}) });
const sig = () => new AbortController().signal;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function eventually<T>(check: () => Promise<T | undefined>, ms = 8_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describeWithEnv('Stage 17.10 certification (real PostgreSQL, filesystem store)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  const server = () => t.app.getHttpServer();

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'filecert');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens: TOKENS, policy: POLICY, env: { FILE_TICKET_FAILURE_LIMIT: '1000' } });
    await t.app.listen(0, '127.0.0.1');
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await db?.drop();
  });

  const upload = async (who: { token: string }, org: string | null, bytes = SAMPLES.pdf(3_000), attach = true) => {
    const r = await request(server()).post('/file/files').set({ ...auth(who, org), 'idempotency-key': randomUUID(), ...(attach ? { 'x-attach': 'true' } : {}) }).send(bytes);
    expect(r.status).toBe(201);
    return r.body.id as string;
  };

  // ───────────────────────────────────────────────────────────────────────── isolation and non-disclosure (§21–§23)

  it('cross-service and cross-organization isolation: every owner operation answers the SAME 404 for missing, malformed, foreign-service, foreign-organization and platform mismatches, and changes nothing', async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const driveA = await upload(drive, orgA, SAMPLES.pdf(3_000), false); // temporary: attach must not be possible either
    const drivePlatform = await upload(drive, null, SAMPLES.pdf(3_000), false);
    const billingA = await upload(billing, orgA, SAMPLES.pdf(3_000), false);
    const before = await s.query(`SELECT id, status, "attachedAt", "useCount" FROM file LEFT JOIN (SELECT "fileId", sum("useCount") AS "useCount" FROM file_access_ticket GROUP BY 1) t ON t."fileId" = file.id ORDER BY id`);

    // Each probe: [what, caller, organization header, file id]. Every one must look exactly like a file that does not exist.
    const probes: [string, { token: string }, string | null, string][] = [
      ['missing UUID', drive, orgA, randomUUID()],
      ['malformed id', drive, orgA, 'not-a-uuid'],
      ['SQL-shaped id', drive, orgA, "1' OR '1'='1"],
      ['foreign service (Billing on Drive\'s file, same organization)', billing, orgA, driveA],
      ['foreign service (Drive on Billing\'s file, same organization)', drive, orgA, billingA],
      ['foreign organization (right owner, organization B)', drive, orgB, driveA],
      ['missing organization (organization file read as platform)', drive, null, driveA],
      ['platform mismatch (platform file read with an organization)', drive, orgA, drivePlatform],
      ['foreign service on a platform file', billing, null, drivePlatform],
    ];
    const operations: [string, (who: { token: string }, org: string | null, id: string) => request.Test][] = [
      ['metadata', (w, o, id) => request(server()).get(`/file/files/${encodeURIComponent(id)}`).set(auth(w, o))],
      ['content', (w, o, id) => request(server()).get(`/file/files/${encodeURIComponent(id)}/content`).set(auth(w, o))],
      ['issue download ticket', (w, o, id) => request(server()).post(`/file/files/${encodeURIComponent(id)}/tickets`).set(auth(w, o)).send({ operation: 'download' })],
      ['attach', (w, o, id) => request(server()).post(`/file/files/${encodeURIComponent(id)}/attach`).set(auth(w, o))],
      ['delete', (w, o, id) => request(server()).delete(`/file/files/${encodeURIComponent(id)}`).set(auth(w, o))],
    ];
    const shapes = new Set<string>();
    for (const [op, call] of operations) {
      for (const [what, who, org, id] of probes) {
        const r = await call(who, org, id);
        const shape = JSON.stringify({ status: r.status, code: r.body.code, message: r.body.message, error: r.body.error, keys: Object.keys(r.body).sort() });
        expect({ op, what, status: r.status, code: r.body.code }).toEqual({ op, what, status: 404, code: 'file_not_found' });
        shapes.add(shape);
      }
    }
    expect(shapes.size).toBe(1); // one status, one code, one message, one body shape for all 45 probes
    const after = await s.query(`SELECT id, status, "attachedAt", "useCount" FROM file LEFT JOIN (SELECT "fileId", sum("useCount") AS "useCount" FROM file_access_ticket GROUP BY 1) t ON t."fileId" = file.id ORDER BY id`);
    expect(after).toEqual(before); // nothing attached, deleted or ticketed by any probe
    expect(Number((await s.query<{ n: string }>(`SELECT count(*) AS n FROM file_access_ticket WHERE "fileId" = ANY($1::uuid[])`, [[driveA, drivePlatform, billingA]]))[0]!.n)).toBe(0);

    // Ticket revocation is scoped the same way: another service's or organization's ticket, a missing and a malformed id: one 404.
    const issued = await request(server()).post(`/file/files/${driveA}/tickets`).set(auth(drive, orgA)).send({ operation: 'download' });
    expect(issued.status).toBe(201);
    const revokes = await Promise.all([
      request(server()).delete(`/file/tickets/${issued.body.ticketId}`).set(auth(billing, orgA)),
      request(server()).delete(`/file/tickets/${issued.body.ticketId}`).set(auth(drive, orgB)),
      request(server()).delete(`/file/tickets/${issued.body.ticketId}`).set(auth(drive, null)),
      request(server()).delete(`/file/tickets/${randomUUID()}`).set(auth(drive, orgA)),
      request(server()).delete('/file/tickets/not-a-uuid').set(auth(drive, orgA)),
    ]);
    expect(new Set(revokes.map((r) => JSON.stringify([r.status, r.body.code, r.body.message, Object.keys(r.body).sort()]))).size).toBe(1);
    expect(revokes[0]!.status).toBe(404);
    expect(revokes[0]!.body.code).toBe('ticket_not_found');
    expect((await request(server()).get(new URL(issued.body.url as string).pathname)).status).toBe(200); // still live: no probe revoked it
  });

  it('a ticket is not a credential: a download ticket cannot upload, delete, attach, read metadata or act as a service token, and is not consumed by trying', async () => {
    const org = randomUUID();
    const id = await upload(drive, org);
    const issued = await request(server()).post(`/file/files/${id}/tickets`).set(auth(drive, org)).send({ operation: 'download', singleUse: true });
    const path = new URL(issued.body.url as string).pathname;
    const token = path.split('/file/t/')[1]!;
    const put = await request(server()).put(path).set({ 'content-type': 'application/pdf' }).send(SAMPLES.pdf(1_000));
    expect([put.status, put.body.code]).toEqual([404, 'ticket_invalid']);
    for (const method of ['delete', 'post', 'patch'] as const) expect((await request(server())[method](path)).status).toBeGreaterThanOrEqual(400);
    for (const bearer of [token, `Bearer ${token}`]) {
      expect((await request(server()).get(`/file/files/${id}`).set({ authorization: bearer.startsWith('Bearer') ? bearer : `Bearer ${bearer}` })).status).toBe(401);
      expect((await request(server()).delete(`/file/files/${id}`).set({ authorization: `Bearer ${token}` })).status).toBe(401);
    }
    const r = await request(server()).get(path); // the single use is still there after all of the above
    expect([r.status, sha256(r.body as Buffer)]).toEqual([200, (await s.query<{ sha256: string }>('SELECT sha256 FROM file WHERE id = $1', [id]))[0]!.sha256]);
    expect((await request(server()).get(path)).status).toBe(404);
  });

  // ───────────────────────────────────────────────────────────────────── lifecycle end to end (§10–§17, §26–§27)

  it('the whole lifecycle on the filesystem store: ticket upload → retry → attach → reusable and single-use downloads → delete → retries → worker → DELETED, with idempotent deletes after the tombstone', async () => {
    await lifecycle(t, s, t.app.get<StoragePort>(STORAGE_PORT));
  });

  it('temporary files: an unattached file past its deadline is expired, its tickets revoked, its object removed and the row DELETED by the workers alone', async () => {
    const storage = t.app.get<StoragePort>(STORAGE_PORT);
    const org = randomUUID();
    const id = await upload(drive, org, SAMPLES.pdf(2_000), false);
    const issued = await request(server()).post(`/file/files/${id}/tickets`).set(auth(drive, org)).send({ operation: 'download' });
    const key = (await s.query<{ storageKey: string }>('SELECT "storageKey" FROM file WHERE id = $1', [id]))[0]!.storageKey;
    // The deadline is immutable (schema): the row is REPLACED by an identical one whose deadline has passed, with its object in place.
    const expired = randomUUID();
    const expiredKey = `files/${expired}/${'e'.repeat(32)}`;
    await s.query(`INSERT INTO file (id, "ownerService", "organizationId", "storageProvider", "storageKey", "createdAt", "uploadExpiresAt", "attachDeadline")
                   VALUES ($1, 'core-drive', $2, 'filesystem', $3, now() - interval '2 days', now() - interval '47 hours', now() - interval '1 hour')`, [expired, org, expiredKey]);
    await storage.put(expiredKey, (await import('node:stream')).Readable.from([SAMPLES.pdf(1_000)]), { sizeBytes: SAMPLES.pdf(1_000).length, contentType: 'application/pdf', signal: sig() });
    await s.query(`UPDATE file SET status = 'AVAILABLE', "mediaType" = 'application/pdf', "sizeBytes" = 1000, sha256 = repeat('0', 64), "availableAt" = now() WHERE id = $1`, [expired]);
    const pass = await t.app.get(CleanupWorker).runOnce();
    expect(pass.expired).toBeGreaterThanOrEqual(1);
    const row = (await s.query<{ status: string }>('SELECT status FROM file WHERE id = $1', [expired]))[0]!;
    expect(row.status).toBe('DELETED'); // expired and physically deleted in the same pass (same path as a requested deletion)
    expect(await storage.head(expiredKey, { signal: sig() })).toBeUndefined();
    // The in-time temporary file and its ticket are untouched.
    expect((await s.query<{ status: string }>('SELECT status FROM file WHERE id = $1', [id]))[0]!.status).toBe('AVAILABLE');
    expect(await storage.head(key, { signal: sig() })).toBeDefined();
    expect((await request(server()).get(new URL(issued.body.url as string).pathname)).status).toBe(200);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────── database outage (§35)

  it('database outage: /ready fails and /health stays live; uploads, redemptions, tickets and deletes fail closed with NO object written; recovery needs nothing', async () => {
    const proxy = await dbProxy(db.url);
    const down = await createTestApp({ databaseUrl: proxy.url, tokens: TOKENS, policy: POLICY, env: { FILE_TICKET_FAILURE_LIMIT: '1000', DB_CONNECTION_TIMEOUT_MS: '1000', DB_STATEMENT_TIMEOUT_MS: '1500', DB_QUERY_TIMEOUT_MS: '2500' } });
    await down.app.listen(0, '127.0.0.1');
    try {
      const org = randomUUID();
      const ok = await request(down.app.getHttpServer()).post('/file/files').set({ ...auth(drive, org), 'idempotency-key': randomUUID(), 'x-attach': 'true' }).send(SAMPLES.pdf(2_000));
      expect(ok.status).toBe(201);
      const ticket = await request(down.app.getHttpServer()).post('/file/uploads/tickets').set(auth(drive, org)).send({ organizationId: org, maxBytes: 100_000, mediaTypes: ['application/pdf'] });
      expect(ticket.status).toBe(201);
      const objectsBefore = countObjects();
      const rowsBefore = Number((await s.query<{ n: string }>('SELECT count(*) AS n FROM file'))[0]!.n);
      proxy.cut(); // PostgreSQL unreachable: existing connections reset, new ones refused
      await eventually(async () => ((await request(down.app.getHttpServer()).get('/ready')).status === 503 ? true : undefined), 15_000);
      await request(down.app.getHttpServer()).get('/health').expect(200);
      const refused = await Promise.all([
        rawRequest(down.app, { method: 'POST', path: '/file/files', headers: { ...auth(drive, org), 'idempotency-key': randomUUID(), 'content-type': 'application/pdf', 'content-length': '2000' }, body: SAMPLES.pdf(2_000) }),
        rawRequest(down.app, { method: 'PUT', path: new URL(ticket.body.url as string).pathname, headers: { 'content-type': 'application/pdf', 'content-length': '2000' }, body: SAMPLES.pdf(2_000) }),
        request(down.app.getHttpServer()).post(`/file/files/${ok.body.id}/tickets`).set(auth(drive, org)).send({ operation: 'download' }),
        request(down.app.getHttpServer()).delete(`/file/files/${ok.body.id}`).set(auth(drive, org)),
        request(down.app.getHttpServer()).get(`/file/files/${ok.body.id}/content`).set(auth(drive, org)),
      ]);
      for (const r of refused) {
        const status = r === 'socket_closed' ? 0 : r.status;
        expect(status === 0 || status >= 500).toBe(true); // never a success, never a client error that blames the caller
        const body = r === 'socket_closed' ? '' : 'body' in r && typeof r.body === 'string' ? r.body : JSON.stringify((r as request.Response).body);
        expect(body).not.toMatch(/postgres|ECONN|password|127\.0\.0\.1/i);
      }
      expect(countObjects()).toBe(objectsBefore); // no byte reached the store without a durable row
      proxy.restore();
      await eventually(async () => ((await request(down.app.getHttpServer()).get('/ready')).status === 200 ? true : undefined), 15_000);
      expect(Number((await s.query<{ n: string }>('SELECT count(*) AS n FROM file'))[0]!.n)).toBe(rowsBefore); // nothing half-created
      const redeemed = await request(down.app.getHttpServer()).put(new URL(ticket.body.url as string).pathname).set({ 'content-type': 'application/pdf' }).send(SAMPLES.pdf(2_000));
      expect(redeemed.status).toBe(201); // the upload ticket was never consumed by the failed attempt
      expect((await request(down.app.getHttpServer()).get(`/file/files/${ok.body.id}/content`).set(auth(drive, org))).status).toBe(200);
    } finally {
      proxy.restore();
      await down.app.close();
      await proxy.close();
    }
  }, 90_000);

  // ────────────────────────────────────────────────────────────────────────────────────── restart recovery (§37)

  it('restart recovery: durable leftovers of a crash (DELETING, a leased claim, a retry, a stale UPLOADING with its object, an expired temporary file, live tickets, a spent budget) converge after a restart with no manual step', async () => {
    await s.query('DELETE FROM kit_rate_limit'); // the isolation probes above spent this caller's budget (probes are charged, by design)
    const first = await createTestApp({ databaseUrl: db.url, tokens: TOKENS, policy: POLICY, env: { FILE_TICKET_RATE_PER_CALLER: '2', FILE_TICKET_RATE_PER_ORGANIZATION: '2' } });
    await first.app.listen(0, '127.0.0.1');
    const storage = first.app.get<StoragePort>(STORAGE_PORT);
    const org = randomUUID();
    const id = async (attach = true) => {
      const r = await request(first.app.getHttpServer()).post('/file/files').set({ ...auth(billing, org), 'idempotency-key': randomUUID(), ...(attach ? { 'x-attach': 'true' } : {}) }).send(SAMPLES.pdf(1_500));
      expect(r.status).toBe(201);
      return r.body.id as string;
    };
    const deleting = await id();
    const leased = await id();
    const retrying = await id();
    const live = await id();
    await request(first.app.getHttpServer()).delete(`/file/files/${deleting}`).set(auth(billing, org)).expect(202);
    await request(first.app.getHttpServer()).delete(`/file/files/${leased}`).set(auth(billing, org)).expect(202);
    await request(first.app.getHttpServer()).delete(`/file/files/${retrying}`).set(auth(billing, org)).expect(202);
    const ticket = await request(first.app.getHttpServer()).post(`/file/files/${live}/tickets`).set(auth(billing, org)).send({ operation: 'download' });
    expect(ticket.status).toBe(201);
    await request(first.app.getHttpServer()).post(`/file/files/${live}/tickets`).set(auth(billing, org)).send({ operation: 'download' }).expect(201);
    expect((await request(first.app.getHttpServer()).post(`/file/files/${live}/tickets`).set(auth(billing, org)).send({ operation: 'download' })).status).toBe(429);
    // What a crash leaves behind: a claim whose worker died (lease still running), a delete that failed earlier (rescheduled), an upload
    // whose object was published but never finalized (past its lease), and an unattached file past its deadline.
    await s.query(`UPDATE file SET "deleteLeaseUntil" = now() + interval '2 seconds', "deleteAttempts" = 1 WHERE id = $1`, [leased]);
    await s.query(`UPDATE file SET "deleteAttempts" = 2, "deleteLastError" = 'storage_unavailable', "deleteNextAttemptAt" = now() - interval '1 second' WHERE id = $1`, [retrying]);
    const stale = randomUUID();
    const staleKey = `files/${stale}/${'a'.repeat(32)}`;
    await s.query(`INSERT INTO file (id, "ownerService", "organizationId", "storageProvider", "storageKey", "createdAt", "uploadExpiresAt", "attachedAt")
                   VALUES ($1, 'core-billing', $2, 'filesystem', $3, now() - interval '1 hour', now() - interval '1 minute', now() - interval '1 hour')`, [stale, org, staleKey]);
    await storage.put(staleKey, (await import('node:stream')).Readable.from([SAMPLES.pdf(900)]), { sizeBytes: SAMPLES.pdf(900).length, contentType: 'application/pdf', signal: sig() });
    const keys = Object.fromEntries((await s.query<{ id: string; storageKey: string }>('SELECT id, "storageKey" FROM file WHERE id = ANY($1::uuid[])', [[deleting, leased, retrying, live, stale]])).map((r) => [r.id, r.storageKey]));
    await first.app.close(); // the "crash": nothing is finished by the first process

    const second = await createTestApp({ databaseUrl: db.url, tokens: TOKENS, policy: POLICY, env: { FILE_TICKET_RATE_PER_CALLER: '2', FILE_TICKET_RATE_PER_ORGANIZATION: '2' } });
    await second.app.listen(0, '127.0.0.1');
    try {
      const worker = second.app.get(CleanupWorker);
      await worker.runOnce();
      // The leased claim is NOT touched while its lease runs (another worker might still hold it) …
      expect((await s.query<{ status: string }>('SELECT status FROM file WHERE id = $1', [leased]))[0]!.status).toBe('DELETING');
      await new Promise((r) => setTimeout(r, 2_500));
      await worker.runOnce(); // … and is reclaimed once it expires.
      const states = Object.fromEntries((await s.query<{ id: string; status: string; failureCode: string | null }>('SELECT id, status, "failureCode" FROM file WHERE id = ANY($1::uuid[])', [[deleting, leased, retrying, live, stale]])).map((r) => [r.id, [r.status, r.failureCode]]));
      expect(states).toEqual({ [deleting]: ['DELETED', null], [leased]: ['DELETED', null], [retrying]: ['DELETED', null], [live]: ['AVAILABLE', null], [stale]: ['FAILED', 'upload_abandoned'] });
      const s2 = second.app.get<StoragePort>(STORAGE_PORT);
      for (const gone of [deleting, leased, retrying, stale]) expect(await s2.head(keys[gone]!, { signal: sig() })).toBeUndefined();
      expect(await s2.head(keys[live]!, { signal: sig() })).toBeDefined();
      expect((await request(second.app.getHttpServer()).get(new URL(ticket.body.url as string).pathname)).status).toBe(200); // live tickets survive
      expect((await request(second.app.getHttpServer()).post(`/file/files/${live}/tickets`).set(auth(billing, org)).send({ operation: 'download' })).status).toBe(429); // so does the spent budget (database state)
    } finally {
      await second.app.close();
    }
  }, 60_000);

  it('the OpenAPI contract documents every status the routes answer: authentication, policy, non-disclosure, lifecycle (409 / 410), 429 and 503', async () => {
    const password = 'cert-docs-password-0123';
    const docs = await createTestApp({ probes: false, env: { SWAGGER_PASSWORD: password }, docs: true });
    try {
      const doc = (await request(docs.app.getHttpServer()).get('/file/docs-json').auth('docs', password).expect(200)).body as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
      const codes = (path: string, method: string) => Object.keys(doc.paths[path]![method]!.responses).sort();
      const expected: [string, string, string[]][] = [
        ['/file/uploads/tickets', 'post', ['201', '400', '401', '403', '429']],
        ['/file/files', 'post', ['200', '201', '400', '401', '403', '408', '409', '411', '413', '415', '422', '429', '500', '503']],
        ['/file/files/{id}/attach', 'post', ['200', '400', '401', '403', '404', '409']],
        ['/file/t/{token}', 'put', ['200', '201', '400', '404', '408', '409', '411', '413', '415', '422', '429', '500', '503']],
        ['/file/t/{token}', 'get', ['200', '404', '429', '500', '503']],
        ['/file/files/{id}', 'get', ['200', '400', '401', '403', '404']],
        ['/file/files/{id}', 'delete', ['202', '400', '401', '403', '404', '409']],
        ['/file/files/{id}/content', 'get', ['200', '400', '401', '403', '404', '409', '410', '429', '500', '503']],
        ['/file/files/{id}/tickets', 'post', ['201', '400', '401', '403', '404', '409', '410', '422', '429']],
        ['/file/tickets/{ticketId}', 'delete', ['204', '401', '403', '404']],
      ];
      for (const [path, method, want] of expected) expect({ path, method, codes: codes(path, method) }).toEqual({ path, method, codes: [...want].sort() });
    } finally {
      await docs.app.close();
    }
  });

  it('certification log scan: across every application of this suite, no token, ticket, digest, storage key, file name or credential reached a log line', async () => {
    const all = JSON.stringify(ALL_LOGS);
    const secrets = (await s.query<{ storageKey: string; tokenDigest: string | null; originalName: string | null }>(
      `SELECT f."storageKey", t."tokenDigest", f."originalName" FROM file f LEFT JOIN file_access_ticket t ON t."fileId" = f.id`,
    )).flatMap((r) => [r.storageKey, r.tokenDigest, r.originalName]).filter((v): v is string => typeof v === 'string' && v.length > 8);
    for (const v of [...secrets, drive.token, billing.token, drive.digest, billing.digest]) expect(all).not.toContain(v);
    expect(all).not.toMatch(/\/file\/t\/[A-Za-z0-9_-]{43}/);
  });
});

describeWithEnv('Stage 17.10 certification (real PostgreSQL, S3-compatible store)', ['TEST_DATABASE_ADMIN_URL', ...TEST_S3_VARS], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  let bucket: Awaited<ReturnType<typeof withTestBucket>>;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'filecerts3');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    bucket = await withTestBucket(env as unknown as TestS3Env);
    t = await createTestApp({
      databaseUrl: db.url, tokens: TOKENS, policy: POLICY,
      env: {
        FILE_TICKET_FAILURE_LIMIT: '1000', FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: env.TEST_S3_ENDPOINT, FILE_S3_REGION: 'us-east-1', FILE_S3_BUCKET: bucket.bucket,
        FILE_S3_FORCE_PATH_STYLE: 'true', FILE_S3_ACCESS_KEY_ID: env.TEST_S3_ACCESS_KEY_ID, FILE_S3_SECRET_ACCESS_KEY: env.TEST_S3_SECRET_ACCESS_KEY,
      },
    });
    await t.app.listen(0, '127.0.0.1');
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await bucket?.drop();
    await db?.drop();
  });

  it('the whole lifecycle on the S3-compatible store: ticket upload → retry → attach → reusable and single-use downloads → delete → worker → DELETED, with idempotent deletes after the tombstone', async () => {
    await lifecycle(t, s, t.app.get<StoragePort>(STORAGE_PORT));
    expect(JSON.stringify(ALL_LOGS)).not.toContain(bucket.bucket);
    expect(JSON.stringify(ALL_LOGS)).not.toContain(env.TEST_S3_SECRET_ACCESS_KEY);
  });
});

/** The integrated journey, identical on both adapters: every stage's guarantee, in the order a product exercises them. */
async function lifecycle(t: TestApp, s: Sql, storage: StoragePort): Promise<void> {
  const server = () => t.app.getHttpServer();
  const org = randomUUID();
  const bytes = SAMPLES.pdf(300_000);
  const name = 'Contrat été — عقد.pdf';

  // 17.5: a trusted service issues a single-use upload ticket; an untrusted client redeems it (no identity of its own).
  const issued = await request(server()).post('/file/uploads/tickets').set(auth(drive, org)).send({ organizationId: org, maxBytes: 1_000_000, mediaTypes: ['application/pdf'] });
  expect(issued.status).toBe(201);
  const upPath = new URL(issued.body.url as string).pathname;
  const upToken = upPath.split('/file/t/')[1]!;
  const put = await request(server()).put(upPath).set({ 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name), 'x-owner-service': 'core-billing' }).send(bytes);
  expect(put.status).toBe(201);
  const id = put.body.id as string;
  expect(put.body).toMatchObject({ status: 'AVAILABLE', organizationId: org, mediaType: 'application/pdf', sizeBytes: bytes.length, sha256: sha256(bytes), attachedAt: null });
  expect(Object.keys(put.body)).not.toEqual(expect.arrayContaining(['storageKey']));
  const row = (await s.query<Record<string, unknown>>('SELECT * FROM file WHERE id = $1', [id]))[0]!;
  expect(row.ownerService).toBe('core-drive'); // the issuer, never a request header
  expect(row.originalName).toBe(name.normalize('NFC'));
  const stored = (await s.query<{ tokenDigest: string }>('SELECT "tokenDigest" FROM file_access_ticket WHERE "fileId" = $1', [id]))[0]!;
  expect(stored.tokenDigest).toBe(sha256(Buffer.from(upToken))); // the digest only, never the token
  expect(JSON.stringify(await s.query('SELECT * FROM file_access_ticket'))).not.toContain(upToken);
  // A retry of the completed redemption returns the same file and stores nothing; the object is immutable.
  const again = await request(server()).put(upPath).set({ 'content-type': 'application/pdf' }).send(SAMPLES.pdf(300_000));
  expect([again.status, again.body.id, again.body.sha256]).toEqual([200, id, sha256(bytes)]);
  const key = row.storageKey as string;
  expect(await storage.head(key, { signal: sig() })).toEqual({ sizeBytes: bytes.length });

  // 17.5: attach, idempotently.
  for (let i = 0; i < 2; i++) expect((await request(server()).post(`/file/files/${id}/attach`).set(auth(drive, org))).status).toBe(200);

  // 17.6 / 17.8: a reusable download ticket serves byte-exact, verified content with the frozen headers; a single-use one serves once.
  const dl = await request(server()).post(`/file/files/${id}/tickets`).set(auth(drive, org)).send({ operation: 'download' });
  const dlPath = new URL(dl.body.url as string).pathname;
  for (let i = 0; i < 2; i++) {
    const r = await request(server()).get(dlPath).buffer(true).parse((res, cb) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => cb(null, Buffer.concat(parts)));
    });
    expect(r.status).toBe(200);
    expect(sha256(r.body as Buffer)).toBe(sha256(bytes));
    expect(r.headers).toMatchObject({
      'content-type': 'application/pdf', 'content-length': String(bytes.length), 'cache-control': 'private, no-store', pragma: 'no-cache',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'referrer-policy': 'no-referrer',
      etag: `"${sha256(bytes)}"`, 'accept-ranges': 'none', 'cross-origin-resource-policy': 'cross-origin',
    });
    const cd = r.headers['content-disposition'] as string;
    expect(cd).toBe(contentDisposition('attachment', name.normalize('NFC'), 'application/pdf'));
    expect(cd).toMatch(/^attachment; filename="[\x20-\x21\x23-\x5b\x5d-\x7e]+"; filename\*=UTF-8''[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
    expect(decodeURIComponent(cd.split("UTF-8''")[1]!)).toBe(name.normalize('NFC')); // French and Arabic survive, byte for byte
  }
  const once = await request(server()).post(`/file/files/${id}/tickets`).set(auth(drive, org)).send({ operation: 'download', singleUse: true });
  const oncePath = new URL(once.body.url as string).pathname;
  expect((await request(server()).get(oncePath)).status).toBe(200);
  expect((await request(server()).get(oncePath)).body.code).toBe('ticket_invalid');
  const service = await request(server()).get(`/file/files/${id}/content`).set(auth(drive, org));
  expect([service.status, service.headers['cross-origin-resource-policy']]).toEqual([200, 'same-origin']);

  // 17.7: logical delete — access stops at once, tickets revoked, bytes still in the store until the worker.
  const del = await request(server()).delete(`/file/files/${id}`).set(auth(drive, org));
  expect([del.status, del.body.status]).toEqual([202, 'DELETING']);
  expect((await request(server()).get(`/file/files/${id}/content`).set(auth(drive, org))).status).toBe(410);
  expect((await request(server()).get(dlPath)).body.code).toBe('ticket_invalid');
  expect((await request(server()).post(`/file/files/${id}/tickets`).set(auth(drive, org)).send({ operation: 'download' })).status).toBe(410);
  expect((await request(server()).post(`/file/files/${id}/attach`).set(auth(drive, org))).status).toBe(200); // already attached: idempotent, no restore
  expect(await storage.head(key, { signal: sig() })).toBeDefined();
  // A lost response retried: the same 202, the same request time, no second transition.
  const retry = await request(server()).delete(`/file/files/${id}`).set(auth(drive, org));
  expect([retry.status, retry.body.status]).toEqual([202, 'DELETING']);
  const requestedAt = (await s.query<{ deletionRequestedAt: Date }>('SELECT "deletionRequestedAt" FROM file WHERE id = $1', [id]))[0]!.deletionRequestedAt;

  // The worker removes the bytes and writes the tombstone; later deletes answer the same 202 and never restore access.
  const pass = await t.app.get(CleanupWorker).runOnce();
  expect(pass.deleted).toBeGreaterThanOrEqual(1);
  expect(await storage.head(key, { signal: sig() })).toBeUndefined();
  const tomb = (await s.query<{ status: string; deletionRequestedAt: Date; deletedAt: Date }>('SELECT status, "deletionRequestedAt", "deletedAt" FROM file WHERE id = $1', [id]))[0]!;
  expect([tomb.status, tomb.deletionRequestedAt.getTime()]).toEqual(['DELETED', requestedAt.getTime()]);
  const late = await request(server()).delete(`/file/files/${id}`).set(auth(drive, org));
  expect([late.status, late.body.status]).toEqual([202, 'DELETED']);
  expect((await request(server()).get(`/file/files/${id}/content`).set(auth(drive, org))).status).toBe(410);
  expect((await request(server()).get(`/file/files/${id}`).set(auth(drive, org))).body.status).toBe('DELETED'); // the tombstone stays
  await t.app.get(CleanupWorker).runOnce();
  expect((await s.query<{ status: string }>('SELECT status FROM file WHERE id = $1', [id]))[0]!.status).toBe('DELETED'); // terminal
}

/** Every object currently in the filesystem store (keys only). */
function countObjects(): number {
  let n = 0;
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.tmp') continue;
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else n += 1;
    }
  };
  walk(TEST_STORAGE_ROOT);
  return n;
}

/** A TCP proxy in front of PostgreSQL that can be cut (resets live connections, refuses new ones) and restored. */
async function dbProxy(url: string): Promise<{ url: string; cut: () => void; restore: () => void; close: () => Promise<void> }> {
  const target = new URL(url);
  let open = true;
  const pairs = new Set<Socket>();
  const server: TcpServer = createTcpServer((client) => {
    if (!open) return void client.destroy();
    const upstream = tcpConnect(Number(target.port), target.hostname);
    pairs.add(client).add(upstream);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      pairs.delete(client);
      pairs.delete(upstream);
    };
    client.on('error', drop).on('close', drop);
    upstream.on('error', drop).on('close', drop);
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const proxied = new URL(url);
  proxied.hostname = '127.0.0.1';
  proxied.port = String((server.address() as AddressInfo).port);
  return {
    url: proxied.toString(),
    cut: () => {
      open = false;
      for (const sk of pairs) sk.destroy();
      pairs.clear();
    },
    restore: () => {
      open = true;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
