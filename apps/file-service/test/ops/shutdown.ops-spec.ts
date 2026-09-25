import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../../src/app.module.js';
import { describeWithEnv } from '../support/env.js';
import { withTestBucket, type TestS3Env } from '../support/s3.js';
import { auth, FaultProxy, get, MiB, pdf, report, send, sleep, startService, type Service } from './support.js';

/**
 * Stage 17.9 probe: graceful shutdown and restart recovery of the BUILT service on the S3 adapter (through a fault proxy). SIGTERM
 * during an upload, a download and a cleanup pass stuck on a hanging store: the process must exit within its bounds; `kill -9` in the
 * middle of claimed deletions: a restart must converge on its own (leases), with tickets and limiter state intact.
 */
describeWithEnv('ops probe: shutdown and restart recovery', ['TEST_DATABASE_ADMIN_URL'], (raw) => {
  const env = { ...(process.env as unknown as Partial<TestS3Env>), ...(raw as unknown as { TEST_DATABASE_ADMIN_URL: string }) };
  let db: TestDatabase;
  let c: pg.Client;
  let proxy: FaultProxy;
  let bucket: Awaited<ReturnType<typeof withTestBucket>>;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileopssd');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    c = new pg.Client({ connectionString: db.url });
    await c.connect();
    if (env.TEST_S3_ENDPOINT) {
      const target = new URL(env.TEST_S3_ENDPOINT);
      proxy = new FaultProxy({ host: target.hostname, port: Number(target.port) });
      await proxy.start();
      bucket = await withTestBucket(env as TestS3Env);
    }
  });
  afterAll(async () => {
    await proxy?.stop();
    await bucket?.drop();
    await c?.end();
    await db?.drop();
  });

  const serviceEnv = (extra: Record<string, string> = {}) => ({
    DATABASE_URL: db.url, FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: `http://127.0.0.1:${proxy.port}`, FILE_S3_REGION: 'us-east-1',
    FILE_S3_BUCKET: bucket.bucket, FILE_S3_FORCE_PATH_STYLE: 'true', FILE_S3_ACCESS_KEY_ID: env.TEST_S3_ACCESS_KEY_ID!, FILE_S3_SECRET_ACCESS_KEY: env.TEST_S3_SECRET_ACCESS_KEY!,
    FILE_CLEANUP_INTERVAL_MS: '1000', FILE_DELETE_LEASE_SECONDS: '30', FILE_STORAGE_REQUEST_TIMEOUT_MS: '1000', FILE_STORAGE_MAX_ATTEMPTS: '1', FILE_DELETE_RETRY_BASE_SECONDS: '1', FILE_DELETE_RETRY_MAX_SECONDS: '2', ...extra,
  });
  const up = (svc: Service, size = 64 * 1024) => send(`${svc.base}/file/files`, 'POST', { ...auth, 'idempotency-key': randomUUID(), 'content-type': 'application/pdf', 'x-attach': 'true' }, pdf(size));

  /** An upload whose body trickles in (`rate` bytes/s): still running when the signal arrives. */
  function slowUpload(svc: Service, size: number, rate: number): Promise<{ status: number | 'closed' }> {
    return new Promise((resolve) => {
      const body = pdf(size);
      const req = httpRequest(`${svc.base}/file/files`, { method: 'POST', agent: false, headers: { ...auth, 'idempotency-key': randomUUID(), 'content-type': 'application/pdf', 'content-length': String(size) } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      });
      req.on('error', () => resolve({ status: 'closed' }));
      let at = 0;
      const tick = setInterval(() => {
        if (at >= size || req.destroyed) return clearInterval(tick);
        const n = Math.min(rate / 10, size - at);
        req.write(body.subarray(at, at + n));
        at += n;
      }, 100);
    });
  }

  it('SIGTERM during an upload, a download and a stuck cleanup pass: bounded exit; nothing is left inconsistent', async (ctx) => {
    if (!env.TEST_S3_ENDPOINT) return ctx.skip();
    for (const scenario of ['upload', 'download', 'cleanup_hanging_store'] as const) {
      proxy.mode = 'normal';
      const svc = await startService(serviceEnv({ FILE_CLEANUP_ENABLED: scenario === 'cleanup_hanging_store' ? 'true' : 'false' }));
      let pending: Promise<unknown> = Promise.resolve();
      let note = '';
      if (scenario === 'upload') {
        pending = slowUpload(svc, 4 * MiB, 256 * 1024); // 16 s of body
        await sleep(1_500);
      } else if (scenario === 'download') {
        const f = await up(svc, 16 * MiB);
        pending = get(`${svc.base}/file/files/${String(f.json.id)}/content`, auth, { pauseMs: 60_000 });
        await sleep(1_500);
      } else {
        for (let i = 0; i < 12; i++) {
          const f = await up(svc);
          await fetch(`${svc.base}/file/files/${String(f.json.id)}`, { method: 'DELETE', headers: auth });
        }
        proxy.mode = 'hang';
        proxy.cut();
        await sleep(2_500); // a pass has claimed rows and is blocked in storage deletes
        note = ` leased_before=${(await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM file WHERE status = 'DELETING' AND "deleteLeaseUntil" > now()`)).rows[0]!.n}`;
      }
      const stop = await svc.stop('SIGTERM');
      const result = await Promise.race([pending, sleep(5_000).then(() => 'still pending')]);
      let after = '';
      if (scenario === 'upload') after = ` uploading_rows=${(await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM file WHERE status = 'UPLOADING'`)).rows[0]!.n}`;
      if (scenario === 'cleanup_hanging_store') after = ` leased_after=${(await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM file WHERE status = 'DELETING' AND "deleteLeaseUntil" > now()`)).rows[0]!.n}`
        + ` interrupted=${svc.lines().filter((l) => l.includes('file_deletion_interrupted')).length}`;
      const drainLines = svc.lines().filter((l) => /drain|shutdown/i.test(l)).length;
      report(`shutdown scenario=${scenario} exit_code=${stop.code} signal=${stop.signal} exit_ms=${stop.ms} client=${JSON.stringify(result)}${note}${after} drain_lines=${drainLines}`);
      expect(stop.ms).toBeLessThan(20_000);
      expect(stop.code === 0 || stop.signal === 'SIGTERM').toBe(true);
    }
  });

  it('kill -9 in the middle of claimed deletions: after a restart, leases expire and the backlog converges; tickets and limiter state survive', async (ctx) => {
    if (!env.TEST_S3_ENDPOINT) return ctx.skip();
    proxy.mode = 'normal';
    const first = await startService(serviceEnv({ FILE_CLEANUP_ENABLED: 'true', FILE_TICKET_RATE_PER_CALLER: '3', FILE_TICKET_RATE_PER_ORGANIZATION: '3' }));
    const keep = await up(first);
    const ticket = await send(`${first.base}/file/files/${String(keep.json.id)}/tickets`, 'POST', { ...auth, 'content-type': 'application/json' }, Buffer.from('{"operation":"download"}'));
    for (let i = 0; i < 3; i++) await send(`${first.base}/file/uploads/tickets`, 'POST', { ...auth, 'content-type': 'application/json' }, Buffer.from('{"maxBytes":1000,"mediaTypes":["application/pdf"]}'));
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const f = await up(first);
      ids.push(String(f.json.id));
    }
    proxy.mode = 'hang';
    proxy.cut();
    for (const id of ids) await fetch(`${first.base}/file/files/${id}`, { method: 'DELETE', headers: auth });
    await sleep(2_500); // claimed and blocked
    const leased = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM file WHERE id = ANY($1::uuid[]) AND "deleteLeaseUntil" > now()`, [ids])).rows[0]!.n;
    first.child.kill('SIGKILL');
    await new Promise((r) => first.child.once('exit', r));
    proxy.mode = 'normal';
    const t0 = Date.now();
    const second = await startService(serviceEnv({ FILE_CLEANUP_ENABLED: 'true', FILE_TICKET_RATE_PER_CALLER: '3', FILE_TICKET_RATE_PER_ORGANIZATION: '3' }));
    try {
      let deleted = 0;
      while (Date.now() - t0 < 90_000) {
        deleted = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM file WHERE id = ANY($1::uuid[]) AND status = 'DELETED'`, [ids])).rows[0]!.n;
        if (deleted === ids.length) break;
        await sleep(500);
      }
      const convergedMs = Date.now() - t0;
      const redeem = await get(new URL(String(ticket.json.url)).pathname.replace(/^/, second.base), {});
      const limited = await send(`${second.base}/file/uploads/tickets`, 'POST', { ...auth, 'content-type': 'application/json' }, Buffer.from('{"maxBytes":1000,"mediaTypes":["application/pdf"]}'));
      report(`restart leased_at_kill=${leased} converged=${deleted}/${ids.length} after_ms=${convergedMs} (lease 30 s) ticket_after_restart=${redeem.status} limiter_after_restart=${limited.status}:${String(limited.json.code)}`);
      expect(deleted).toBe(ids.length);
      expect(redeem.status).toBe(200);
      expect(limited.status).toBe(429); // the budget is database state: a restart does not reset it
    } finally {
      await second.stop();
    }
  }, 180_000);
});
