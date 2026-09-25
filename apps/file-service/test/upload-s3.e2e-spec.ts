import { createHash, randomUUID } from 'node:crypto';
import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { Sql } from './support/fixtures.js';
import { ADVERSARIAL, SAMPLES } from './support/media.js';
import { TEST_S3_VARS, withTestBucket, type TestS3Env } from './support/s3.js';
import { UPLOAD_POLICY } from './support/upload.js';

/**
 * Stage 17.5: the upload lifecycle on the S3-compatible adapter (a real S3 protocol server, CI: VersityGW): the same outcomes as on the
 * filesystem store, and a storage outage that fails uploads (503) without touching readiness.
 */
describeWithEnv('upload lifecycle on the S3-compatible store (real PostgreSQL + S3 protocol server)', ['TEST_DATABASE_ADMIN_URL', ...TEST_S3_VARS], (raw) => {
  const env = raw as unknown as TestS3Env & { TEST_DATABASE_ADMIN_URL: string };
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  let bucket: Awaited<ReturnType<typeof withTestBucket>>;
  const drive = generateServiceToken();
  const tokens = [{ caller: 'core-drive', digest: drive.digest }];
  const policy = JSON.stringify({ callers: { 'core-drive': UPLOAD_POLICY.callers['core-drive'] } });
  const s3Env = (endpoint: string, bucketName: string) => ({
    FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: endpoint, FILE_S3_REGION: 'us-east-1', FILE_S3_BUCKET: bucketName, FILE_S3_FORCE_PATH_STYLE: 'true',
    FILE_S3_ACCESS_KEY_ID: env.TEST_S3_ACCESS_KEY_ID, FILE_S3_SECRET_ACCESS_KEY: env.TEST_S3_SECRET_ACCESS_KEY,
  });
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileuploads3');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    bucket = await withTestBucket(env);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy, env: s3Env(env.TEST_S3_ENDPOINT, bucket.bucket) });
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await bucket?.drop();
    await db?.drop();
  });

  const ticket = async (app: TestApp) => {
    const r = await request(app.app.getHttpServer()).post('/file/uploads/tickets').set({ authorization: `Bearer ${drive.token}` }).send({ maxBytes: 5 * 1024 * 1024, mediaTypes: ['application/pdf', 'image/png'] });
    return (r.body.url as string).split('/file/t/')[1]!;
  };

  it('a redeemed upload lands in the bucket byte for byte; the row records provider s3 and the exact digest', async () => {
    const pdf = SAMPLES.pdf(1024 * 1024);
    const r = await request(t.app.getHttpServer()).put(`/file/t/${await ticket(t)}`).send(pdf);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'AVAILABLE', mediaType: 'application/pdf', sizeBytes: pdf.length, sha256: sha(pdf) });
    const row = (await s.query('SELECT "storageProvider", "storageKey" FROM file WHERE id = $1', [r.body.id]))[0] as { storageProvider: string; storageKey: string };
    expect(row.storageProvider).toBe('s3');
    const head = await bucket.admin.send(new HeadObjectCommand({ Bucket: bucket.bucket, Key: row.storageKey }));
    expect(head.ContentLength).toBe(pdf.length);
    expect(head.ContentType).toBe('application/pdf');
  });

  it('Stage 17.8 concurrency on S3: 10 redemptions of one ticket create ONE file and ONE object; 10 concurrent downloads are byte-exact', async () => {
    const token = await ticket(t);
    const pdf = SAMPLES.pdf(300_000);
    const rs = await Promise.all(Array.from({ length: 10 }, () => request(t.app.getHttpServer()).put(`/file/t/${token}`).send(pdf).then((r) => r)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of rs) expect([200, 201, 409]).toContain(r.status); // the winner, retries of the completed upload, or "in progress"
    const id = rs.find((r) => r.status === 201)!.body.id as string;
    expect(Number(((await s.query(`SELECT count(*) AS n FROM file WHERE "ownerService" = 'core-drive' AND id IN (SELECT "fileId" FROM file_access_ticket WHERE "tokenDigest" = $1)`, [sha(Buffer.from(token))]))[0] as { n: string }).n)).toBe(1);
    const listed = await bucket.admin.send(new ListObjectsV2Command({ Bucket: bucket.bucket, Prefix: `files/${id}/` }));
    expect(listed.KeyCount).toBe(1);
    const url = (await request(t.app.getHttpServer()).post(`/file/files/${id}/tickets`).set({ authorization: `Bearer ${drive.token}` }).send({ operation: 'download' })).body.url as string;
    const downloads = await Promise.all(Array.from({ length: 10 }, () => request(t.app.getHttpServer()).get(new URL(url).pathname).buffer(true).parse((res, cb) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => cb(null, Buffer.concat(parts)));
    }).then((r) => r)));
    for (const d of downloads) expect([d.status, sha(d.body as Buffer)]).toEqual([200, sha(pdf)]);
  });

  it('a refused upload leaves no object in the bucket', async () => {
    const token = await ticket(t);
    const r = await request(t.app.getHttpServer()).put(`/file/t/${token}`).set({ 'x-file-name': 'passport.pdf' }).send(ADVERSARIAL.windowsExe());
    expect(r.body.code).toBe('unsupported_media_type');
    const row = (await s.query(`SELECT f."storageKey", f.status FROM file f JOIN file_access_ticket t ON t."fileId" = f.id WHERE t."tokenDigest" = $1`, [sha(Buffer.from(token))]))[0] as { storageKey: string; status: string };
    expect(row.status).toBe('REJECTED');
    await expect(bucket.admin.send(new HeadObjectCommand({ Bucket: bucket.bucket, Key: row.storageKey }))).rejects.toMatchObject({ name: 'NotFound' });
  });

  it('a service-upload replay does not store the bytes twice (one object for one key)', async () => {
    const key = `s3-${randomUUID()}`;
    const png = SAMPLES.png(4096);
    const send = () => request(t.app.getHttpServer()).post('/file/files').set({ authorization: `Bearer ${drive.token}`, 'idempotency-key': key }).send(png);
    const first = await send();
    const second = await send();
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body.id).toBe(first.body.id);
  });

  it('a storage outage fails the upload with 503 storage_unavailable (the file FAILED, the ticket spent); /ready stays 200', async () => {
    const down = await createTestApp({ databaseUrl: db.url, tokens, policy, env: s3Env('http://127.0.0.1:1', bucket.bucket) });
    try {
      await request(down.app.getHttpServer()).get('/ready').expect(200);
      const token = await ticket(down);
      const r = await request(down.app.getHttpServer()).put(`/file/t/${token}`).send(SAMPLES.pdf(10_000));
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ code: 'storage_unavailable', message: 'File storage is temporarily unavailable.' });
      expect(JSON.stringify(r.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|bucket|s3/i);
      const row = (await s.query(`SELECT f.status, f."failureCode" FROM file f JOIN file_access_ticket t ON t."fileId" = f.id WHERE t."tokenDigest" = $1`, [sha(Buffer.from(token))]))[0];
      expect(row).toEqual({ status: 'FAILED', failureCode: 'storage_unavailable' });
      expect((await request(down.app.getHttpServer()).put(`/file/t/${token}`).send(SAMPLES.pdf())).body.code).toBe('ticket_invalid'); // spent
      await request(down.app.getHttpServer()).get('/ready').expect(200);
      await request(down.app.getHttpServer()).get('/health').expect(200);
    } finally {
      await down.app.close();
    }
  });
});
