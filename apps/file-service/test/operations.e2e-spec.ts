import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as createHttpServer, get as httpGet, IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { CleanupWorker } from '../src/cleanup/cleanup.worker.js';
import { FileOpsReporter } from '../src/ops/ops-reporter.js';
import { ALL_LOGS, createTestApp, TEST_STORAGE_ROOT, TEST_UPLOAD_ENV, type TestApp } from './support/app.js';
import { DELETE_POLICY } from './support/deletion.js';
import { describeWithEnv } from './support/env.js';
import { fileRow, Sql } from './support/fixtures.js';
import { SAMPLES } from './support/media.js';
import { eventually, rawRequest } from './support/upload.js';

/**
 * Stage 17.9: the operational behaviour that must hold on every run (the measurements live in `test/ops`, `npm run test:ops`): the
 * download bound (503 download_busy, nothing consumed, the slot released on disconnect), the whole-transfer download deadline, the
 * operational snapshot (bounded fields only), service-token and request-hash key rotation, and readiness while the service is busy.
 */
describeWithEnv('operational hardening (real PostgreSQL, filesystem store)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let s: Sql;
  const drive = generateServiceToken();
  const tokens = [{ caller: 'core-drive', digest: drive.digest }];
  const policy = JSON.stringify({ callers: { 'core-drive': DELETE_POLICY.callers['core-drive'] } });
  const auth = (tok = drive) => ({ authorization: `Bearer ${tok.token}` });
  const opened: TestApp[] = [];
  const app = async (extra: Record<string, string> = {}, over: { tokens?: typeof tokens } = {}) => {
    const t = await createTestApp({ databaseUrl: db.url, tokens: over.tokens ?? tokens, policy, env: { FILE_TICKET_FAILURE_LIMIT: '1000', ...extra } });
    await t.app.listen(0, '127.0.0.1');
    opened.push(t);
    return t;
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileops');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    for (const t of opened) await t.app.close().catch(() => undefined);
    await s?.end();
    await db?.drop();
  });
  beforeEach(async () => {
    await s.query('DELETE FROM kit_rate_limit');
  });

  const upload = async (t: TestApp, bytes: Buffer, headers: Record<string, string> = {}) => {
    const r = await request(t.app.getHttpServer()).post('/file/files').set({ ...auth(), 'idempotency-key': randomUUID(), ...headers }).send(bytes);
    expect(r.status).toBe(201);
    return r.body.id as string;
  };

  /** A download that reads the first chunk, then holds the response unread until `release` resolves. */
  function hold(t: TestApp, path: string, headers: Record<string, string> = {}) {
    const port = (t.app.getHttpServer().address() as AddressInfo).port;
    let resume!: () => void;
    let abort!: () => void;
    const started = new Promise<void>((ok) => {
      const req = httpGet({ host: '127.0.0.1', port, path, headers }, (res) => {
        res.once('data', () => {
          res.pause();
          ok();
        });
        resume = () => res.resume();
      });
      abort = () => req.destroy();
      req.on('error', () => undefined);
    });
    return { started, resume: () => resume(), abort: () => abort() };
  }

  it('the download bound: at capacity a service read and a ticket redemption are 503 download_busy, the ticket keeps its uses, /ready stays 200', async () => {
    const t = await app({ FILE_DOWNLOAD_MAX_IN_FLIGHT: '1', FILE_TICKET_MAX_DOWNLOADS: '2' });
    const big = await upload(t, SAMPLES.pdf(8 * 1024 * 1024));
    const small = await upload(t, SAMPLES.pdf(2_000));
    const ticketUrl = new URL((await request(t.app.getHttpServer()).post(`/file/files/${small}/tickets`).set(auth()).send({ operation: 'download' })).body.url as string).pathname;
    const holder = hold(t, `/file/files/${big}/content`, auth());
    await holder.started;
    const busy = await request(t.app.getHttpServer()).get(`/file/files/${small}/content`).set(auth());
    expect([busy.status, busy.body.code]).toEqual([503, 'download_busy']);
    for (let i = 0; i < 3; i++) {
      const r = await request(t.app.getHttpServer()).get(ticketUrl);
      expect([r.status, r.body.code]).toEqual([503, 'download_busy']);
    }
    // Junk tickets never occupy (or wait for) a download slot: still the one `ticket_invalid`, even with the process full.
    for (let i = 0; i < 5; i++) {
      const junk = await request(t.app.getHttpServer()).get(`/file/t/${createHash('sha256').update(String(i)).digest('base64url').slice(0, 43)}`);
      expect([junk.status, junk.body.code]).toEqual([404, 'ticket_invalid']);
    }
    const digest = createHash('sha256').update(ticketUrl.split('/file/t/')[1]!).digest('hex');
    expect(((await s.query(`SELECT "useCount" FROM file_access_ticket WHERE "tokenDigest" = $1`, [digest]))[0] as { useCount: number }).useCount).toBe(0);
    // While the held download streams, the service holds NO database session busy: authorization finished before the first byte.
    const busySessions = await s.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'file-service' AND state <> 'idle'`);
    expect(busySessions[0]!.n).toBe(0);
    expect(t.app.get(DbService).poolStats().waiting).toBe(0);
    // The silent-socket bound is set on the real server (Node's default 0 never closes a connection that sends nothing).
    expect(t.app.getHttpServer().timeout).toBe(65_000);
    await request(t.app.getHttpServer()).get('/ready').expect(200); // busy is not unready (no eviction of a healthy process)
    await request(t.app.getHttpServer()).get('/health').expect(200);
    holder.abort(); // the client leaves: its slot must come back
    const after = await eventually(async () => {
      const r = await request(t.app.getHttpServer()).get(ticketUrl);
      return r.status === 503 ? undefined : r;
    });
    expect(after.status).toBe(200);
    expect((await request(t.app.getHttpServer()).get(ticketUrl)).status).toBe(200); // the second of its 2 uses: none was spent by a 503
    const counters = t.logs.map((l) => String(l.msg));
    expect(counters.some((m) => m.startsWith('file_download route=service outcome=aborted'))).toBe(true);
  });

  it('the whole-transfer download deadline cuts a reader that trickles, frees its slot, and counts it', async () => {
    // 8 MiB at a floor of 1 MiB/s: 1 s + 8 s. The client reads 128 KiB/s (64 s for the whole): cut near 9 s.
    const t = await app({ FILE_DOWNLOAD_MAX_IN_FLIGHT: '1', FILE_DOWNLOAD_MIN_THROUGHPUT_BYTES_PER_SECOND: '1048576', FILE_STORAGE_REQUEST_TIMEOUT_MS: '1000' });
    const id = await upload(t, SAMPLES.pdf(8 * 1024 * 1024));
    const port = (t.app.getHttpServer().address() as AddressInfo).port;
    const started = Date.now();
    const finished = new Promise<{ complete: boolean; bytes: number }>((resolve) => {
      let bytes = 0;
      const req = httpGet({ host: '127.0.0.1', port, path: `/file/files/${id}/content`, headers: auth() }, (res) => {
        res.on('data', (c: Buffer) => {
          bytes += c.length;
          res.pause();
          setTimeout(() => res.resume(), Math.ceil((c.length / (128 * 1024)) * 1000));
        });
        res.on('close', () => resolve({ complete: res.complete, bytes }));
      });
      req.on('error', () => resolve({ complete: false, bytes }));
    });
    // Timed on the SERVER (its log line): the client may keep reading what the kernel already buffered after the cut.
    const line = await eventually(async () => ALL_LOGS.map((l) => String(l.msg)).find((m) => m.startsWith(`file_download route=service outcome=deadline file=${id}`)), 40_000);
    const cutAfter = Date.now() - started;
    expect(line).toBeDefined();
    expect(cutAfter).toBeGreaterThanOrEqual(8_500);
    expect(cutAfter).toBeLessThan(25_000);
    const result = await finished;
    expect(result.complete).toBe(false);
    expect(result.bytes).toBeLessThan(8 * 1024 * 1024);
    expect((await request(t.app.getHttpServer()).get(`/file/files/${id}`).set(auth())).status).toBe(200);
    const small = await upload(t, SAMPLES.pdf(1_000));
    expect((await request(t.app.getHttpServer()).get(`/file/files/${small}/content`).set(auth())).status).toBe(200); // the slot came back
  }, 60_000);

  it('the operational snapshot: backlog, gauges, per-interval counters and storage lines, with bounded fields only (no id, key, name)', async () => {
    const t = await app();
    const org = randomUUID();
    const id = await upload(t, SAMPLES.pdf(3_000), { 'x-organization-id': org, 'x-file-name': 'secret-name.pdf' });
    await request(t.app.getHttpServer()).get(`/file/t/${'A'.repeat(43)}`).expect(404);
    await request(t.app.getHttpServer()).delete(`/file/files/${id}`).set({ ...auth(), 'x-organization-id': org }).expect(202);
    await s.query(`UPDATE file SET "deleteAttempts" = 3, "deleteLastError" = 'storage_unavailable' WHERE id = $1`, [id]); // "deletionRequestedAt" is set once (schema)
    await s.insert('file', fileRow({ createdAt: new Date(Date.now() - 600_000), uploadExpiresAt: new Date(Date.now() - 60_000), organizationId: org })); // a stale upload
    const from = ALL_LOGS.length;
    const snap = await t.app.get(FileOpsReporter).report();
    expect(snap).toMatchObject({ deleting: 1, deleteRetrying: 1, maxDeleteAttempts: 3, staleUploads: 1, deleteErrors: { storage_unavailable: 1 } });
    expect(snap.oldestDeletingAgeSec).toBeGreaterThanOrEqual(0);
    const lines = ALL_LOGS.slice(from).map((l) => String(l.msg));
    const main = lines.find((m) => m.startsWith('file_ops_snapshot '))!;
    expect(main).toMatch(/deleting=1 .*delete_errors=storage_unavailable:1 .*uploads_in_flight=0\/64 downloads_in_flight=0\/64 db_pool_total=\d+ db_pool_idle=\d+ db_pool_waiting=0/);
    const counters = lines.find((m) => m.startsWith('file_ops_counters '))!;
    expect(counters).toMatch(/ticket_invalid=1/);
    expect(lines.some((m) => /^file_storage_ops window_s=\d+ provider=filesystem op=put outcome=ok count=1 /.test(m))).toBe(true);
    const all = lines.join('\n');
    const key = ((await s.query(`SELECT "storageKey" FROM file WHERE id = $1`, [id]))[0] as { storageKey: string }).storageKey;
    for (const leak of [id, org, key, 'secret-name', 'core-drive', drive.token, drive.digest]) expect(all).not.toContain(leak);
    // Every field is `name=value` with a bounded value: numbers, n/m gauges, or known codes.
    for (const m of lines) for (const field of m.split(' ').slice(1)) expect(field).toMatch(/^[a-z_]+=([0-9]+(\/[0-9]+)?|[a-z0-9_:,.]+)$/);
  });

  it('an integrity incident reaches the snapshot: digest, size and missing-object counters, and one error line per interval', async () => {
    const t = await app();
    const id = await upload(t, SAMPLES.pdf(2_000));
    const key = ((await s.query(`SELECT "storageKey" FROM file WHERE id = $1`, [id]))[0] as { storageKey: string }).storageKey;
    const forged = SAMPLES.pdf(2_000);
    writeFileSync(join(TEST_STORAGE_ROOT, key), forged); // same size, other bytes (the random tail)
    await t.app.get(FileOpsReporter).report(); // drain earlier counts
    await request(t.app.getHttpServer()).get(`/file/files/${id}/content`).set(auth()).catch(() => undefined);
    const from = ALL_LOGS.length;
    await eventually(async () => (ALL_LOGS.some((l) => String(l.msg) === `file_storage_inconsistent file=${id} reason=digest_mismatch`) ? true : undefined));
    await t.app.get(FileOpsReporter).report();
    const lines = ALL_LOGS.slice(from);
    expect(lines.some((l) => String(l.msg).includes('integrity_digest_mismatch=1'))).toBe(true);
    const incident = lines.find((l) => String(l.msg).startsWith('file_integrity_incident '));
    expect(incident?.level).toBe('error');
    expect(String(incident?.msg)).not.toContain(key);
  });

  it('service-token rotation (the kit\'s two tokens per caller): both resolve to the SAME caller; removing the old one refuses it', async () => {
    const next = generateServiceToken();
    const both = await app({}, { tokens: [{ caller: 'core-drive', digest: drive.digest }, { caller: 'core-drive', digest: next.digest }] });
    const id = await upload(both, SAMPLES.pdf(1_500));
    const viaNew = await request(both.app.getHttpServer()).get(`/file/files/${id}`).set(auth(next));
    expect([viaNew.status, viaNew.body.id]).toEqual([200, id]); // the file of the old token's caller: one identity, one policy
    const rotated = await app({}, { tokens: [{ caller: 'core-drive', digest: next.digest }] });
    expect((await request(rotated.app.getHttpServer()).get(`/file/files/${id}`).set(auth(next))).status).toBe(200);
    expect((await request(rotated.app.getHttpServer()).get(`/file/files/${id}`).set(auth(drive))).status).toBe(401);
  });

  it('request-hash key rotation: a replay accepted under the old key still replays during the window; after it, 422 (never a second file)', async () => {
    const oldKey = TEST_UPLOAD_ENV.FILE_REQUEST_HASH_KEY;
    const newKey = Buffer.alloc(32, 11).toString('base64');
    const before = await app();
    const key = randomUUID();
    const bytes = SAMPLES.pdf(1_200);
    const first = await request(before.app.getHttpServer()).post('/file/files').set({ ...auth(), 'idempotency-key': key }).send(bytes);
    expect(first.status).toBe(201);
    const during = await app({ FILE_REQUEST_HASH_KEY: newKey, FILE_REQUEST_HASH_PREVIOUS_KEYS: oldKey });
    const replay = await request(during.app.getHttpServer()).post('/file/files').set({ ...auth(), 'idempotency-key': key }).send(bytes);
    expect([replay.status, replay.body.id]).toEqual([200, first.body.id]);
    const after = await app({ FILE_REQUEST_HASH_KEY: newKey });
    const late = await request(after.app.getHttpServer()).post('/file/files').set({ ...auth(), 'idempotency-key': key }).send(bytes);
    expect([late.status, late.body.code]).toEqual([422, 'idempotency_key_reused']);
    expect(Number(((await s.query(`SELECT count(*) AS n FROM file WHERE "idempotencyKey" = $1`, [key]))[0] as { n: string }).n)).toBe(1);
  });
  /** `n` DELETING rows due now, owned by `owner` (their objects do not exist: an idempotent delete succeeds on a reachable store). */
  async function deletingBacklog(owner: string, n: number): Promise<void> {
    await s.query(`INSERT INTO file (id, "ownerService", "storageProvider", "storageKey", "createdAt", "uploadExpiresAt", "attachDeadline", "attachedAt")
      SELECT g.id, $1, 'filesystem', 'files/' || g.id || '/' || md5(g.id::text), now() - interval '2 days', now() - interval '47 hours', now() + interval '1 day', now()
      FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, $2)) g`, [owner, n]);
    await s.query(`UPDATE file SET status = 'AVAILABLE', "mediaType" = 'application/pdf', "sizeBytes" = 3, sha256 = repeat('e', 64), "availableAt" = now() WHERE "ownerService" = $1`, [owner]);
    await s.query(`UPDATE file SET status = 'DELETING', "deletionRequestedAt" = now(), "deleteNextAttemptAt" = now() WHERE "ownerService" = $1`, [owner]);
  }
  const deletedCount = async (owner: string) => Number(((await s.query(`SELECT count(*) AS n FROM file WHERE "ownerService" = $1 AND status = 'DELETED'`, [owner]))[0] as { n: string }).n);

  it('cleanup drain mode: a pass repeats full batches (bounded by FILE_CLEANUP_MAX_BATCHES_PER_PASS); one batch per pass was the old ceiling', async () => {
    await s.query(`UPDATE file SET "deleteNextAttemptAt" = now() + interval '1 day' WHERE status = 'DELETING'`); // earlier cases' rows are not due
    await deletingBacklog('ops-drain-a', 70);
    const drained = await app({ FILE_CLEANUP_BATCH_SIZE: '20', FILE_CLEANUP_MAX_BATCHES_PER_PASS: '10' });
    const pass = await drained.app.get(CleanupWorker).runOnce();
    expect(pass.deleted).toBe(70); // 20 + 20 + 20 + 10: the partial batch ends the drain
    await deletingBacklog('ops-drain-b', 70);
    const single = await app({ FILE_CLEANUP_BATCH_SIZE: '20', FILE_CLEANUP_MAX_BATCHES_PER_PASS: '1' });
    expect((await single.app.get(CleanupWorker).runOnce()).deleted).toBe(20);
    expect(await deletedCount('ops-drain-b')).toBe(20);
  });

  it('cleanup drain mode never multiplies a storage outage: with the store unreachable one pass tries ONE batch, then stops', async () => {
    await s.query(`UPDATE file SET "deleteNextAttemptAt" = now() + interval '1 day' WHERE status = 'DELETING'`);
    await deletingBacklog('ops-drain-down', 70);
    const down = await app({
      FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: 'http://127.0.0.1:1', FILE_S3_REGION: 'us-east-1', FILE_S3_BUCKET: 'unreachable-bucket',
      FILE_S3_FORCE_PATH_STYLE: 'true', FILE_S3_ACCESS_KEY_ID: 'ops-test', FILE_S3_SECRET_ACCESS_KEY: 'ops-test-secret-0000',
      FILE_CLEANUP_BATCH_SIZE: '20', FILE_CLEANUP_MAX_BATCHES_PER_PASS: '10',
    });
    const pass = await down.app.get(CleanupWorker).runOnce();
    expect([pass.deleted, pass.retried]).toEqual([0, 20]);
    const rescheduled = Number(((await s.query(`SELECT count(*) AS n FROM file WHERE "ownerService" = 'ops-drain-down' AND "deleteLastError" = 'storage_unavailable'`))[0] as { n: string }).n);
    expect(rescheduled).toBe(20);
    await request(down.app.getHttpServer()).get('/ready').expect(200);
  });
  it('an upload into a store that stops READING ends as a storage failure at the store\'s idle bound, never blamed on the client', async () => {
    // A store that takes the first 256 KiB of a PUT and then neither reads nor answers.
    const stalled: HttpServer = createHttpServer((req) => {
      let seen = 0;
      req.on('data', (c: Buffer) => {
        seen += c.length;
        if (seen > 256 * 1024) req.pause();
      });
    });
    const sockets = new Set<import('node:net').Socket>();
    stalled.on('connection', (sk) => sockets.add(sk));
    await new Promise<void>((r) => stalled.listen(0, '127.0.0.1', r));
    try {
      const t = await app({
        FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: `http://127.0.0.1:${(stalled.address() as AddressInfo).port}`, FILE_S3_REGION: 'us-east-1',
        FILE_S3_BUCKET: 'stalled-bucket', FILE_S3_FORCE_PATH_STYLE: 'true', FILE_S3_ACCESS_KEY_ID: 'ops-test', FILE_S3_SECRET_ACCESS_KEY: 'ops-test-secret-0000',
        FILE_UPLOAD_IDLE_TIMEOUT_MS: '1000', FILE_DOWNLOAD_IDLE_TIMEOUT_MS: '1000', FILE_STORAGE_IDLE_TIMEOUT_MS: '3000',
      });
      const body = SAMPLES.pdf(8 * 1024 * 1024);
      const started = Date.now();
      const r = await rawRequest(t.app, { method: 'POST', path: '/file/files', headers: { ...auth(), 'idempotency-key': randomUUID(), 'content-type': 'application/pdf', 'content-length': String(body.length) }, body });
      const ms = Date.now() - started;
      expect(r === 'socket_closed' ? r : [r.status, r.json().code]).toEqual([503, 'storage_unavailable']);
      expect(ms).toBeGreaterThanOrEqual(2_500); // the client's 1 s idle timer did NOT fire although the socket went quiet
      // The store's idle bound (3 s), far from the whole-transfer deadline (~138 s); the object cleanup after a timeout runs in the
      // background (awaited, it would add up to the 10 s request deadline against the same stalled store).
      expect(ms).toBeLessThan(9_000);
      const line = await eventually(async () => t.logs.map((l) => String(l.msg)).find((m) => m.startsWith('file_upload route=service outcome=')));
      expect(line).toMatch(/outcome=storage_timeout/);
      expect(t.logs.some((l) => String(l.msg).includes('outcome=upload_timeout'))).toBe(false);
    } finally {
      for (const sk of sockets) sk.destroy();
      await new Promise((r) => stalled.close(r));
    }
  }, 60_000);
  it('Stage 17.10: while the store holds an upload back, the idle re-arm keeps ONE timeout listener (it used to double every idle period)', async () => {
    // Measured before the fix with these bounds: 64 listeners on one request after a 3 s stall, 8 388 608 after 14 s.
    let max = 0;
    const original = Object.getOwnPropertyDescriptor(IncomingMessage.prototype, 'setTimeout')!.value as IncomingMessage['setTimeout'];
    IncomingMessage.prototype.setTimeout = function (this: IncomingMessage, ...args: Parameters<typeof original>) {
      const r = original.apply(this, args);
      max = Math.max(max, this.listenerCount('timeout'));
      return r;
    } as typeof original;
    const stalled: HttpServer = createHttpServer((req) => {
      let seen = 0;
      req.on('data', (c: Buffer) => {
        seen += c.length;
        if (seen > 256 * 1024) req.pause();
      });
    });
    const sockets = new Set<import('node:net').Socket>();
    stalled.on('connection', (sk) => sockets.add(sk));
    await new Promise<void>((r) => stalled.listen(0, '127.0.0.1', r));
    try {
      const t = await app({
        FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: `http://127.0.0.1:${(stalled.address() as AddressInfo).port}`, FILE_S3_REGION: 'us-east-1',
        FILE_S3_BUCKET: 'stalled-bucket', FILE_S3_FORCE_PATH_STYLE: 'true', FILE_S3_ACCESS_KEY_ID: 'ops-test', FILE_S3_SECRET_ACCESS_KEY: 'ops-test-secret-0000',
        FILE_UPLOAD_IDLE_TIMEOUT_MS: '1000', FILE_DOWNLOAD_IDLE_TIMEOUT_MS: '1000', FILE_STORAGE_IDLE_TIMEOUT_MS: '6000',
      });
      const body = SAMPLES.pdf(8 * 1024 * 1024);
      const r = await rawRequest(t.app, { method: 'POST', path: '/file/files', headers: { ...auth(), 'idempotency-key': randomUUID(), 'content-type': 'application/pdf', 'content-length': String(body.length) }, body });
      expect(r === 'socket_closed' ? r : [r.status, r.json().code]).toEqual([503, 'storage_unavailable']);
      expect(max).toBe(1); // five idle periods passed with bytes waiting unread: still the one listener
    } finally {
      IncomingMessage.prototype.setTimeout = original;
      for (const sk of sockets) sk.destroy();
      await new Promise((r) => stalled.close(r));
    }
  }, 60_000);
  it('a store slower than the upload idle bound AFTER the client sent everything: 201 (the idle bound is the client\'s, never the store\'s)', async () => {
    // Takes the whole PUT body, then answers 2 s later: slower than the 1 s upload idle bound, within the store's own 3 s bound.
    const slow: HttpServer = createHttpServer((req, res) => {
      req.resume();
      req.on('end', () => setTimeout(() => {
        res.writeHead(200, { etag: '"x"' });
        res.end();
      }, 2_000));
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    try {
      const t = await app({
        FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: `http://127.0.0.1:${(slow.address() as AddressInfo).port}`, FILE_S3_REGION: 'us-east-1',
        FILE_S3_BUCKET: 'slow-bucket', FILE_S3_FORCE_PATH_STYLE: 'true', FILE_S3_ACCESS_KEY_ID: 'ops-test', FILE_S3_SECRET_ACCESS_KEY: 'ops-test-secret-0000',
        FILE_UPLOAD_IDLE_TIMEOUT_MS: '1000', FILE_DOWNLOAD_IDLE_TIMEOUT_MS: '1000', FILE_STORAGE_IDLE_TIMEOUT_MS: '3000',
      });
      const body = SAMPLES.pdf(64 * 1024);
      const r = await rawRequest(t.app, { method: 'POST', path: '/file/files', headers: { ...auth(), 'idempotency-key': randomUUID(), 'content-type': 'application/pdf', 'content-length': String(body.length) }, body });
      expect(r === 'socket_closed' ? r : r.status).toBe(201); // before 17.9: the socket was destroyed 1 s after the last client byte, no answer
    } finally {
      slow.closeAllConnections();
      await new Promise((r) => slow.close(r));
    }
  }, 30_000);
});
