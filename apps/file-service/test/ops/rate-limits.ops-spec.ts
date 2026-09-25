import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../../src/app.module.js';
import { describeWithEnv } from '../support/env.js';
import { CALLER, fmt, OPS_POLICY, report, send, sleep, startService } from './support.js';

/**
 * Stage 17.9 probe: the F32 budgets under heavy concurrency (same caller, same organization, several organizations, platform files,
 * two callers) must admit EXACTLY their budget; and the limiter table under many distinct clients (5 000 keyed addresses through
 * TRUST_PROXY): bounded growth, expired windows purged by the cleanup pass in bounded batches, keys not reversible to addresses.
 */
describeWithEnv('ops probe: rate limits', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let c: pg.Client;
  let root: string;
  const second = generateServiceToken();

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileopsrl');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    c = new pg.Client({ connectionString: db.url });
    await c.connect();
    root = mkdtempSync(join(tmpdir(), 'file-ops-rl-'));
  });
  afterAll(async () => {
    await c?.end();
    await db?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  it('budgets are exact under 400 concurrent issuances across organizations, platform files and two callers', async () => {
    const policy = JSON.parse(OPS_POLICY) as { callers: Record<string, unknown> };
    policy.callers['ops-second'] = policy.callers['ops-probe'];
    const svc = await startService({
      DATABASE_URL: db.url, FILE_STORAGE_PROVIDER: 'filesystem', FILE_STORAGE_ROOT: root,
      SERVICE_TOKENS: `ops-probe:${CALLER.digest},ops-second:${second.digest}`, FILE_SERVICE_POLICY: JSON.stringify(policy),
      FILE_TICKET_RATE_PER_CALLER: '100', FILE_TICKET_RATE_PER_ORGANIZATION: '40', DB_POOL_MAX: '20',
    });
    try {
      const orgs = Array.from({ length: 5 }, () => crypto.randomUUID());
      const issue = (who: { token: string }, org: string | null) => send(`${svc.base}/file/uploads/tickets`, 'POST', { authorization: `Bearer ${who.token}`, 'content-type': 'application/json' },
        Buffer.from(JSON.stringify({ maxBytes: 1000, mediaTypes: ['application/pdf'], ...(org ? { organizationId: org } : {}) })));
      // 80 per organization (twice its budget) for 5 organizations, 40 platform, all from ONE caller; 60 platform from the second caller.
      const jobs: { who: string; org: string; p: Promise<{ status: number }> }[] = [];
      for (let i = 0; i < 80; i++) for (const o of orgs) jobs.push({ who: 'first', org: o, p: issue(CALLER, o) });
      for (let i = 0; i < 40; i++) jobs.push({ who: 'first', org: 'platform', p: issue(CALLER, null) });
      for (let i = 0; i < 60; i++) jobs.push({ who: 'second', org: 'platform', p: issue(second, null) });
      const done = await Promise.all(jobs.map(async (j) => ({ ...j, status: (await j.p).status })));
      const ok = (f: (j: (typeof done)[number]) => boolean) => done.filter((j) => f(j) && j.status === 201).length;
      const perOrg = orgs.map((o) => ok((j) => j.org === o));
      const first = ok((j) => j.who === 'first');
      const secondOk = ok((j) => j.who === 'second');
      const other = done.filter((j) => j.status !== 201 && j.status !== 429).length;
      report(`ratelimit_concurrency requests=${done.length} first_caller_ok=${first} (budget 100) per_org_ok=${perOrg.join('/')} (each ≤ 40) second_caller_ok=${secondOk} (budget 100, sent 60) other_statuses=${other}`);
      expect(first).toBe(100); // the caller budget, exactly: no overshoot from races
      for (const n of perOrg) expect(n).toBeLessThanOrEqual(40);
      expect(secondOk).toBe(60); // another caller is untouched by the first one's exhaustion
      expect(other).toBe(0);
    } finally {
      await svc.stop();
    }
  });

  it('5 000 distinct clients failing redemptions: bounded rows, keyed (not reversible), purged in bounded batches once expired', async () => {
    await c.query('DELETE FROM kit_rate_limit');
    const svc = await startService({
      DATABASE_URL: db.url, FILE_STORAGE_PROVIDER: 'filesystem', FILE_STORAGE_ROOT: root, TRUST_PROXY: 'true',
      FILE_CLEANUP_ENABLED: 'true', FILE_CLEANUP_INTERVAL_MS: '1000', FILE_CLEANUP_PURGE_BATCH_SIZE: '500', FILE_CLEANUP_MAX_BATCHES_PER_PASS: '4',
    });
    try {
      const clients = Array.from({ length: 5_000 }, (_, i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
      const t0 = performance.now();
      const statuses: Record<string, number> = {};
      for (let i = 0; i < clients.length; i += 100) {
        await Promise.all(clients.slice(i, i + 100).map(async (ip) => {
          const r = await fetch(`${svc.base}/file/t/${randomBytes(32).toString('base64url')}`, { headers: { 'x-forwarded-for': ip } }).then((x) => String(x.status), (e: unknown) => `error:${(e as Error).message}`);
          statuses[r] = (statuses[r] ?? 0) + 1;
        }));
      }
      const sendMs = performance.now() - t0;
      const rows = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM kit_rate_limit WHERE bucket = 'file_ticket_failures'`)).rows[0]!.n;
      const keys = new Set((await c.query<{ key: string }>(`SELECT key FROM kit_rate_limit`)).rows.map((r) => r.key));
      const reversible = clients.filter((ip) => keys.has(createHash('sha256').update(`file_ticket_failures:${ip}`).digest('hex'))).length;
      const plan = (await c.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT bucket, key FROM kit_rate_limit WHERE bucket = ANY(ARRAY['file_ticket_failures']) AND "windowStart" <= now() - interval '60 seconds' LIMIT 500`)).rows.map((r) => r['QUERY PLAN']).join(' | ');
      // Age every window past its end (as 61 s of waiting would), then let the cleanup passes purge.
      await c.query(`UPDATE kit_rate_limit SET "windowStart" = now() - interval '61 seconds'`);
      const t1 = Date.now();
      let left = rows;
      while (left > 0 && Date.now() - t1 < 60_000) {
        await sleep(250);
        left = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM kit_rate_limit WHERE bucket = 'file_ticket_failures'`)).rows[0]!.n;
      }
      const passes = svc.lines().filter((l) => l.includes('limits_purged=')).map((l) => Number(/limits_purged=(\d+)/.exec(l)?.[1] ?? 0));
      report(`ratelimit_growth clients=5000 statuses=${JSON.stringify(statuses)} send_s=${fmt(sendMs / 1000, 1)} rows=${rows} reversible_keys=${reversible} purge_s=${fmt((Date.now() - t1) / 1000, 1)} left=${left} per_pass=${passes.join(',')} plan=${plan.slice(0, 120)}`);
      expect(rows).toBe(5_000); // one row per keyed client: growth is bounded by distinct clients per window
      expect(reversible).toBe(0);
      expect(left).toBe(0);
      expect(Math.max(...passes)).toBeLessThanOrEqual(2_000); // purge batch 500 × 4 batches per pass
    } finally {
      await svc.stop();
    }
  });
});
