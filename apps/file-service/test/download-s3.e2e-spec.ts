import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { Sql } from './support/fixtures.js';
import { SAMPLES } from './support/media.js';
import { TEST_S3_VARS, withTestBucket, type TestS3Env } from './support/s3.js';
import { liveBytes } from './support/storage-contract.js';
import { DOWNLOAD_POLICY } from './support/download.js';

/**
 * Stage 17.6: the byte-read boundary on the S3-compatible adapter (a real S3 protocol server; CI: VersityGW): byte-exact service and
 * ticket downloads, bounded memory, a client abort that stops the S3 stream, a missing object, a storage outage without readiness loss.
 */
describeWithEnv('download on the S3-compatible store (real PostgreSQL + S3 protocol server)', ['TEST_DATABASE_ADMIN_URL', ...TEST_S3_VARS], (raw) => {
  const env = raw as unknown as TestS3Env & { TEST_DATABASE_ADMIN_URL: string };
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  let bucket: Awaited<ReturnType<typeof withTestBucket>>;
  const drive = generateServiceToken();
  const tokens = [{ caller: 'core-drive', digest: drive.digest }];
  const policy = JSON.stringify({ callers: { 'core-drive': DOWNLOAD_POLICY.callers['core-drive'] } });
  const s3Env = (endpoint: string) => ({
    FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: endpoint, FILE_S3_REGION: 'us-east-1', FILE_S3_BUCKET: bucket.bucket, FILE_S3_FORCE_PATH_STYLE: 'true',
    FILE_S3_ACCESS_KEY_ID: env.TEST_S3_ACCESS_KEY_ID, FILE_S3_SECRET_ACCESS_KEY: env.TEST_S3_SECRET_ACCESS_KEY,
  });
  const auth = { authorization: `Bearer ${drive.token}` };
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'filedownloads3');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    bucket = await withTestBucket(env);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy, env: s3Env(env.TEST_S3_ENDPOINT) });
    await t.app.listen(0, '127.0.0.1');
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await bucket?.drop();
    await db?.drop();
  });

  const upload = async (bytes: Buffer) => {
    const r = await request(t.app.getHttpServer()).post('/file/files').set({ ...auth, 'idempotency-key': randomUUID() }).send(bytes);
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const ticketPath = async (id: string) => new URL((await request(t.app.getHttpServer()).post(`/file/files/${id}/tickets`).set(auth).send({ operation: 'download' })).body.url as string).pathname;
  function fetchAll(app: TestApp, path: string, abortAfterFirstChunk = false) {
    const port = (app.app.getHttpServer().address() as AddressInfo).port;
    return new Promise<{ status: number; bytes: number; sha256: string }>((resolve) => {
      const h = createHash('sha256');
      let bytes = 0;
      let settled = false;
      const req = httpGet({ host: '127.0.0.1', port, path, headers: path.startsWith('/file/files') ? auth : {} }, (res) => {
        const done = () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, bytes, sha256: h.digest('hex') });
        };
        res.on('data', (c: Buffer) => {
          h.update(c);
          bytes += c.length;
          if (abortAfterFirstChunk) req.destroy();
        });
        res.on('end', done);
        res.on('close', done);
      });
      req.on('error', () => undefined);
    });
  }

  it('service content and a ticket both stream the object byte for byte from the bucket', async () => {
    const pdf = SAMPLES.pdf(2 * 1024 * 1024);
    const id = await upload(pdf);
    expect(await fetchAll(t, `/file/files/${id}/content`)).toEqual({ status: 200, bytes: pdf.length, sha256: sha(pdf) });
    expect(await fetchAll(t, await ticketPath(id))).toEqual({ status: 200, bytes: pdf.length, sha256: sha(pdf) });
  });

  it('a 16 MiB download from S3: a paused client holds the S3 stream back (bounded live memory, not the file)', async () => {
    const body = Buffer.concat([SAMPLES.pdf(), randomBytes(16 * 1024 * 1024)]);
    const id = await upload(body);
    const path = await ticketPath(id);
    const port = (t.app.getHttpServer().address() as AddressInfo).port;
    const before = await liveBytes();
    const result = await new Promise<{ level: number; growth: number; sha256: string }>((resolve) => {
      const h = createHash('sha256');
      let level = 0;
      let growth = 0;
      let first = true;
      httpGet({ host: '127.0.0.1', port, path }, (res) => {
        res.on('data', (c: Buffer) => {
          h.update(c);
          if (!first) return;
          first = false;
          res.pause();
          void (async () => {
            const atPause = await liveBytes();
            await new Promise((r) => setTimeout(r, 500));
            growth = (await liveBytes()) - atPause;
            level = atPause - before;
            res.resume();
          })();
        });
        res.on('end', () => resolve({ level, growth, sha256: h.digest('hex') }));
      });
    });
    expect(result.sha256).toBe(sha(body));
    expect(result.growth).toBeLessThan(2 * 1024 * 1024);
    expect(result.level).toBeLessThan(8 * 1024 * 1024);
  }, 120_000);

  it('a client abort stops the S3 stream (the object is not read on in the background)', async () => {
    const body = Buffer.concat([SAMPLES.pdf(), randomBytes(8 * 1024 * 1024)]);
    const id = await upload(body);
    const before = ALL_LOGS.length;
    await fetchAll(t, await ticketPath(id), true);
    let line: string | undefined;
    for (let i = 0; i < 100 && !line; i++) {
      line = ALL_LOGS.slice(before).map((x) => String(x.msg)).find((m) => m.startsWith(`file_download route=ticket outcome=aborted file=${id}`));
      if (!line) await new Promise((r) => setTimeout(r, 20));
    }
    expect(line).toBeDefined();
    expect(Number(/bytes=(\d+)/.exec(line!)![1])).toBeLessThan(body.length / 2);
  });

  it('an object missing from the bucket is 500 file_content_missing (no provider detail)', async () => {
    const id = await upload(SAMPLES.pdf(1000));
    const key = ((await s.query('SELECT "storageKey" FROM file WHERE id = $1', [id]))[0] as { storageKey: string }).storageKey;
    await bucket.admin.send(new DeleteObjectCommand({ Bucket: bucket.bucket, Key: key }));
    const r = await request(t.app.getHttpServer()).get(`/file/files/${id}/content`).set(auth);
    expect([r.status, r.body.code]).toEqual([500, 'file_content_missing']);
    expect(JSON.stringify(r.body)).not.toMatch(/NoSuchKey|bucket|127\.0\.0\.1|file-test-/i);
  });

  it('Stage 17.8 tampering in the bucket (same key): same size, other bytes → the response never completes; other size → 500', async () => {
    const pdf = SAMPLES.pdf(400_000);
    const id = await upload(pdf);
    const key = ((await s.query('SELECT "storageKey" FROM file WHERE id = $1', [id]))[0] as { storageKey: string }).storageKey;
    const forged = Buffer.from(pdf);
    forged[forged.length - 1] = forged[forged.length - 1]! ^ 0x01; // one bit, at the very end
    await bucket.admin.send(new PutObjectCommand({ Bucket: bucket.bucket, Key: key, Body: forged }));
    const before = ALL_LOGS.length;
    const r = await fetchAll(t, `/file/files/${id}/content`);
    expect(r.status).toBe(200);
    expect(r.bytes).toBeLessThan(pdf.length); // the last chunk is held back and never released
    let line: string | undefined;
    for (let i = 0; i < 100 && !line; i++) {
      line = ALL_LOGS.slice(before).map((x) => String(x.msg)).find((m) => m === `file_storage_inconsistent file=${id} reason=digest_mismatch`);
      if (!line) await new Promise((res) => setTimeout(res, 20));
    }
    expect(line).toBeDefined();
    await bucket.admin.send(new PutObjectCommand({ Bucket: bucket.bucket, Key: key, Body: Buffer.concat([pdf, Buffer.from('x')]) }));
    const longer = await request(t.app.getHttpServer()).get(`/file/files/${id}/content`).set(auth);
    expect([longer.status, longer.body.code]).toEqual([500, 'file_content_missing']);
  });

  it('a storage outage: 503 storage_unavailable for the download, /ready stays 200', async () => {
    const id = await upload(SAMPLES.pdf(1000));
    const down = await createTestApp({ databaseUrl: db.url, tokens, policy, env: s3Env('http://127.0.0.1:1') });
    try {
      await request(down.app.getHttpServer()).get('/ready').expect(200);
      const r = await request(down.app.getHttpServer()).get(`/file/files/${id}/content`).set(auth);
      expect([r.status, r.body.code]).toEqual([503, 'storage_unavailable']);
      expect(JSON.stringify(r.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|s3/i);
      await request(down.app.getHttpServer()).get('/ready').expect(200);
    } finally {
      await down.app.close();
    }
  });
});
