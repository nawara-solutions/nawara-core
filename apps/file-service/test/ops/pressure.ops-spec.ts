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
import { auth, fmt, get, MiB, pdf, procStats, report, send, sleep, startService, type Service } from './support.js';

/**
 * Stage 17.9 probe: pressure on the byte path. Slow and paused readers (what they hold: sockets, storage streams, memory, database
 * sessions), the S3 client's socket pool under held downloads (do other storage operations still get through?), repeated client
 * disconnects (are descriptors and streams released?), and a memory plateau under sustained traffic (leak or lazy GC?).
 */
const HELD = Number(process.env.OPS_HELD ?? 60);
const LIMITS = {
  FILE_DOWNLOAD_RATE_PER_CALLER: '1000000', FILE_DOWNLOAD_RATE_PER_ORGANIZATION: '1000000', FILE_UPLOAD_RATE_PER_CALLER: '1000000',
  FILE_UPLOAD_RATE_PER_ORGANIZATION: '1000000', FILE_TICKET_RATE_PER_CALLER: '1000000', FILE_TICKET_RATE_PER_ORGANIZATION: '1000000',
};

describeWithEnv('ops probe: byte-path pressure', ['TEST_DATABASE_ADMIN_URL'], (raw) => {
  const env = { ...(process.env as unknown as Partial<TestS3Env>), ...(raw as unknown as { TEST_DATABASE_ADMIN_URL: string }) };
  let db: TestDatabase;
  let sessions: pg.Client;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileopspr');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    sessions = new pg.Client({ connectionString: db.url });
    await sessions.connect();
  });
  afterAll(async () => {
    await sessions?.end();
    await db?.drop();
  });

  const dbSessions = async () => (await sessions.query<{ total: number; busy: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE state <> 'idle')::int AS busy FROM pg_stat_activity WHERE application_name = 'file-service'`)).rows[0]!;

  async function withService<T>(adapter: 'filesystem' | 's3', extra: Record<string, string>, fn: (svc: Service) => Promise<T>): Promise<T> {
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
      const root = mkdtempSync(join(tmpdir(), 'file-ops-'));
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

  const uploadOne = async (svc: Service, size: number) => {
    const r = await send(`${svc.base}/file/files`, 'POST', { ...auth, 'idempotency-key': randomUUID(), 'content-type': 'application/pdf', 'x-attach': 'true' }, pdf(size));
    return r;
  };

  for (const adapter of ['filesystem', 's3'] as const) {
    it(`${adapter}: ${HELD} paused readers — what they hold, and whether other storage work still gets through`, async (ctx) => {
      if (adapter === 's3' && !env.TEST_S3_ENDPOINT) return ctx.skip();
      await withService(adapter, { FILE_DOWNLOAD_IDLE_TIMEOUT_MS: '60000' }, async (svc) => {
        const up = await uploadOne(svc, 24 * MiB);
        expect(up.status).toBe(201);
        const url = `${svc.base}/file/files/${String(up.json.id)}/content`;
        const idle = procStats(svc.pid);
        const held = Array.from({ length: HELD }, () => get(url, auth, { pauseMs: 20_000 }));
        await sleep(3_000);
        const during = procStats(svc.pid);
        const s = await dbSessions();
        // Other work while the readers hold their streams: a small upload, a small download, metadata.
        const t0 = performance.now();
        const small = await uploadOne(svc, 64 * 1024);
        const upMs = performance.now() - t0;
        const t1 = performance.now();
        const dl = small.status === 201 ? await get(`${svc.base}/file/files/${String(small.json.id)}/content`, auth) : { status: 0, bytes: 0, complete: false };
        const dlMs = performance.now() - t1;
        const meta = small.status === 201 ? await fetch(`${svc.base}/file/files/${String(small.json.id)}`, { headers: auth }) : { status: 0 };
        report(
          `pressure adapter=${adapter} held=${HELD} rss_growth_MiB=${fmt((during.rss - idle.rss) / MiB, 0)} fds_idle=${idle.fds} fds_held=${during.fds}`
          + ` db_sessions_total=${s.total} db_sessions_busy=${s.busy} upload_status=${small.status} upload_ms=${fmt(upMs, 0)}`
          + ` small_download_status=${dl.status} small_download_ms=${fmt(dlMs, 0)} metadata_status=${meta.status}`,
        );
        const results = await Promise.all(held);
        const complete = results.filter((r) => r.complete && r.bytes === 24 * MiB).length;
        report(`pressure adapter=${adapter} held_completed=${complete}/${HELD} held_status=${[...new Set(results.map((r) => r.status))].join('/')}`);
        expect(s.busy).toBe(0); // no database session is busy while bytes wait on clients
      });
    });

    it(`${adapter}: 300 client disconnects mid-download release every stream and descriptor`, async (ctx) => {
      if (adapter === 's3' && !env.TEST_S3_ENDPOINT) return ctx.skip();
      await withService(adapter, {}, async (svc) => {
        const up = await uploadOne(svc, 8 * MiB);
        const url = `${svc.base}/file/files/${String(up.json.id)}/content`;
        // Warm up to the steady state first (the database pool and the store's keep-alive sockets open on demand), so the comparison
        // below sees only what the disconnects leave behind.
        await Promise.all(Array.from({ length: 50 }, () => get(url, auth)));
        await sleep(1_000);
        const before = procStats(svc.pid);
        for (let wave = 0; wave < 6; wave++) await Promise.all(Array.from({ length: 50 }, () => get(url, auth, { abortAfterFirstChunk: true })));
        await sleep(2_000);
        const after = procStats(svc.pid);
        const aborted = svc.lines().filter((l) => l.includes('file_download route=service outcome=aborted')).length;
        // After the storm the service still serves 50 concurrent full downloads (no leaked socket-pool slot or stream).
        const full = await Promise.all(Array.from({ length: 50 }, () => get(url, auth)));
        report(
          `disconnect adapter=${adapter} aborts=300 logged_aborted=${aborted} fds_before=${before.fds} fds_after=${after.fds}`
          + ` rss_before_MiB=${fmt(before.rss / MiB, 0)} rss_after_MiB=${fmt(after.rss / MiB, 0)} then_50_full_ok=${full.filter((r) => r.complete).length}`,
        );
        expect(after.fds).toBeLessThanOrEqual(before.fds + 5);
        expect(full.every((r) => r.complete && r.bytes === 8 * MiB)).toBe(true);
      });
    });
  }

  it('filesystem: memory plateaus under sustained small downloads (lazy collection, not a leak)', async () => {
    await withService('filesystem', {}, async (svc) => {
      const up = await uploadOne(svc, 64 * 1024);
      const url = `${svc.base}/file/files/${String(up.json.id)}/content`;
      const samples: number[] = [];
      for (let wave = 0; wave < 12; wave++) {
        await Promise.all(Array.from({ length: 25 }, async () => {
          for (let i = 0; i < 40; i++) await get(url, auth);
        }));
        samples.push(procStats(svc.pid).rss);
      }
      report(`plateau adapter=filesystem downloads=12000 rss_MiB_per_1000=${samples.map((b) => fmt(b / MiB, 0)).join(',')}`);
      // The last third may not keep growing like the first: a leak grows linearly with the request count.
      const growthFirst = samples[3]! - samples[0]!;
      const growthLast = samples[11]! - samples[8]!;
      expect(growthLast).toBeLessThan(Math.max(growthFirst, 64 * MiB));
    });
  });
});
