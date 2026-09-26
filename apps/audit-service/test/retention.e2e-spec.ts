import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DbService, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { runRetention, type RetentionOptions } from '../src/cli/retention-core.js';
import { failure, sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

const CATEGORIES = ['security', 'business', 'commercial', 'administrative'] as const;
type Category = (typeof CATEGORIES)[number];

/**
 * Stage 18.8 (ADR-0049 A41, A45, T14, T23): retention separated from the runtime, on a REAL PostgreSQL 16 with the three REAL roles of
 * `infra/postgres/init` (owner / migrator, runtime, retention). Nothing is purged without an owner-written policy; the runtime can never
 * delete; the retention role deletes only rows past their category's horizon, and cannot read the evidence it purges.
 */
describeWithEnv('audit retention (real PostgreSQL 16, real roles)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  const pools: DbService[] = [];
  const db = (url: string) => {
    const p = new DbService({ url, applicationName: 'retention-test', max: 2, statementTimeoutMs: 60_000 });
    pools.push(p);
    return p;
  };
  const opts = (over: Partial<RetentionOptions> = {}): RetentionOptions => ({ dryRun: false, batchSize: 1000, maxBatches: 100, ...over });

  /** Records stored `ageMinutes` ago: the admin backdates `recordedAt` with the stamp trigger disabled (a fixture only; never possible at runtime). */
  const seed = async (category: Category, ageMinutes: number[]): Promise<string[]> => {
    const ids = ageMinutes.map(() => randomUUID());
    await sql(d.adminUrl, `ALTER TABLE audit_record DISABLE TRIGGER audit_record_stamp`);
    try {
      await sql(d.adminUrl,
        `INSERT INTO audit_record ("eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "resourceType", "resourceId", outcome, "occurredAt", "recordedAt")
         SELECT e, 'billing-service', 'test.retention_case', $2, 1, 'service', 'billing-service', 'invoice', gen_random_uuid()::text, 'succeeded',
                now() - make_interval(mins => m), now() - make_interval(mins => m)
           FROM unnest($1::uuid[], $3::int[]) AS t(e, m)`, [ids, category, ageMinutes]);
    } finally {
      await sql(d.adminUrl, `ALTER TABLE audit_record ENABLE TRIGGER audit_record_stamp`);
    }
    return ids;
  };
  /** The internal id of a record: the only key the retention role may filter on (it can read id, category, recordedAt only). */
  const idOf = async (eventId: string) => (await sql<{ id: string }>(d.adminUrl, `SELECT id::text AS id FROM audit_record WHERE "eventId" = $1`, [eventId]))[0]!.id;
  /** A DELETE the retention role is allowed to ATTEMPT (by id): so a refusal is the TRIGGER's, never a missing column privilege. */
  const triggerRefuses = async (url: string, eventIds: string[]) => {
    const ids = await Promise.all(eventIds.map(idOf));
    const f = await failure(url, `DELETE FROM audit_record WHERE id = ANY($1::bigint[])`, [ids]);
    expect(f.code).toBe('42501');
    expect(f.message).toMatch(/append-only \(DELETE refused\)/); // the trigger, not a privilege error
  };
  const present = async (ids: string[]) => (await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_record WHERE "eventId" = ANY($1::uuid[])`, [ids]))[0]!.n;
  const setPolicy = (category: Category, days: number) =>
    sql(d.migratorUrl, `INSERT INTO audit_retention_policy(category, "retainDays") VALUES ($1, $2) ON CONFLICT (category) DO UPDATE SET "retainDays" = EXCLUDED."retainDays", "setAt" = now()`, [category, days]);
  const ledger = () => sql<{ category: string; deleted: number; retainDays: number; ranBy: string }>(d.adminUrl, `SELECT category, deleted, "retainDays", "ranBy" FROM audit_retention_run ORDER BY id`);
  const DAY = 24 * 60;

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'aret');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    await sql(d.migratorUrl, `SELECT audit_grant_retention($1::regrole)`, [d.retention]);
  });
  afterEach(async () => {
    await sql(d.adminUrl, `TRUNCATE audit_retention_policy`);
    await sql(d.adminUrl, `ALTER TABLE audit_record DISABLE TRIGGER audit_record_no_truncate`);
    await sql(d.adminUrl, `TRUNCATE audit_record`);
    await sql(d.adminUrl, `ALTER TABLE audit_record ENABLE TRIGGER audit_record_no_truncate`);
    await sql(d.adminUrl, `ALTER TABLE audit_retention_run DISABLE TRIGGER audit_retention_run_no_truncate`);
    await sql(d.adminUrl, `TRUNCATE audit_retention_run`);
    await sql(d.adminUrl, `ALTER TABLE audit_retention_run ENABLE TRIGGER audit_retention_run_no_truncate`);
  });
  afterAll(async () => {
    for (const p of pools) await p.onApplicationShutdown().catch(() => undefined);
    await d?.drop();
  });

  describe('the default: no policy, nothing is purged', () => {
    it('the policy ships EMPTY; a run purges nothing and reports every category as never purged; even a 10-year-old row stays', async () => {
      expect(await sql(d.adminUrl, `SELECT * FROM audit_retention_policy`)).toEqual([]);
      const old = await seed('security', [10 * 365 * DAY]);
      const r = await runRetention(db(d.retentionUrl), opts());
      expect(r).toEqual({ dryRun: false, neverPurged: [...CATEGORIES], categories: [] });
      expect(await present(old)).toBe(1);
      await triggerRefuses(d.retentionUrl, [old[0]!]); // the trigger: no policy
      await triggerRefuses(d.migratorUrl, [old[0]!]); // even the owner, triggers on
    });
  });

  describe('authority boundaries (privileges + trigger)', () => {
    it('the RUNTIME can never delete, update or truncate a record — past any horizon — nor touch the policy, the ledger or the grant function', async () => {
      await setPolicy('business', 1);
      const [old] = await seed('business', [400 * DAY]);
      for (const stmt of [
        [`DELETE FROM audit_record WHERE "eventId" = $1`, [old]],
        [`UPDATE audit_record SET outcome = 'denied' WHERE "eventId" = $1`, [old]],
        ['TRUNCATE audit_record', []],
        [`INSERT INTO audit_retention_policy(category, "retainDays") VALUES ('security', 1)`, []],
        [`UPDATE audit_retention_policy SET "retainDays" = 1`, []],
        [`DELETE FROM audit_retention_policy`, []],
        [`SELECT * FROM audit_retention_policy`, []],
        [`INSERT INTO audit_retention_run(category, "retainDays", cutoff, deleted) VALUES ('business', 1, now(), 1)`, []],
        [`SELECT * FROM audit_retention_run`, []],
        [`SELECT audit_grant_retention(current_user::regrole)`, []],
      ] as const) {
        expect((await failure(d.appUrl, stmt[0], [...stmt[1]])).code, stmt[0]).toBe('42501');
      }
      expect(await present([old!])).toBe(1);
      await expect(runRetention(db(d.appUrl), opts())).rejects.toThrow(/can write audit records/);
    });

    it('the RETENTION role cannot insert, update, truncate, read evidence columns, write the policy or rewrite the ledger; the owner is refused as the runner', async () => {
      await setPolicy('business', 1);
      const [old] = await seed('business', [400 * DAY]);
      for (const stmt of [
        `INSERT INTO audit_record ("eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "resourceType", "resourceId", outcome, "occurredAt") VALUES (gen_random_uuid(), 'billing-service', 'x.y', 'business', 1, 'service', 'billing-service', 'invoice', gen_random_uuid()::text, 'succeeded', now())`,
        `UPDATE audit_record SET category = 'business'`,
        'TRUNCATE audit_record',
        `SELECT "actorId", "resourceId", changes, "organizationId" FROM audit_record`,
        `SELECT * FROM audit_record`,
        `INSERT INTO audit_retention_policy(category, "retainDays") VALUES ('security', 1)`,
        `UPDATE audit_retention_policy SET "retainDays" = 1`,
        `DELETE FROM audit_retention_policy`,
        `SELECT audit_grant_retention(current_user::regrole)`,
      ]) {
        expect((await failure(d.retentionUrl, stmt)).code, stmt).toBe('42501');
      }
      await sql(d.retentionUrl, `INSERT INTO audit_retention_run(category, "retainDays", cutoff, deleted) VALUES ('business', 1, now(), 1)`);
      expect((await failure(d.retentionUrl, `UPDATE audit_retention_run SET deleted = 2`)).code).toBe('42501');
      expect((await failure(d.retentionUrl, `DELETE FROM audit_retention_run`)).code).toBe('42501');
      expect(await sql(d.retentionUrl, `SELECT id, category, "recordedAt" FROM audit_record`)).toHaveLength(1); // only what the purge needs
      expect(await present([old!])).toBe(1);
      await expect(runRetention(db(d.migratorUrl), opts())).rejects.toThrow(/can write audit records/);
    });

    it('the grant function refuses the runtime role, and nobody but the owner can run it', async () => {
      expect((await failure(d.migratorUrl, `SELECT audit_grant_retention($1::regrole)`, [d.app])).message).toMatch(/must be a separate role/);
      expect((await failure(d.retentionUrl, `SELECT audit_grant_retention($1::regrole)`, [d.retention])).code).toBe('42501');
    });

    it('even the retention role cannot delete a row INSIDE its horizon, or of a category with no policy (the trigger decides per row)', async () => {
      await setPolicy('business', 30);
      const [young] = await seed('business', [29 * DAY]);
      const [otherOld] = await seed('security', [400 * DAY]);
      await triggerRefuses(d.retentionUrl, [young!]);
      await triggerRefuses(d.retentionUrl, [otherOld!]);
      // A batch containing one row inside its horizon is refused WHOLE (nothing half-done).
      const [past] = await seed('business', [31 * DAY]);
      await triggerRefuses(d.retentionUrl, [past!, young!]);
      expect(await present([young!, past!, otherOld!])).toBe(3);
      // Positive control: the SAME statement shape succeeds for a row past its horizon (the trigger admits it).
      const pastId = await idOf(past!);
      await sql(d.retentionUrl, `DELETE FROM audit_record WHERE id = $1::bigint`, [pastId]);
      expect(await present([past!])).toBe(0);
    });
  });

  describe('the operator CLI (the built process)', () => {
    const ROOT = fileURLToPath(new URL('../', import.meta.url));
    const cli = (url: string | undefined, ...args: string[]) =>
      spawnSync('node', ['dist/cli/retention.js', ...args], { cwd: ROOT, env: { ...process.env, RETENTION_DATABASE_URL: url ?? '' }, encoding: 'utf8' });

    it('refuses without its URL, as the runtime or as the owner; never echoes a connection string', () => {
      for (const url of [undefined, d.appUrl, d.migratorUrl]) {
        const r = cli(url);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/retention (failed|refused)/);
        for (const secret of [new URL(d.appUrl).password, new URL(d.migratorUrl).password]) expect(r.stderr + r.stdout).not.toContain(secret);
      }
    });

    it('as the retention role: a dry run and a run print counts only (never a record), and purge only what the policy allows', async () => {
      const [old] = await seed('commercial', [10 * DAY]);
      const idle = cli(d.retentionUrl);
      expect(idle.status).toBe(0);
      expect(JSON.parse(idle.stdout.trim().split('\n').pop()!).summary).toMatchObject({ neverPurged: [...CATEGORIES], categories: [] });
      await setPolicy('commercial', 5);
      const dry = cli(d.retentionUrl, '--dry-run');
      expect(JSON.parse(dry.stdout.trim().split('\n').pop()!).summary.categories).toEqual([{ category: 'commercial', retainDays: 5, rows: 1, batches: 0, truncated: false }]);
      expect(await present([old!])).toBe(1);
      const run = cli(d.retentionUrl, '--category', 'commercial', '--batch-size', '10');
      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain(old!);
      expect(await present([old!])).toBe(0);
    });
  });

  describe('the purge', () => {
    it('deletes exactly the rows older than the horizon (minute-level boundary), only in categories with a policy; ledgered; a dry run deletes nothing', async () => {
      await setPolicy('business', 30);
      const keep = await seed('business', [0, 29 * DAY, 30 * DAY - 1]);
      const doomed = await seed('business', [30 * DAY + 1, 400 * DAY]);
      const other = await seed('commercial', [400 * DAY]);
      const dry = await runRetention(db(d.retentionUrl), opts({ dryRun: true }));
      expect(dry.categories).toEqual([{ category: 'business', retainDays: 30, rows: 2, batches: 0, truncated: false }]);
      expect(await present(doomed)).toBe(2);
      expect(await ledger()).toEqual([]);
      const r = await runRetention(db(d.retentionUrl), opts());
      expect(r.neverPurged).toEqual(['security', 'commercial', 'administrative']);
      expect(r.categories).toEqual([{ category: 'business', retainDays: 30, rows: 2, batches: 1, truncated: false }]);
      expect([await present(keep), await present(doomed), await present(other)]).toEqual([3, 0, 1]);
      expect(await ledger()).toEqual([{ category: 'business', deleted: 2, retainDays: 30, ranBy: d.retention }]);
    });

    it('works in bounded batches, stops at maxBatches, and a rerun continues; a run with nothing left writes no ledger row', async () => {
      await setPolicy('administrative', 7);
      await seed('administrative', Array.from({ length: 2500 }, (_, i) => 8 * DAY + i));
      const first = await runRetention(db(d.retentionUrl), opts({ batchSize: 1000, maxBatches: 2 }));
      expect(first.categories[0]).toMatchObject({ rows: 2000, batches: 2, truncated: true });
      const second = await runRetention(db(d.retentionUrl), opts({ batchSize: 1000, maxBatches: 2 }));
      expect(second.categories[0]).toMatchObject({ rows: 500, batches: 1, truncated: false });
      const third = await runRetention(db(d.retentionUrl), opts());
      expect(third.categories[0]).toMatchObject({ rows: 0, batches: 0 });
      expect((await ledger()).map((l) => l.deleted)).toEqual([1000, 1000, 500]);
    });

    it('never touches rows written WHILE it runs (they are newer than any cutoff)', async () => {
      await setPolicy('business', 1);
      await seed('business', Array.from({ length: 3000 }, () => 2 * DAY));
      const live: Promise<string[]>[] = [];
      const run = runRetention(db(d.retentionUrl), opts({ batchSize: 200 }));
      for (let i = 0; i < 10; i++) live.push(seed('business', [0]));
      const [r, ...fresh] = await Promise.all([run, ...live]);
      expect(r.categories[0]!.rows).toBe(3000);
      expect(await present(fresh.flat())).toBe(10);
    });

    it('a failure halfway keeps the committed batches done AND ledgered, loses nothing else; the rerun finishes', async () => {
      await setPolicy('commercial', 1);
      await seed('commercial', Array.from({ length: 2500 }, () => 3 * DAY));
      // Test-only DDL: the ledger refuses its 2nd row, so the 2nd batch's transaction (its DELETE with it) rolls back.
      await sql(d.adminUrl, `CREATE FUNCTION s188_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT count(*) FROM audit_retention_run) >= 1 THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$`);
      await sql(d.adminUrl, `CREATE TRIGGER s188_fail BEFORE INSERT ON audit_retention_run FOR EACH ROW EXECUTE FUNCTION s188_fail()`);
      try {
        await expect(runRetention(db(d.retentionUrl), opts({ batchSize: 1000 }))).rejects.toThrow();
        expect((await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_record`))[0]!.n).toBe(1500);
        expect((await ledger()).map((l) => l.deleted)).toEqual([1000]);
      } finally {
        await sql(d.adminUrl, `DROP TRIGGER s188_fail ON audit_retention_run`);
        await sql(d.adminUrl, `DROP FUNCTION s188_fail()`);
      }
      const rerun = await runRetention(db(d.retentionUrl), opts({ batchSize: 1000 }));
      expect(rerun.categories[0]!.rows).toBe(1500);
      expect((await ledger()).map((l) => l.deleted)).toEqual([1000, 1000, 500]);
    });

    it('a purge batch is an index-only range scan of its own category, whatever never-purged backlog other categories hold', async () => {
      await setPolicy('business', 30);
      // At a realistic scale (the planner cannot know that a whole never-purged backlog is older than the purgeable rows; below ~100 000
      // rows it rightly judges the two plans alike): 300 000 older `security` rows, 20 000 purgeable `business` rows (set-based insert).
      await sql(d.adminUrl, `ALTER TABLE audit_record DISABLE TRIGGER audit_record_stamp`);
      await sql(d.adminUrl,
        `INSERT INTO audit_record ("eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "resourceType", "resourceId", outcome, "occurredAt", "recordedAt")
         SELECT gen_random_uuid(), 'billing-service', 'test.retention_case', CASE WHEN g <= 300000 THEN 'security' ELSE 'business' END, 1, 'service', 'billing-service',
                'invoice', gen_random_uuid()::text, 'succeeded', now() - make_interval(mins => 900 * 1440 - g), now() - make_interval(mins => 900 * 1440 - g)
           FROM generate_series(1, 320000) g`);
      await sql(d.adminUrl, `ALTER TABLE audit_record ENABLE TRIGGER audit_record_stamp`);
      await sql(d.adminUrl, 'VACUUM (ANALYZE) audit_record'); // the steady state autovacuum keeps (visibility map + statistics)
      const plan = (await sql<{ 'QUERY PLAN': string }>(d.retentionUrl,
        `EXPLAIN (COSTS OFF) SELECT id FROM audit_record WHERE category = 'business' AND "recordedAt" < now() - make_interval(days => 30) ORDER BY "recordedAt", id LIMIT 1000`))
        .map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain('audit_record_retention_idx');
      expect(plan).not.toMatch(/Seq Scan|Sort/);
    }, 120_000);

    it('the policy cannot be set to purge on arrival; a tightened or removed policy is re-checked per row by the trigger', async () => {
      expect((await failure(d.migratorUrl, `INSERT INTO audit_retention_policy(category, "retainDays") VALUES ('business', 0)`)).code).toBe('23514');
      expect((await failure(d.migratorUrl, `INSERT INTO audit_retention_policy(category, "retainDays") VALUES ('everything', 30)`)).code).toBe('23514');
      await setPolicy('business', 1);
      const [old] = await seed('business', [2 * DAY]);
      await sql(d.migratorUrl, `DELETE FROM audit_retention_policy WHERE category = 'business'`);
      await triggerRefuses(d.retentionUrl, [old!]);
    });
  });
});
