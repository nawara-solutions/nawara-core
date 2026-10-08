import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  OUTBOX_RETENTION_VERIFIED_SERVICES, applyOutboxRetention, inspectOutboxRetention, parseRetentionAge, retentionDatabaseOwner,
} from '../src/events/outbox-retention.js';
import { OutboxService } from '../src/events/outbox.service.js';
import { kitMigrationsDir, runMigrations } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

/**
 * V2 A3M.5 (A3M record §14): the manual retention of published outbox rows. Every deletion here is against a scratch database created
 * and dropped by this file. The CLI cases run the BUILT `dist/cli/outbox-retention.js`, exactly what an operator would run.
 */
const MARKER = 'retention-payload-marker-5e1c';
const cli = fileURLToPath(new URL('../dist/cli/outbox-retention.js', import.meta.url));
const HOUR = 3_600_000;
/** A derived-style id: any uuid whose version is 5 (as the deterministic producers write). */
const withVersion = (v: string) => {
  const id = randomUUID();
  return `${id.slice(0, 14)}${v}${id.slice(15)}`;
};
const v5 = () => withVersion('5');
/** The scratch database plays auth-service's: it is owned by `auth_migrator`, as provisioning does (ADR-0032). */
const SVC = ['--service', 'auth-service'] as const;

describeWithEnv('manual outbox retention (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let name: string;
  let createdRole = false;
  const secret = decodeURIComponent(new URL(env.TEST_DATABASE_ADMIN_URL).password);

  /** One outbox row, published `publishedHoursAgo` hours ago (null = unpublished), created `publishedHoursAgo + 1` hours ago. */
  const insert = async (o: { id?: string; publishedHoursAgo: number | null; event?: string }) => {
    const id = o.id ?? randomUUID();
    await pool.query(
      `INSERT INTO outbox(id, name, payload, "occurredAt", "publishedAt") VALUES ($1, $2, $3::jsonb, now() - ($4::int * interval '1 hour'),
         CASE WHEN $5::int IS NULL THEN NULL ELSE now() - ($5::int * interval '1 hour') END)`,
      [id, o.event ?? 'thing.happened', JSON.stringify({ note: MARKER }), (o.publishedHoursAgo ?? 100) + 1, o.publishedHoursAgo],
    );
    return id;
  };
  const ids = async () => (await pool.query<{ id: string }>('SELECT id FROM outbox')).rows.map((r) => r.id).sort();
  const run = (args: string[], over: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH ?? '', DATABASE_URL: db.url, ...over }, encoding: 'utf8', timeout: 30_000 });
    const output = r.stdout + r.stderr;
    // 11: counts only. Never a payload, an event name, a credential or a connection string.
    for (const forbidden of [MARKER, 'thing.happened', secret, 'postgres://']) expect(output, `output must not contain ${forbidden === secret ? 'the password' : forbidden}`).not.toContain(forbidden);
    return r;
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'outboxret');
    await runMigrations(db.url, [kitMigrationsDir]);
    pool = new pg.Pool({ connectionString: db.url, max: 4 });
    name = new URL(db.url).pathname.slice(1);
    // Ownership as ADR-0032 provisions it. The role is created only if this server does not have it, and removed only if this file made it.
    const admin = new pg.Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
    await admin.connect();
    try {
      const owner = retentionDatabaseOwner('auth-service');
      createdRole = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [owner])).rowCount === 0;
      if (createdRole) await admin.query(`CREATE ROLE ${owner} NOLOGIN`);
      await admin.query(`ALTER DATABASE "${name}" OWNER TO ${owner}`);
    } finally {
      await admin.end();
    }
  });
  afterAll(async () => {
    await pool.end();
    await db.drop();
    if (createdRole) {
      const admin = new pg.Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
      await admin.connect();
      try {
        await admin.query(`DROP ROLE IF EXISTS ${retentionDatabaseOwner('auth-service')}`);
      } finally {
        await admin.end();
      }
    }
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM outbox');
  });

  it('1-3, 14: only published, old, random-id rows are eligible; unpublished, recent and derived-id rows are kept, with no way to include them', async () => {
    const unpublishedOld = await insert({ publishedHoursAgo: null });
    const recent = await insert({ publishedHoursAgo: 1 });
    const oldRandom = await insert({ publishedHoursAgo: 48 });
    const oldDerived = await insert({ id: v5(), publishedHoursAgo: 48 });

    expect(await inspectOutboxRetention(pool, 24 * HOUR)).toMatchObject({ eligible: 1, protectedDeterministic: 1, retainedRecent: 1, unpublished: 1 });
    expect(await applyOutboxRetention(pool, { olderThanMs: 24 * HOUR, batchSize: 100, maxBatches: 5 })).toEqual({ deleted: 1, batches: 1, more: false });
    expect(await ids()).toEqual([unpublishedOld, recent, oldDerived].sort());
    expect(await ids()).not.toContain(oldRandom);

    // even the shortest age never reaches an unpublished or a derived-id row
    await applyOutboxRetention(pool, { olderThanMs: 60_000, batchSize: 100, maxBatches: 5 });
    expect(await ids()).toEqual([unpublishedOld, oldDerived].sort());
    // and the CLI has no option that includes derived ids
    const bypass = run([...SVC, '--database', name, '--older-than', '1m', '--apply', '--include-deterministic']);
    expect(bypass.status).toBe(2);
    expect(await ids()).toEqual([unpublishedOld, oldDerived].sort());
  });

  it('4, 6: without --apply the CLI is a dry run: it reports counts and deletes nothing', async () => {
    await insert({ publishedHoursAgo: 48 });
    await insert({ publishedHoursAgo: 48 });
    await insert({ id: v5(), publishedHoursAgo: 48 });
    await insert({ publishedHoursAgo: null });
    const before = await ids();
    const r = run([...SVC, '--database', name, '--older-than', '1d']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^outbox_retention mode=dry-run service=auth-service database=${name} olderThan=1d eligible=2 protectedDeterministic=1 retainedRecent=0 unpublished=1 oldestEligibleAgeSeconds=\\d+\\n`));
    expect(r.stdout).toContain('dry-run: nothing was deleted');
    expect(await ids()).toEqual(before);
  });

  it('with --apply the CLI deletes exactly the eligible rows and reports counts', async () => {
    await insert({ publishedHoursAgo: 48 });
    await insert({ publishedHoursAgo: 48 });
    const kept = [await insert({ id: v5(), publishedHoursAgo: 48 }), await insert({ publishedHoursAgo: null }), await insert({ publishedHoursAgo: 2 })];
    const r = run([...SVC, '--database', name, '--older-than', '1d', '--apply']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('mode=apply');
    expect(r.stdout).toContain('outbox_retention applied deleted=2 batches=1 more=false');
    expect(await ids()).toEqual(kept.sort());
  });

  it('5, 7: a missing age, an unsafe scope or an unknown argument is refused (exit 2) before anything is read or deleted', async () => {
    await insert({ publishedHoursAgo: 48 });
    const before = await ids();
    const refused: Array<[string[], RegExp, Record<string, string>?]> = [
      [[...SVC, '--database', name, '--apply'], /--older-than <age> is required: there is no default retention age/],
      [[...SVC, '--database', name, '--older-than', '30', '--apply'], /--older-than must be a whole number and a unit/],
      [[...SVC, '--database', name, '--older-than', '0d', '--apply'], /--older-than must be a whole number and a unit/],
      [[...SVC, '--older-than', '1d', '--apply'], /--database <name> is required/],
      [[...SVC, '--database', 'Not A Name;', '--older-than', '1d', '--apply'], /--database must be a database name/],
      [[...SVC, '--database', 'another_database', '--older-than', '1d', '--apply'], /--database does not name the database this connection opens: nothing was read or deleted/],
      [[...SVC, '--database', name, '--older-than', '1d', '--apply', '--database-url', db.url], /unknown argument/],
      [[...SVC, '--database', name, '--older-than', '1d', '--apply', '--batch-size', '0'], /--batch-size must be an integer between 1 and 5000/],
      [[...SVC, '--database', name, '--older-than', '1d', '--apply', '--max-batches', '100000'], /--max-batches must be an integer between 1 and 1000/],
      [[...SVC, '--database', name, '--older-than', '1d', '--older-than', '2d', '--apply'], /--older-than is given more than once/],
      [[...SVC, '--database', name, '--older-than', '1d', '--apply'], /DATABASE_URL.*not both|set DATABASE_URL or DATABASE_URL_FILE/, { DATABASE_URL_FILE: '/nonexistent/retention-url' }],
    ];
    for (const [args, message, over] of refused) {
      const r = run(args, over);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toMatch(message);
      expect(r.stdout).toBe('');
    }
    expect(await ids()).toEqual(before);
  });

  it('8, 10, 12: a row another session holds (the relay, or Auth\'s code-event purge) is skipped, never waited for; a later run takes it', async () => {
    const held = await insert({ publishedHoursAgo: 48, event: 'admin.operator_code_issued' });
    const free = await insert({ publishedHoursAgo: 48 });
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT id FROM outbox WHERE id = $1 FOR UPDATE', [held]);
      const started = Date.now();
      const r = run([...SVC, '--database', name, '--older-than', '1d', '--apply']);
      expect(r.status).toBe(0);
      expect(Date.now() - started).toBeLessThan(15_000); // it did not wait for the lock
      expect(r.stdout).toContain('applied deleted=1 batches=1 more=false');
      expect(await ids()).toEqual([held]);
      expect(await ids()).not.toContain(free);
      // the other session is not disturbed: it can still delete its row itself, as the code-event purge does
      await other.query('DELETE FROM outbox WHERE id = $1', [held]);
      await other.query('COMMIT');
    } finally {
      other.release();
    }
    expect(await ids()).toEqual([]);
    // 10: a repeated run is safe and finds nothing
    const again = run([...SVC, '--database', name, '--older-than', '1d', '--apply']);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('applied deleted=0 batches=1 more=false');
  });

  it('9, 10: batches are bounded; a run that stops at its limit says so and the next run continues', async () => {
    for (let i = 0; i < 7; i++) await insert({ publishedHoursAgo: 48 + i });
    const first = run([...SVC, '--database', name, '--older-than', '1d', '--apply', '--batch-size', '2', '--max-batches', '2']);
    expect(first.stdout).toContain('applied deleted=4 batches=2 more=true');
    expect(await ids()).toHaveLength(3);
    const second = run([...SVC, '--database', name, '--older-than', '1d', '--apply', '--batch-size', '2', '--max-batches', '2']);
    expect(second.stdout).toContain('applied deleted=3 batches=2 more=false');
    expect(await ids()).toHaveLength(0);
  });

  it('13: a database failure ends the run with exit 1 and no value in the output; nothing is retried', async () => {
    const started = Date.now();
    const r = run([...SVC, '--database', name, '--older-than', '1d', '--apply'], { DATABASE_URL: `postgres://app:${secret}@127.0.0.1:1/${name}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^outbox retention failed: /);
    expect(r.stdout).toBe('');
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('the allowlist: only auth-service and organization-service are accepted; a missing, unknown or unapproved service is refused before anything is opened', async () => {
    expect([...OUTBOX_RETENTION_VERIFIED_SERVICES]).toEqual(['auth-service', 'organization-service']);
    await insert({ publishedHoursAgo: 48 });
    const before = await ids();
    const tail = ['--database', name, '--older-than', '1d', '--apply'];
    // refused on the argument alone: DATABASE_URL points at a closed port, so reaching the database would be exit 1, not 2
    const closed = { DATABASE_URL: `postgres://app:${secret}@127.0.0.1:1/${name}` };
    const missing = run(tail, closed);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('--service <name> is required (one of: auth-service, organization-service)');
    for (const service of ['payment-service', 'billing-service', 'file-service', 'release-service', 'notification-service', 'audit-service', 'auth', 'AUTH-SERVICE', '*', '']) {
      const r = run(['--service', service, ...tail], closed);
      expect(r.status, `service "${service}"`).toBe(2);
      expect(r.stderr, `service "${service}"`).toMatch(/--service is not a service verified for outbox retention|--service <name> is required/);
    }
    // no option widens the scope
    for (const bypass of ['--all-services', '--include-deterministic', '--force']) expect(run([...SVC, ...tail, bypass]).status, bypass).toBe(2);
    expect(await ids()).toEqual(before);
    // an approved name still has to match the database: this one is provisioned for auth-service, not organization-service
    const wrong = run(['--service', 'organization-service', ...tail]);
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('this database is not owned by the role provisioned for --service');
    expect(await ids()).toEqual(before);
    // and the approved service on its own database is accepted (a dry run: nothing deleted)
    const ok = run([...SVC, '--database', name, '--older-than', '1d']);
    expect(ok.status).toBe(0);
    expect(await ids()).toEqual(before);
  });

  it('a database that was not provisioned for the service (another owner) is refused, even for an approved service', async () => {
    const other = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'outboxret');
    try {
      await runMigrations(other.url, [kitMigrationsDir]);
      const otherName = new URL(other.url).pathname.slice(1);
      const r = run([...SVC, '--database', otherName, '--older-than', '1d', '--apply'], { DATABASE_URL: other.url });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('this database is not owned by the role provisioned for --service');
    } finally {
      await other.drop();
    }
  });

  it('only a version-4 id is eligible: versions 5, 7 and 1, the nil uuid and other non-random ids are all protected, with or without --apply', async () => {
    const protectedIds = [
      await insert({ id: withVersion('5'), publishedHoursAgo: 48 }),
      await insert({ id: withVersion('7'), publishedHoursAgo: 48 }),
      await insert({ id: withVersion('1'), publishedHoursAgo: 48 }),
      await insert({ id: withVersion('3'), publishedHoursAgo: 48 }),
      await insert({ id: '00000000-0000-0000-0000-000000000000', publishedHoursAgo: 48 }),
      await insert({ id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', publishedHoursAgo: 48 }),
    ];
    const random = await insert({ publishedHoursAgo: 48 });
    expect(await inspectOutboxRetention(pool, HOUR)).toMatchObject({ eligible: 1, protectedDeterministic: protectedIds.length });
    const r = run([...SVC, '--database', name, '--older-than', '1h', '--apply']);
    expect(r.stdout).toContain(`eligible=1 protectedDeterministic=${protectedIds.length}`);
    expect(r.stdout).toContain('applied deleted=1 batches=1 more=false');
    expect(await ids()).toEqual([...protectedIds].sort());
    expect(await ids()).not.toContain(random);
  });

  it('the limitation the service list and check:repo exist for: a SUPPLIED version-4 id is deleted, and the producer can then write it again', async () => {
    // A producer that supplies a stable id relies on the outbox to write a repeated operation's event once (the id conflict).
    const outbox = new OutboxService();
    const stable = randomUUID(); // version 4, but chosen by the "producer" and reused
    expect(await outbox.enqueue(pool, { id: stable, name: 'thing.happened', payload: { n: 1 } })).toBe(stable);
    await outbox.enqueue(pool, { id: stable, name: 'thing.happened', payload: { n: 1 } }); // the repeated operation: no second row
    expect(await ids()).toEqual([stable]);
    await pool.query(`UPDATE outbox SET "publishedAt" = now() - interval '48 hours' WHERE id = $1`, [stable]);
    // The row looks random, so retention deletes it ...
    expect(await applyOutboxRetention(pool, { olderThanMs: HOUR, batchSize: 10, maxBatches: 1 })).toMatchObject({ deleted: 1 });
    // ... and the repeated operation now writes, and would publish, the same event id again.
    await outbox.enqueue(pool, { id: stable, name: 'thing.happened', payload: { n: 1 } });
    expect(await ids()).toEqual([stable]);
    expect((await pool.query('SELECT "publishedAt" FROM outbox WHERE id = $1', [stable])).rows[0].publishedAt).toBeNull();
    // Nothing in the database can tell this id from a generated one: only the reviewed service list and the repository guard can.
  });

  it('ages: a whole number and one unit, nothing else', () => {
    expect(parseRetentionAge('30d')).toBe(30 * 24 * HOUR);
    expect(parseRetentionAge('12h')).toBe(12 * HOUR);
    expect(parseRetentionAge('45m')).toBe(45 * 60_000);
    for (const bad of ['', '0d', '-1d', '1.5d', '30', 'd', '30 d', '30D', '1w', '1d2h', '9999999d']) expect(parseRetentionAge(bad), bad).toBeUndefined();
  });
});
