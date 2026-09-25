import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../../src/app.module.js';
import { describeWithEnv } from '../support/env.js';
import { fmt, procStats, report, sleep, startService } from './support.js';

/**
 * Stage 17.9 probe: cleanup backlog. Seeds N rows in every category the workers own (DELETING files whose objects are already gone,
 * abandoned uploads, expired temporary files, expired tickets, expired limiter windows), runs the BUILT service with its workers on a
 * short interval, and reports how many passes and seconds each category needs to drain, rows per pass, and the database sessions used.
 * With `OPS_CLEANUP_ENV` (JSON) other worker settings can be compared.
 */
const N = Number(process.env.OPS_BACKLOG ?? 400);
const INTERVAL_MS = Number(process.env.OPS_CLEANUP_INTERVAL_MS ?? 1000);
const EXTRA = JSON.parse(process.env.OPS_CLEANUP_ENV ?? '{}') as Record<string, string>;
const TIMEOUT_S = Number(process.env.OPS_BACKLOG_TIMEOUT_S ?? 240);

describeWithEnv('ops probe: cleanup backlog', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let c: pg.Client;
  let root: string;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileopsbl');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    c = new pg.Client({ connectionString: db.url });
    await c.connect();
    root = mkdtempSync(join(tmpdir(), 'file-ops-bl-'));
  });
  afterAll(async () => {
    await c?.end();
    await db?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  async function seed(): Promise<void> {
    const ids = (owner: string) => `SELECT gen_random_uuid() AS id, '${owner}' AS owner FROM generate_series(1, ${N})`;
    const insert = (owner: string, created: string, lease: string, deadline: string, attached: string) =>
      c.query(`INSERT INTO file (id, "ownerService", "storageProvider", "storageKey", "createdAt", "uploadExpiresAt", "attachDeadline", "attachedAt")
               SELECT g.id, g.owner, 'filesystem', 'files/' || g.id || '/' || md5(g.id::text), now() - interval '${created}', now() + interval '${lease}',
                      now() + interval '${deadline}', ${attached} FROM (${ids(owner)}) g`);
    const available = (owner: string) => c.query(`UPDATE file SET status = 'AVAILABLE', "mediaType" = 'application/pdf', "sizeBytes" = 3, sha256 = repeat('d', 64),
                                                   "availableAt" = now() WHERE "ownerService" = $1`, [owner]);
    await insert('ops-deleting', '2 days', '-47 hours', '1 day', 'now()');
    await available('ops-deleting');
    await c.query(`UPDATE file SET status = 'DELETING', "deletionRequestedAt" = now(), "deleteNextAttemptAt" = now() WHERE "ownerService" = 'ops-deleting'`);
    await insert('ops-abandoned', '2 hours', '-60 seconds', '1 day', 'NULL');
    await insert('ops-temporary', '2 days', '-47 hours', '-1 hour', 'NULL');
    await available('ops-temporary');
    await c.query(`INSERT INTO file_access_ticket (id, operation, "issuedBy", "tokenDigest", "maxBytes", "mediaTypes", attach, "singleUse", "createdAt", "expiresAt")
                   SELECT gen_random_uuid(), 'upload', 'ops-tickets', md5(random()::text) || md5(random()::text), 1000, ARRAY['application/pdf'], false, true,
                          now() - interval '3 days', now() - interval '3 days' + interval '120 seconds' FROM generate_series(1, ${N})`);
    await c.query(`INSERT INTO kit_rate_limit (bucket, key, "windowStart", count)
                   SELECT 'file_ticket_failures', md5(random()::text) || md5(g::text), now() - interval '2 hours', 1 FROM generate_series(1, ${N}) g`);
  }

  async function remaining(): Promise<Record<string, number>> {
    const r = await c.query<Record<string, number>>(`SELECT
        (SELECT count(*) FROM file WHERE "ownerService" = 'ops-deleting' AND status <> 'DELETED')::int AS deleting,
        (SELECT count(*) FROM file WHERE "ownerService" = 'ops-abandoned' AND status = 'UPLOADING')::int AS abandoned,
        (SELECT count(*) FROM file WHERE "ownerService" = 'ops-temporary' AND status <> 'DELETED')::int AS temporary,
        (SELECT count(*) FROM file_access_ticket WHERE "issuedBy" = 'ops-tickets')::int AS tickets,
        (SELECT count(*) FROM kit_rate_limit WHERE bucket = 'file_ticket_failures')::int AS limiter`);
    return r.rows[0]!;
  }

  it(`drains ${N} rows per category (interval ${INTERVAL_MS} ms)`, async () => {
    await seed();
    const svc = await startService({
      DATABASE_URL: db.url, FILE_STORAGE_PROVIDER: 'filesystem', FILE_STORAGE_ROOT: root, FILE_CLEANUP_ENABLED: 'true',
      FILE_CLEANUP_INTERVAL_MS: String(INTERVAL_MS), FILE_OPS_REPORT_INTERVAL_MS: '10000', ...EXTRA,
    });
    const drainedAt: Record<string, number> = {};
    let peakSessions = 0;
    const t0 = Date.now();
    const cpu0 = procStats(svc.pid).cpuSec;
    try {
      while (Object.keys(drainedAt).length < 5 && Date.now() - t0 < TIMEOUT_S * 1000) {
        const left = await remaining();
        for (const [k, v] of Object.entries(left)) if (v === 0 && drainedAt[k] === undefined) drainedAt[k] = Date.now() - t0;
        peakSessions = Math.max(peakSessions, (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'file-service' AND state <> 'idle'`)).rows[0]!.n);
        await sleep(250);
      }
      const left = await remaining();
      const cpu = procStats(svc.pid).cpuSec - cpu0;
      const passes = svc.lines().filter((l) => l.includes('file_cleanup_pass ')).length;
      const cells = ['deleting', 'abandoned', 'temporary', 'tickets', 'limiter'].map((k) => {
        const ms = drainedAt[k];
        return ms === undefined ? `${k}=not_drained(left=${left[k]})` : `${k}=${fmt(ms / 1000, 1)}s(${fmt(N / Math.max(1, ms / INTERVAL_MS), 0)}/pass)`;
      });
      report(`backlog n=${N} interval_ms=${INTERVAL_MS} env=${JSON.stringify(EXTRA)} ${cells.join(' ')} passes_logged=${passes} cpu_s=${fmt(cpu, 2)} db_busy_peak=${peakSessions}`);
      const snapshot = svc.lines().filter((l) => l.includes('file_ops_snapshot')).slice(-1)[0];
      if (snapshot) report(`backlog last_snapshot ${JSON.parse(snapshot).msg}`);
    } finally {
      await svc.stop();
    }
    expect(peakSessions).toBeLessThanOrEqual(10);
  });
});
