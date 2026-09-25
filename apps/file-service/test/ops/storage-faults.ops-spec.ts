import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../../src/app.module.js';
import { describeWithEnv } from '../support/env.js';
import { withTestBucket, type TestS3Env } from '../support/s3.js';
import { auth, FaultProxy, fmt, get, MiB, pdf, report, send, sleep, startService, type Service } from './support.js';

/**
 * Stage 17.9 probe: storage latency, a full outage (refused and hanging), and recovery, on the S3 adapter through a fault proxy.
 * Checks what the operator must be able to rely on: bounded failures with normalized codes, /ready independent of storage, no database
 * transaction held across storage I/O, deleted files stay inaccessible, deletions retry and converge without a restart.
 */
describeWithEnv('ops probe: storage latency, outage and recovery', ['TEST_DATABASE_ADMIN_URL'], (raw) => {
  const env = { ...(process.env as unknown as Partial<TestS3Env>), ...(raw as unknown as { TEST_DATABASE_ADMIN_URL: string }) };
  let db: TestDatabase;
  let c: pg.Client;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileopssf');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    c = new pg.Client({ connectionString: db.url });
    await c.connect();
  });
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it('latency, outage (refused, hanging), recovery', async (ctx) => {
    if (!env.TEST_S3_ENDPOINT) return ctx.skip();
    const target = new URL(env.TEST_S3_ENDPOINT);
    const proxy = new FaultProxy({ host: target.hostname, port: Number(target.port) });
    await proxy.start();
    const b = await withTestBucket(env as TestS3Env);
    const svc: Service = await startService({
      DATABASE_URL: db.url, FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: `http://127.0.0.1:${proxy.port}`, FILE_S3_REGION: 'us-east-1',
      FILE_S3_BUCKET: b.bucket, FILE_S3_FORCE_PATH_STYLE: 'true', FILE_S3_ACCESS_KEY_ID: env.TEST_S3_ACCESS_KEY_ID!, FILE_S3_SECRET_ACCESS_KEY: env.TEST_S3_SECRET_ACCESS_KEY!,
      FILE_STORAGE_REQUEST_TIMEOUT_MS: '2000', FILE_STORAGE_IDLE_TIMEOUT_MS: '3000', FILE_STORAGE_CONNECT_TIMEOUT_MS: '1000',
      FILE_UPLOAD_IDLE_TIMEOUT_MS: '1000', FILE_DOWNLOAD_IDLE_TIMEOUT_MS: '2000', // below the store's idle bound (the 17.9 relationship)
      FILE_CLEANUP_ENABLED: 'true', FILE_CLEANUP_INTERVAL_MS: '1000', FILE_DELETE_RETRY_BASE_SECONDS: '1', FILE_DELETE_RETRY_MAX_SECONDS: '2',
      FILE_DELETE_LEASE_SECONDS: '60', FILE_OPS_REPORT_INTERVAL_MS: '10000',
    });
    const idleInTx = async () => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'file-service' AND state LIKE 'idle in transaction%'`)).rows[0]!.n;
    const up = (size = MiB) => send(`${svc.base}/file/files`, 'POST', { ...auth, 'idempotency-key': randomUUID(), 'content-type': 'application/pdf', 'x-attach': 'true' }, pdf(size));
    const ready = async () => (await fetch(`${svc.base}/ready`)).status;
    const status = async (id: string) => (await c.query<{ status: string; e: string | null; a: number }>(`SELECT status, "deleteLastError" AS e, "deleteAttempts" AS a FROM file WHERE id = $1`, [id])).rows[0]!;
    try {
      // 1. Latency: every relayed chunk delayed.
      for (const d of [0, 50, 200]) {
        proxy.mode = 'normal';
        proxy.delayMs = d;
        const u = await up();
        const dl = await get(`${svc.base}/file/files/${String(u.json.id)}/content`, auth);
        const t = performance.now();
        const del = await fetch(`${svc.base}/file/files/${String(u.json.id)}`, { method: 'DELETE', headers: auth });
        const delMs = performance.now() - t;
        report(`storage_latency delay_ms=${d} upload=${u.status}/${fmt(u.ms, 0)}ms download=${dl.status}/${fmt(dl.ms, 0)}ms delete_request=${del.status}/${fmt(delMs, 0)}ms ready=${await ready()}`);
      }
      proxy.delayMs = 0;
      const keep = await up(); // a file that must survive the outage
      const doomed = await up(); // deleted during the outage
      // 2. Outage, refused connections.
      proxy.mode = 'refuse';
      proxy.cut();
      const u2 = await up();
      const d2 = await get(`${svc.base}/file/files/${String(keep.json.id)}/content`, auth, { keepBody: true });
      const del = await fetch(`${svc.base}/file/files/${String(doomed.json.id)}`, { method: 'DELETE', headers: auth });
      await sleep(4_000); // several worker passes
      const doomedDuring = await status(String(doomed.json.id));
      const afterDelete = await fetch(`${svc.base}/file/files/${String(doomed.json.id)}/content`, { headers: auth });
      report(`storage_outage mode=refuse upload=${u2.status}:${String(u2.json.code)}/${fmt(u2.ms, 0)}ms download=${d2.status}/${fmt(d2.ms, 0)}ms delete_request=${del.status}`
        + ` worker_row=${doomedDuring.status}:${doomedDuring.e}:attempts=${doomedDuring.a} deleted_file_read=${afterDelete.status} metadata=${(await fetch(`${svc.base}/file/files/${String(keep.json.id)}`, { headers: auth })).status} ready=${await ready()}`);
      expect(u2.status).toBe(503);
      expect(d2.status).toBe(503);
      expect(del.status).toBe(202);
      expect(doomedDuring.status).toBe('DELETING');
      expect(afterDelete.status).toBe(410);
      expect(await ready()).toBe(200);
      // 3. Outage, a store that accepts and never answers (the worst case: only deadlines end it).
      proxy.mode = 'hang';
      proxy.cut();
      const u3p = up(4 * MiB);
      const d3p = get(`${svc.base}/file/files/${String(keep.json.id)}/content`, auth, { keepBody: true });
      await sleep(1_000);
      const txDuring = await idleInTx();
      const readyDuring = await ready();
      const [u3, d3] = await Promise.all([u3p, d3p]);
      report(`storage_outage mode=hang upload=${u3.status}:${String(u3.json.code)}/${fmt(u3.ms, 0)}ms download=${d3.status}/${fmt(d3.ms, 0)}ms idle_in_transaction_during=${txDuring} ready_during=${readyDuring}`);
      for (const l of svc.lines().filter((x) => /file_upload route=service|storage_op op=put/.test(x)).slice(-3)) report(`storage_outage mode=hang server_line=${String((JSON.parse(l) as { msg: string }).msg)}`);
      expect(txDuring).toBe(0); // no transaction is held open across storage I/O
      expect(readyDuring).toBe(200);
      expect([u3.status, d3.status]).toEqual([503, 503]);
      // 4. Recovery: no restart.
      proxy.mode = 'normal';
      const t0 = Date.now();
      let converged = false;
      while (Date.now() - t0 < 30_000) {
        if ((await status(String(doomed.json.id))).status === 'DELETED') {
          converged = true;
          break;
        }
        await sleep(250);
      }
      const u4 = await up();
      const d4 = await get(`${svc.base}/file/files/${String(keep.json.id)}/content`, auth);
      const final = await status(String(doomed.json.id));
      const retries = svc.lines().filter((l) => l.includes('file_deletion_retry')).length;
      report(`storage_recovery converged=${converged} after_ms=${Date.now() - t0} final_row=${final.status}:attempts=${final.a} retry_lines=${retries} new_upload=${u4.status} download_kept=${d4.status}:${d4.complete}`);
      expect(converged).toBe(true);
      expect(u4.status).toBe(201);
      expect(d4.complete).toBe(true);
      const leaks = svc.lines().filter((l) => l.includes(b.bucket) || l.includes(`127.0.0.1:${proxy.port}`)).length;
      report(`storage_faults log_lines=${svc.lines().length} lines_with_bucket_or_endpoint=${leaks}`);
      expect(leaks).toBe(0);
    } finally {
      await svc.stop();
      await proxy.stop();
      await b.drop();
    }
  });
});
