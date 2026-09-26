import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { DbService, RateLimitService, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { QUERY_WINDOW_SECONDS } from '../src/query/query.service.js';
import { RateLimitJanitor } from '../src/query/rate-limit-janitor.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Stage 18.8 (18.6 finding F3): the query limiter's state is bounded. Real PostgreSQL 16, the runtime role, the kit limiter itself.
 * The property that matters: a purge can never let a caller make a request its limit would refuse.
 */
describeWithEnv('query rate-limit state purge (real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let db: DbService;
  let limiter: RateLimitService;
  let janitor: RateLimitJanitor;
  const rule = { limit: 3, windowSec: QUERY_WINDOW_SECONDS };
  const rows = async (bucket?: string) =>
    (await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM kit_rate_limit ${bucket ? 'WHERE bucket = $1' : ''}`, bucket ? [bucket] : []))[0]!.n;
  /** Ages every row of a bucket past its window (a fixture: what the clock would do in QUERY_WINDOW_SECONDS). */
  const age = (bucket: string, seconds = QUERY_WINDOW_SECONDS + 1) =>
    sql(d.adminUrl, `UPDATE kit_rate_limit SET "windowStart" = "windowStart" - make_interval(secs => $2) WHERE bucket = $1`, [bucket, seconds]);

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'arl');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    db = new DbService({ url: d.appUrl, applicationName: 'janitor-test', max: 4 });
    limiter = new RateLimitService(db);
    janitor = new RateLimitJanitor(db);
  });
  beforeEach(async () => {
    await sql(d.adminUrl, 'TRUNCATE kit_rate_limit');
  });
  afterAll(async () => {
    await db?.onApplicationShutdown();
    await d?.drop();
  });

  it('without a purge the (caller, organization) state grows with every organization read; one pass removes every expired window, in bounded batches', async () => {
    for (let i = 0; i < 1200; i++) await limiter.hit('audit_query_org_pair', `reader|org-${i}`, rule);
    expect(await rows('audit_query_org_pair')).toBe(1200);
    await age('audit_query_org_pair');
    expect(await janitor.purgeBatch(500)).toBe(500); // one statement never removes more than its batch
    expect(await janitor.pass()).toBe(700);
    expect(await rows()).toBe(0);
  });

  it('a window that has NOT ended is never removed: a caller at its limit stays refused after a purge', async () => {
    for (let i = 0; i < 3; i++) expect((await limiter.hit('audit_query_org_caller', 'reader', rule)).allowed).toBe(true);
    expect((await limiter.hit('audit_query_org_caller', 'reader', rule)).allowed).toBe(false);
    await age('audit_query_org_caller', QUERY_WINDOW_SECONDS - 5); // almost over, not over
    expect(await janitor.pass()).toBe(0);
    expect((await limiter.hit('audit_query_org_caller', 'reader', rule)).allowed).toBe(false); // still limited
  });

  it('removing an ENDED window changes nothing the limiter decides (the next hit starts a new window at 1 either way)', async () => {
    for (let i = 0; i < 4; i++) await limiter.hit('audit_query_platform_caller', 'platform', rule);
    await age('audit_query_platform_caller');
    const without = await limiter.peek('audit_query_platform_caller', 'platform', rule);
    await janitor.pass();
    const withPurge = await limiter.peek('audit_query_platform_caller', 'platform', rule);
    expect(withPurge).toEqual(without);
    expect((await limiter.hit('audit_query_platform_caller', 'platform', rule)).count).toBe(1);
  });

  it('touches ONLY audit-service\'s own buckets, and never a row being hit concurrently', async () => {
    await sql(d.adminUrl, `INSERT INTO kit_rate_limit(bucket, key, "windowStart", count) VALUES ('another_limiter', 'k', now() - interval '1 day', 9)`);
    for (let i = 0; i < 50; i++) await limiter.hit('audit_query_org_pair', `reader|org-${i}`, rule);
    await age('audit_query_org_pair');
    const [purged] = await Promise.all([janitor.pass(), ...Array.from({ length: 20 }, (_, i) => limiter.hit('audit_query_org_pair', `reader|org-${i}`, rule))]);
    expect(purged).toBeLessThanOrEqual(50);
    expect(await rows('another_limiter')).toBe(1);
    // Every hit that raced the purge is in a fresh window with its own count (never lost, never reset below what it recorded).
    for (let i = 0; i < 20; i++) expect((await limiter.peek('audit_query_org_pair', `reader|org-${i}`, rule)).count).toBe(1);
  });

  it('the table stores digests, never the caller or the organization', async () => {
    await limiter.hit('audit_query_org_pair', 'reader|3c1d9b0e-2a4f-4b8e-8f6a-5d7e9c0b1a22', rule);
    expect(JSON.stringify(await sql(d.adminUrl, 'SELECT * FROM kit_rate_limit'))).not.toMatch(/reader|3c1d9b0e/);
  });
});
