import { createHash, randomUUID } from 'node:crypto';
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
import { auth, fmt, get, measure, MiB, pct, pdf, report, send, startService, type Service } from './support.js';

/**
 * Stage 17.9 probe: the cost of download verification (SHA-256 while streaming, Stage 17.8) across object sizes and concurrency, on the
 * filesystem adapter (a low-latency baseline, never a production store) and on the S3-compatible test server (semantics, not a provider
 * benchmark). Reports throughput, latency, server CPU (from /proc), peak memory above the idle baseline, open descriptors, database
 * sessions in use while bytes stream, and /health latency meanwhile. `OPS_ENTRY` may name another build (the measurement-only no-hash
 * variant) to isolate the hashing share. Assertions are resource invariants only, never timings.
 */
const SIZES = (process.env.OPS_SIZES ?? '65536,1048576,25165824').split(',').map(Number);
const LEVELS = (process.env.OPS_CONCURRENCY ?? '1,5,10,25,50').split(',').map(Number);
const ADAPTERS = (process.env.OPS_ADAPTERS ?? 'filesystem,s3').split(',');
const ENTRY = process.env.OPS_ENTRY ?? 'dist/main.js';
const LIMITS = {
  // The probe measures the byte path, not the policy: budgets far above what it sends (documented in the record's methodology).
  FILE_DOWNLOAD_RATE_PER_CALLER: '1000000', FILE_DOWNLOAD_RATE_PER_ORGANIZATION: '1000000',
  FILE_UPLOAD_RATE_PER_CALLER: '1000000', FILE_UPLOAD_RATE_PER_ORGANIZATION: '1000000',
  FILE_TICKET_RATE_PER_CALLER: '1000000', FILE_TICKET_RATE_PER_ORGANIZATION: '1000000',
};

describeWithEnv('ops probe: download verification cost', ['TEST_DATABASE_ADMIN_URL'], (raw) => {
  const env = { ...(process.env as unknown as Partial<TestS3Env>), ...(raw as unknown as { TEST_DATABASE_ADMIN_URL: string }) };
  let db: TestDatabase;
  let sessions: pg.Client;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileopsdl');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    sessions = new pg.Client({ connectionString: db.url });
    await sessions.connect();
    report(`# download cost — entry=${ENTRY} node=${process.version} sizes=${SIZES.join('/')} levels=${LEVELS.join('/')}`);
    // The raw hash rate of this CPU, one core (the floor of what verification can cost per byte).
    const buf = pdf(64 * MiB);
    const t = performance.now();
    const h = createHash('sha256');
    for (let o = 0; o < buf.length; o += 65_536) h.update(buf.subarray(o, o + 65_536));
    h.digest();
    const ms = performance.now() - t;
    report(`sha256_rate_single_core MiB_per_s=${fmt(64 / (ms / 1000), 0)} ms_per_MiB=${fmt(ms / 64, 2)}`);
  });
  afterAll(async () => {
    await sessions?.end();
    await db?.drop();
  });

  /** Sessions of the service that are running a statement right now (a stream holding a connection would show here). */
  async function activeSessions(): Promise<number> {
    const r = await sessions.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'file-service' AND state <> 'idle'`);
    return r.rows[0]!.n;
  }

  for (const adapter of ADAPTERS) {
    it(`${adapter}: sizes × concurrency`, async (ctx) => {
      if (adapter === 's3' && !env.TEST_S3_ENDPOINT) return ctx.skip();
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
      const svc: Service = await startService({ DATABASE_URL: db.url, ...LIMITS, ...storageEnv }, ENTRY);
      try {
        for (const size of SIZES) {
          const up = await send(`${svc.base}/file/files`, 'POST', { ...auth, 'idempotency-key': randomUUID(), 'content-type': 'application/pdf', 'x-attach': 'true' }, pdf(size));
          expect(up.status).toBe(201);
          const id = up.json.id as string;
          const url = `${svc.base}/file/files/${id}/content`;
          await get(url, auth); // warm (JIT, connections)
          for (const c of LEVELS) {
            const rounds = Math.max(1, Math.round(Math.min(200, (256 * MiB) / (size * c))));
            const latencies: number[] = [];
            let failures = 0;
            let peakActive = 0;
            let watching = true;
            const watcher = (async () => {
              while (watching) {
                peakActive = Math.max(peakActive, await activeSessions());
                await new Promise((r) => setTimeout(r, 20));
              }
            })();
            const m = await measure(svc, async () => {
              await Promise.all(Array.from({ length: c }, async () => {
                for (let r = 0; r < rounds; r++) {
                  const res = await get(url, auth);
                  if (res.status !== 200 || !res.complete || res.bytes !== size) failures += 1;
                  latencies.push(res.ms);
                }
              }));
            });
            watching = false;
            await watcher;
            const n = c * rounds;
            const mib = (n * size) / MiB;
            report(
              `dl adapter=${adapter} size=${size} conc=${c} n=${n} wall_s=${fmt(m.wallMs / 1000, 2)} MiB_s=${fmt(mib / (m.wallMs / 1000), 0)}`
              + ` p50_ms=${fmt(pct(latencies, 50))} p95_ms=${fmt(pct(latencies, 95))} cpu_s=${fmt(m.cpuSec, 2)} cores=${fmt(m.cpuSec / (m.wallMs / 1000), 2)}`
              + ` cpu_ms_per_MiB=${fmt((m.cpuSec * 1000) / mib, 2)} rss_start_MiB=${fmt(m.rssStart / MiB, 0)} rss_growth_MiB=${fmt((m.rssPeak - m.rssStart) / MiB, 0)}`
              + ` fds_peak=${m.fdsPeak} db_active_peak=${peakActive} health_p95_ms=${fmt(pct(m.healthMs, 95))} failures=${failures}`,
            );
            expect(failures).toBe(0);
          }
        }
      } finally {
        await svc.stop();
        await cleanup();
      }
    });
  }
});
