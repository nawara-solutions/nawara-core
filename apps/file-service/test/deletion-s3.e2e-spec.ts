import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { CleanupWorker } from '../src/cleanup/cleanup.worker.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { DELETE_POLICY } from './support/deletion.js';
import { describeWithEnv } from './support/env.js';
import { Sql } from './support/fixtures.js';
import { SAMPLES } from './support/media.js';
import { TEST_S3_VARS, withTestBucket, type TestS3Env } from './support/s3.js';

/**
 * Stage 17.7: deletion on the S3-compatible adapter (a real S3 protocol server; CI: VersityGW): the object leaves the bucket, an absent
 * object still converges, an outage keeps the file DELETING (inaccessible) and `/ready` 200, and the workers run on their own timer and
 * stop promptly.
 */
describeWithEnv('delete + cleanup on the S3-compatible store (real PostgreSQL + S3 protocol server)', ['TEST_DATABASE_ADMIN_URL', ...TEST_S3_VARS], (raw) => {
  const env = raw as unknown as TestS3Env & { TEST_DATABASE_ADMIN_URL: string };
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  let bucket: Awaited<ReturnType<typeof withTestBucket>>;
  const drive = generateServiceToken();
  const tokens = [{ caller: 'core-drive', digest: drive.digest }];
  const policy = JSON.stringify({ callers: { 'core-drive': DELETE_POLICY.callers['core-drive'] } });
  const s3Env = (endpoint: string) => ({
    FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: endpoint, FILE_S3_REGION: 'us-east-1', FILE_S3_BUCKET: bucket.bucket, FILE_S3_FORCE_PATH_STYLE: 'true',
    FILE_S3_ACCESS_KEY_ID: env.TEST_S3_ACCESS_KEY_ID, FILE_S3_SECRET_ACCESS_KEY: env.TEST_S3_SECRET_ACCESS_KEY,
  });
  const auth = { authorization: `Bearer ${drive.token}` };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'filedeletes3');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    bucket = await withTestBucket(env);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy, env: s3Env(env.TEST_S3_ENDPOINT) });
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await bucket?.drop();
    await db?.drop();
  });

  const upload = async (app = t) => {
    const r = await request(app.app.getHttpServer()).post('/file/files').set({ ...auth, 'idempotency-key': randomUUID(), 'x-attach': 'true' }).send(SAMPLES.pdf(5000));
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const keyOf = async (id: string) => ((await s.query('SELECT "storageKey" FROM file WHERE id = $1', [id]))[0] as { storageKey: string }).storageKey;
  const inBucket = async (id: string) => bucket.admin.send(new HeadObjectCommand({ Bucket: bucket.bucket, Key: await keyOf(id) })).then(() => true, () => false);
  const status = async (id: string) => ((await s.query('SELECT status, "deleteLastError" FROM file WHERE id = $1', [id]))[0] as { status: string; deleteLastError: string | null });
  const dueNow = (id: string) => s.query(`UPDATE file SET "deleteNextAttemptAt" = now() - interval '1 second', "deleteLeaseUntil" = NULL WHERE id = $1`, [id]);

  it('AVAILABLE → DELETING → the object leaves the bucket → DELETED', async () => {
    const id = await upload();
    expect(await inBucket(id)).toBe(true);
    expect((await request(t.app.getHttpServer()).delete(`/file/files/${id}`).set(auth)).status).toBe(202);
    expect(await inBucket(id)).toBe(true); // logical first
    await dueNow(id);
    await t.app.get(CleanupWorker).runOnce();
    expect(await inBucket(id)).toBe(false);
    expect((await status(id)).status).toBe('DELETED');
  });

  it('an object already absent from the bucket still converges to DELETED (idempotent delete)', async () => {
    const id = await upload();
    await request(t.app.getHttpServer()).delete(`/file/files/${id}`).set(auth).expect(202);
    await bucket.admin.send(new DeleteObjectCommand({ Bucket: bucket.bucket, Key: await keyOf(id) }));
    await dueNow(id);
    await t.app.get(CleanupWorker).runOnce();
    expect((await status(id)).status).toBe('DELETED');
  });

  it('a storage outage: the delete request still commits (no storage needed), the worker reschedules, the file stays inaccessible, /ready 200', async () => {
    const id = await upload();
    const down = await createTestApp({ databaseUrl: db.url, tokens, policy, env: s3Env('http://127.0.0.1:1') });
    try {
      expect((await request(down.app.getHttpServer()).delete(`/file/files/${id}`).set(auth)).status).toBe(202);
      await dueNow(id);
      await down.app.get(CleanupWorker).runOnce();
      expect(await status(id)).toEqual({ status: 'DELETING', deleteLastError: 'storage_unavailable' });
      await request(down.app.getHttpServer()).get('/ready').expect(200);
      expect((await request(down.app.getHttpServer()).get(`/file/files/${id}/content`).set(auth)).body.code).toBe('file_deleted');
      // A bounded error class (`detail=ECONNREFUSED`, the 17.4 observer) is fine; the endpoint, host and bucket never appear.
      expect(JSON.stringify(ALL_LOGS)).not.toMatch(/127\.0\.0\.1:1|http:\/\/127|file-test-/);
    } finally {
      await down.app.close();
    }
    await dueNow(id);
    await t.app.get(CleanupWorker).runOnce(); // the store is back (another replica): it converges
    expect((await status(id)).status).toBe('DELETED');
    expect(await inBucket(id)).toBe(false);
  });

  it('the workers run on their own timer (no manual pass) and stop promptly on shutdown', async () => {
    const auto = await createTestApp({ databaseUrl: db.url, tokens, policy, env: { ...s3Env(env.TEST_S3_ENDPOINT), FILE_CLEANUP_ENABLED: 'true', FILE_CLEANUP_INTERVAL_MS: '1000' } });
    const id = await upload(auto);
    await request(auto.app.getHttpServer()).delete(`/file/files/${id}`).set(auth).expect(202);
    let done = false;
    for (let i = 0; i < 60 && !done; i++) {
      done = (await status(id)).status === 'DELETED';
      if (!done) await new Promise((r) => setTimeout(r, 200));
    }
    expect(done).toBe(true);
    const t0 = Date.now();
    await auto.app.close();
    expect(Date.now() - t0).toBeLessThan(6_000);
    // Stopped for good: no pass runs (or fails against the closed pool) after shutdown.
    const after = ALL_LOGS.length;
    await new Promise((r) => setTimeout(r, 2_500));
    expect(ALL_LOGS.slice(after).filter((l) => /file_cleanup_pass/.test(String(l.msg)))).toEqual([]);
  });
});
