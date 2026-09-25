import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../../src/app.module.js';
import { describeWithEnv } from '../support/env.js';
import { withTestBucket, type TestS3Env } from '../support/s3.js';
import { auth, fmt, measure, MiB, pct, pdf, report, send, startService, type Service } from './support.js';

/**
 * Stage 17.9 probe: uploads under concurrency (1 … over the per-process bound) on both adapters, the ticket invariant under overload
 * (503 upload_busy never consumes a ticket; a retry succeeds), and database pool pressure (a small pool under a burst of
 * database-only requests: waiting, then failing after DB_CONNECTION_TIMEOUT_MS).
 */
const LIMITS = {
  FILE_DOWNLOAD_RATE_PER_CALLER: '1000000', FILE_DOWNLOAD_RATE_PER_ORGANIZATION: '1000000', FILE_UPLOAD_RATE_PER_CALLER: '1000000',
  FILE_UPLOAD_RATE_PER_ORGANIZATION: '1000000', FILE_TICKET_RATE_PER_CALLER: '1000000', FILE_TICKET_RATE_PER_ORGANIZATION: '1000000',
};
const LEVELS = (process.env.OPS_UPLOAD_CONCURRENCY ?? '1,16,64,80').split(',').map(Number);
const SIZES = (process.env.OPS_UPLOAD_SIZES ?? '1048576,25165824').split(',').map(Number);

describeWithEnv('ops probe: uploads and database pool', ['TEST_DATABASE_ADMIN_URL'], (raw) => {
  const env = { ...(process.env as unknown as Partial<TestS3Env>), ...(raw as unknown as { TEST_DATABASE_ADMIN_URL: string }) };
  let db: TestDatabase;
  let sessions: pg.Client;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileopsup');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    sessions = new pg.Client({ connectionString: db.url });
    await sessions.connect();
  });
  afterAll(async () => {
    await sessions?.end();
    await db?.drop();
  });

  async function withService<T>(adapter: string, extra: Record<string, string>, fn: (svc: Service) => Promise<T>): Promise<T> {
    let storageEnv: Record<string, string>;
    let cleanup: () => Promise<void>;
    if (adapter === 's3') {
      const b = await withTestBucket(env as TestS3Env);
      storageEnv = {
        FILE_STORAGE_PROVIDER: 's3', FILE_S3_ENDPOINT: env.TEST_S3_ENDPOINT!, FILE_S3_REGION: 'us-east-1', FILE_S3_BUCKET: b.bucket, FILE_S3_FORCE_PATH_STYLE: 'true',
        FILE_S3_ACCESS_KEY_ID: env.TEST_S3_ACCESS_KEY_ID!, FILE_S3_SECRET_ACCESS_KEY: env.TEST_S3_SECRET_ACCESS_KEY!,
      };
      cleanup = () => b.drop();
    } else {
      const root = mkdtempSync(join(tmpdir(), 'file-ops-up-'));
      storageEnv = { FILE_STORAGE_PROVIDER: 'filesystem', FILE_STORAGE_ROOT: root };
      cleanup = async () => rmSync(root, { recursive: true, force: true });
    }
    const svc = await startService({ DATABASE_URL: db.url, ...LIMITS, ...storageEnv, ...extra });
    try {
      return await fn(svc);
    } finally {
      await svc.stop();
      await cleanup();
    }
  }

  const busySessions = async () => (await sessions.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'file-service' AND state <> 'idle'`)).rows[0]!.n;

  for (const adapter of ['filesystem', 's3']) {
    it(`${adapter}: uploads at ${LEVELS.join(' / ')} concurrent (default bound 64)`, async (ctx) => {
      if (adapter === 's3' && !env.TEST_S3_ENDPOINT) return ctx.skip();
      await withService(adapter, {}, async (svc) => {
        for (const size of SIZES) {
          const body = pdf(size);
          for (const c of LEVELS) {
            const statuses: Record<string, number> = {};
            const latencies: number[] = [];
            let peakBusy = 0;
            let watching = true;
            const watcher = (async () => {
              while (watching) {
                peakBusy = Math.max(peakBusy, await busySessions());
                await new Promise((r) => setTimeout(r, 20));
              }
            })();
            const m = await measure(svc, () => Promise.all(Array.from({ length: c }, async () => {
              const r = await send(`${svc.base}/file/files`, 'POST', { ...auth, 'idempotency-key': randomUUID(), 'content-type': 'application/pdf' }, body);
              const k = r.status === 201 ? '201' : `${r.status}:${typeof r.json.code === 'string' ? r.json.code : ''}`;
              statuses[k] = (statuses[k] ?? 0) + 1;
              latencies.push(r.ms);
            })));
            watching = false;
            await watcher;
            const ok = statuses[201] ?? 0;
            report(
              `upload adapter=${adapter} size=${size} conc=${c} statuses=${JSON.stringify(statuses)} wall_s=${fmt(m.wallMs / 1000, 2)} MiB_s=${fmt((ok * size) / MiB / (m.wallMs / 1000), 0)}`
              + ` p50_ms=${fmt(pct(latencies, 50))} p95_ms=${fmt(pct(latencies, 95))} cpu_s=${fmt(m.cpuSec, 2)} cores=${fmt(m.cpuSec / (m.wallMs / 1000), 2)}`
              + ` rss_growth_MiB=${fmt((m.rssPeak - m.rssStart) / MiB, 0)} fds_peak=${m.fdsPeak} db_busy_peak=${peakBusy} health_p95_ms=${fmt(pct(m.healthMs, 95))}`,
            );
            const outcomes: Record<string, number> = {};
            for (const l of svc.lines().splice(0)) {
              const o = /file_upload route=service outcome=([a-z_]+)/.exec(l)?.[1] ?? /storage_op op=put provider=\w+ outcome=([a-z_]+)[^"]*?(detail=[A-Za-z_]+)?"/.exec(l)?.slice(1).join(' ');
              if (o) outcomes[o] = (outcomes[o] ?? 0) + 1;
            }
            report(`upload_outcomes adapter=${adapter} size=${size} conc=${c} server=${JSON.stringify(outcomes)}`);
            for (const s of Object.keys(statuses)) expect(['201', '503:upload_busy']).toContain(s);
          }
        }
      });
    });
  }

  it('s3: overload never consumes a ticket — 24 concurrent redemptions against a bound of 4, then retries: 24 files, each ticket used once', async (ctx) => {
    if (!env.TEST_S3_ENDPOINT) return ctx.skip();
    await withService('s3', { FILE_UPLOAD_MAX_IN_FLIGHT: '4' }, async (svc) => {
      const urls: string[] = [];
      for (let i = 0; i < 24; i++) {
        const r = await send(`${svc.base}/file/uploads/tickets`, 'POST', { ...auth, 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ maxBytes: 10 * MiB, mediaTypes: ['application/pdf'] })));
        urls.push(String(r.json.url));
      }
      const body = pdf(8 * MiB);
      let busy = 0;
      let attempts = 0;
      const created = await Promise.all(urls.map(async (url) => {
        for (;;) {
          attempts += 1;
          const r = await send(url, 'PUT', { 'content-type': 'application/pdf' }, body);
          if (r.status === 503 && r.json.code === 'upload_busy') {
            busy += 1;
            await new Promise((res) => setTimeout(res, 50 + Math.random() * 100));
            continue;
          }
          return r.status;
        }
      }));
      const used = (await sessions.query<{ n: number; files: number }>(`SELECT count(*) FILTER (WHERE "usedAt" IS NOT NULL)::int AS n, count("fileId")::int AS files FROM file_access_ticket WHERE operation = 'upload'`)).rows[0]!;
      report(`upload_overload bound=4 tickets=24 attempts=${attempts} busy_503=${busy} created_201=${created.filter((s) => s === 201).length} tickets_used=${used.n} files_bound=${used.files}`);
      expect(created.every((s) => s === 201)).toBe(true);
      expect(used.n).toBe(24);
    });
  });

  it('database pool pressure: a burst of database-only requests on a pool of 10 (default) and on a pool of 2 with a 1 s wait bound', async () => {
    for (const [pool, wait] of [['10', '5000'], ['2', '1000']] as const) {
      await withService('filesystem', { DB_POOL_MAX: pool, DB_CONNECTION_TIMEOUT_MS: wait, DB_STATEMENT_TIMEOUT_MS: '30000' }, async (svc) => {
        const up = await send(`${svc.base}/file/files`, 'POST', { ...auth, 'idempotency-key': randomUUID(), 'content-type': 'application/pdf', 'x-attach': 'true' }, pdf(2_000));
        const id = String(up.json.id);
        // 400 metadata reads at once, while 20 slow statements occupy the pool from the outside... not possible from outside the process:
        // instead the burst itself saturates a small pool; a lock held by the probe makes each read wait on the database.
        const locker = new pg.Client({ connectionString: db.url });
        await locker.connect();
        await locker.query('BEGIN');
        await locker.query(`LOCK TABLE kit_rate_limit IN ACCESS EXCLUSIVE MODE`); // the service-content reads charge the limiter first
        const burst = Promise.all(Array.from({ length: 50 }, async () => {
          const t = performance.now();
          const r = await fetch(`${svc.base}/file/files/${id}/content`, { headers: auth });
          await r.arrayBuffer();
          return { status: r.status, ms: performance.now() - t };
        }));
        await new Promise((r) => setTimeout(r, 3_000)); // the pool is exhausted and requests queue behind the lock
        const health = await fetch(`${svc.base}/health`);
        const ready = await fetch(`${svc.base}/ready`);
        await locker.query('ROLLBACK');
        await locker.end();
        const rs = await burst;
        const statuses: Record<number, number> = {};
        for (const r of rs) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        const errors = svc.lines().filter((l) => /timeout exceeded when trying to connect|db_/.test(l)).length;
        report(`db_pool pool=${pool} wait_ms=${wait} burst=50 statuses=${JSON.stringify(statuses)} p95_ms=${fmt(pct(rs.map((r) => r.ms), 95), 0)} health_during=${health.status} ready_during=${ready.status} pool_error_lines=${errors}`);
      });
    }
  });
});
