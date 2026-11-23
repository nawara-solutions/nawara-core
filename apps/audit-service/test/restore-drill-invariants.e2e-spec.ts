import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Core V2 DO-5 / DO-65 (the Owner's restore-safety GO, 2026-11-23; DEVELOPMENT ONLY, disposable databases of the test cluster): the Audit
 * backup and restore drill for the evidence of migrations 0006, 0008 and 0009, with the REAL SQL of `infra/backup/backup.sh` (the
 * backup-time facts: the point-in-time manifest) and of `infra/backup/restore-drill.sh` (the rolled-back controls), a real `pg_dump` /
 * `pg_restore` of the server's own PostgreSQL release (the drill restores with the backup's major), and real roles. The restored database is
 * compared with the manifest captured at backup time, never with the live source, whose later writes are reported as the recovery gap.
 * Every negative control runs inside a transaction that is rolled back. No production database, no purge, no retention duration.
 */
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BACKUP_SH = join(REPO, 'infra/backup/backup.sh');
const DRILL_SH = join(REPO, 'infra/backup/restore-drill.sh');
const COMPANY_A = '0b6a0000-0000-4000-8000-00000000000a';
const COMPANY_B = '0b6b0000-0000-4000-8000-00000000000b';

/** The facts query exactly as backup.sh writes it into the facts file (its functions only: printed, never run against a server here). */
const factsSql = () => execFileSync('bash', ['-c',
  'eval "$(sed -n \'/^audit_facts_sql() {/,/^}/p; /^facts_sql() {/,/^}/p\' "$1")"; AUTHORITY_SQL=$(audit_facts_sql); facts_sql', '_', BACKUP_SH], { encoding: 'utf8' });
/** The drill's rolled-back controls exactly as restore-drill.sh pipes them, with the deploy's role names mapped to this test's roles. */
const controlsSql = (d: ProvisionedDatabase) => execFileSync('bash', ['-c', 'eval "$(sed -n \'/^controls_sql() {/,/^}/p\' "$1")"; controls_sql', '_', DRILL_SH], { encoding: 'utf8' })
  .replaceAll("'audit_migrator'", `'${d.migrator}'`).replaceAll("'audit_app'", `'${d.app}'`).replaceAll('SET LOCAL ROLE audit_app;', `SET LOCAL ROLE ${d.app};`);

/** Run a multi-statement script as psql -At would print it: one line per row, the first column only. */
async function lines(c: pg.Client | string, text: string): Promise<string[]> {
  const client = typeof c === 'string' ? new pg.Client({ connectionString: c }) : c;
  if (typeof c === 'string') await client.connect();
  try {
    const res = await client.query(text);
    const all = Array.isArray(res) ? res : [res];
    return all.flatMap((r) => (r.rows ?? []).map((row: Record<string, unknown>) => String(Object.values(row)[0] ?? '')));
  } finally {
    if (typeof c === 'string') await client.end();
  }
}

/** The manifest comparison of restore-drill.sh's compare_facts (no later migrations): absent facts skipped, every other line present. */
const differing = (expected: string[], now: string[]) => expected.filter((l) => !l.endsWith('|absent') && !now.includes(l));
const key = (l: string) => l.split('|').slice(0, l.startsWith('table|') || l.startsWith('trigger|') || l.startsWith('funcacl|') ? 2 : 1).join('|');

describeWithEnv('Core V2 DO-5 / DO-65: the Audit restore drill keeps the evidence of 0006, 0008 and 0009 (real PostgreSQL, real pg_dump / pg_restore)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let src: ProvisionedDatabase;
  let tgt: { name: string; url: string };
  let manifest: string[];
  let liveAfter: string[];
  let image: string;
  const work = mkdtempSync(join(tmpdir(), 'audit-restore-drill-'));
  const admin = new URL(env.TEST_DATABASE_ADMIN_URL);
  const dockerPg = (args: string[], o: { input?: Buffer; out?: string } = {}) => {
    const out = execFileSync('docker', ['run', '--rm', '-i', '--network', 'host', '-e', `PGPASSWORD=${decodeURIComponent(admin.password)}`, image, ...args],
      { input: o.input, maxBuffer: 256 * 1024 * 1024 });
    if (o.out) writeFileSync(o.out, out);
    return out;
  };
  const conn = (db: string) => ['-h', admin.hostname, '-p', admin.port || '5432', '-U', decodeURIComponent(admin.username), '-d', db];

  /** Backdated trusted records of a Company, written as the 0006 guard requires (the record and its scope row in one statement). */
  const seed = async (url: string, n: number, company: string | null, verified = true) => {
    await sql(url, 'ALTER TABLE audit_record DISABLE TRIGGER audit_record_stamp');
    try {
      for (let i = 0; i < n; i++) {
        await sql(url,
          `WITH ins AS (
             INSERT INTO audit_record ("eventId","sourceService",action,category,"schemaVersion","actorType","actorId","userKind","resourceType","resourceId",outcome,
                                       "occurredAt","recordedAt","companyId","producerIdentityVerified",replayed)
             VALUES ($1,'auth-service','authorization_receipt.issued','security',2,'user',$2,'owner','authorization_receipt',gen_random_uuid()::text,'succeeded',
                     now() - interval '10 days', now() - interval '10 days', $3, $4, false)
             RETURNING id, "companyId")
           INSERT INTO audit_record_scope ("recordId", basis, "companyId") SELECT id, 'verified_producer', "companyId" FROM ins WHERE "companyId" IS NOT NULL AND $4`,
          [randomUUID(), randomUUID(), company, verified]);
      }
    } finally {
      await sql(url, 'ALTER TABLE audit_record ENABLE TRIGGER audit_record_stamp');
    }
  };
  const hold = (url: string, holdId: string, kind: 'placed' | 'released', company: string) => sql(url,
    `INSERT INTO audit_legal_hold_event ("holdId", kind, "companyId", "reasonCode", "actorUserId") VALUES ($1, $2, $3, 'litigation_pending', $4)`,
    [holdId, kind, company, randomUUID()]);
  const coverage = (url: string, instance: string, kind: 'started' | 'heartbeat', seq: number) => sql(url,
    `INSERT INTO audit_dead_letter_coverage ("instanceId", kind, seq, consumers, "observedTotal", "persistedTotal", "droppedOverflow", "droppedSink", "rejectedTotal", buffered, "observedAt")
     VALUES ($1, $2, $3, ARRAY['audit-service.audit'], $3, $3, 0, 0, 0, 0, now())`, [instance, kind, seq]);
  /** Inside a transaction on the restored database that is ALWAYS rolled back: mutate, then return the facts and the controls' outcome. */
  const mutated = async (mutate: (c: pg.Client) => Promise<void>, o: { controls?: boolean } = {}) => {
    const c = new pg.Client({ connectionString: tgt.url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await mutate(c);
      const facts = await lines(c, factsSql());
      let control: string | null = null;
      if (o.controls) {
        await c.query('SAVEPOINT controls');
        try {
          await c.query(controlsSql(src));
        } catch (e) {
          control = /nawara-control [NP][0-9]+[a-z]?/.exec(String((e as Error).message))?.[0] ?? `unidentified: ${(e as Error).message}`;
        }
        await c.query('ROLLBACK TO SAVEPOINT controls');
      }
      return { diff: differing(manifest, facts).map(key), control };
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  };

  beforeAll(async () => {
    const version = (await sql<{ v: string }>(env.TEST_DATABASE_ADMIN_URL, `SELECT split_part(current_setting('server_version'), ' ', 1) AS v`))[0]!.v;
    image = `postgres:${version}`; // the server's own release: the drill restores with the backup's PostgreSQL major
    src = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'ardrill');
    await runMigrations(src.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    await sql(src.migratorUrl, 'SELECT audit_grant_retention($1::regrole)', [src.retention]);
    // the deploy's schema_migrations narrowing (as apps/audit-service/deploy and restore-drill.sh apply it): the source is a deployed database
    await sql(src.adminUrl, `REVOKE ALL ON TABLE schema_migrations FROM ${src.app}`);
    await sql(src.adminUrl, `GRANT SELECT ON TABLE schema_migrations TO ${src.app}`);
    // ---- the required pre-backup fixtures
    await seed(src.adminUrl, 3, COMPANY_A);                      // broker-verified records with trusted Company scope (Company A)
    await seed(src.adminUrl, 2, COMPANY_B);                      // and Company B
    await seed(src.adminUrl, 1, null, false);                    // an unverified record: no scope, never holdable
    const active = randomUUID();
    const released = randomUUID();
    await hold(src.adminUrl, active, 'placed', COMPANY_A);      // an active legal hold and its event
    await hold(src.adminUrl, released, 'placed', COMPANY_B);    // a previously released hold and its two events
    await hold(src.adminUrl, released, 'released', COMPANY_B);
    await sql(src.adminUrl, `INSERT INTO audit_retention_run (category, "retainDays", cutoff, deleted) VALUES ('commercial', 30, now() - interval '30 days', 2)`); // a purge-ledger entry
    const attempt = randomUUID();
    const instance = randomUUID();
    for (const transition of ['attempted', 'transfer_confirmed']) {                   // a dead-letter transfer and its outcome
      await sql(src.adminUrl,
        `INSERT INTO audit_dead_letter_transition ("attemptId", transition, "instanceId", consumer, "eventId", "eventName", source, failure, "errorClass", "retryCount", "replayCount", redelivered, "observedAt")
         VALUES ($1, $2, $3, 'audit-service.audit', 'evt-1', 'auth.user_registered', 'auth-service', 'retries_exhausted', 'TransientError', 5, 0, true, now())`, [attempt, transition, instance]);
    }
    await coverage(src.adminUrl, instance, 'started', 0);       // coverage facts: started and one heartbeat
    await coverage(src.adminUrl, instance, 'heartbeat', 1);
    // ---- the backup: the manifest (as the backup's own user) and the archive, at the same instant (nothing writes in between)
    manifest = await lines(src.migratorUrl, factsSql());
    writeFileSync(join(work, 'manifest.txt'), `${manifest.join('\n')}\n`);
    dockerPg(['pg_dump', ...conn(src.name), '-Fc'], { out: join(work, 'db.dump') });
    // ---- source activity AFTER the backup (the recovery gap): one more trusted record and one more heartbeat
    await seed(src.adminUrl, 1, COMPANY_A);
    await coverage(src.adminUrl, instance, 'heartbeat', 2);
    liveAfter = await lines(src.migratorUrl, factsSql());
    // ---- the restore: a new database with the deploy's roles and privileges first, then pg_restore --exit-on-error
    tgt = { name: `${src.name}_restored`, url: '' };
    await sql(env.TEST_DATABASE_ADMIN_URL, `CREATE DATABASE ${tgt.name} OWNER ${src.migrator}`);
    const u = new URL(env.TEST_DATABASE_ADMIN_URL);
    u.pathname = `/${tgt.name}`;
    tgt.url = u.toString();
    await sql(tgt.url, `REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await sql(tgt.url, `ALTER SCHEMA public OWNER TO ${src.migrator}`);
    dockerPg(['pg_restore', '--exit-on-error', ...conn(tgt.name)], { input: readFileSync(join(work, 'db.dump')) });
  }, 300_000);

  afterAll(async () => {
    if (tgt?.name) {
      await sql(env.TEST_DATABASE_ADMIN_URL, 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [tgt.name]);
      await sql(env.TEST_DATABASE_ADMIN_URL, `DROP DATABASE IF EXISTS ${tgt.name}`);
    }
    await src?.drop();
    if (process.env.DRILL_EVIDENCE_DIR) {
      mkdirSync(process.env.DRILL_EVIDENCE_DIR, { recursive: true });
      for (const f of ['manifest.txt', 'gap.txt', 'controls.txt']) {
        try { copyFileSync(join(work, f), join(process.env.DRILL_EVIDENCE_DIR, f)); } catch { /* not produced */ }
      }
    }
    rmSync(work, { recursive: true, force: true });
  });

  describe('the backup-time manifest', () => {
    it('M1 records every required fixture: scope rows, hold events and state, held records, the purge ledger, dead-letter rows, the three migrations', () => {
      const fact = (k: string) => manifest.find((l) => l.startsWith(`${k}|`));
      expect(manifest.filter((l) => l.startsWith('migration_present|'))).toEqual(
        ['migration_present|0006_audit_contract_v2.sql', 'migration_present|0008_audit_legal_hold.sql', 'migration_present|0009_dead_letter_observation.sql']);
      expect(fact('scope_digest')).toMatch(/^scope_digest\|5\|[0-9a-f]{32}$/);
      expect(fact('hold_digest')).toMatch(/^hold_digest\|3\|[0-9a-f]{32}$/);
      expect(fact('hold_state')).toBe('hold_state|1|1'); // one active, one released
      expect(fact('held_records')).toMatch(/^held_records\|3\|[0-9a-f]{32}$/); // Company A's three records, not B's (released), not the unscoped one
      expect(fact('retention_run_digest')).toMatch(/^retention_run_digest\|1\|[0-9a-f]{32}$/);
      expect(fact('dead_letter_transition_digest')).toMatch(/^dead_letter_transition_digest\|2\|[0-9a-f]{32}$/);
      expect(fact('dead_letter_coverage_digest')).toMatch(/^dead_letter_coverage_digest\|2\|[0-9a-f]{32}$/);
      for (const f of ['audit_record_is_held', 'audit_record_hold_guard', 'audit_legal_hold_event_guard', 'audit_record_scope_guard', 'audit_dead_letter_append_only']) {
        expect(manifest.some((l) => l.startsWith(`funcacl|${f}|`)), f).toBe(true);
      }
      expect(manifest.some((l) => l.startsWith('funcacl|audit_record_is_held|') && l.includes(`${src.retention}=X/`))).toBe(true); // the retention role's grant
      expect(manifest.some((l) => l.endsWith('|absent'))).toBe(false);
    });
  });

  describe('the restore (point in time: compared with the manifest, never with the live source)', () => {
    it('R1 every manifest fact holds in the restored database: identities, counts, scope association, holds, ledger, dead-letter rows, grants, triggers', async () => {
      const now = await lines(tgt.url, factsSql());
      expect(differing(manifest, now)).toEqual([]);
      expect(now.filter((l) => l.startsWith('migration_present|'))).toHaveLength(3);
    });

    it('R2 the recovery gap: the live source wrote after the backup; the restored database does not have it, and the gap is reported apart', () => {
      const gap = differing(liveAfter, manifest).map(key);
      writeFileSync(join(work, 'gap.txt'), `${gap.join('\n')}\n`);
      // the restore is NOT the live source: the record and the heartbeat written after the backup are the recovery-point loss (RPO = backup age)
      expect(gap).toEqual(expect.arrayContaining(['table|audit_record', 'table|audit_record_scope', 'table|audit_dead_letter_coverage', 'audit_digest', 'scope_digest',
        'held_records', 'dead_letter_coverage_digest', 'known']));
      expect(gap).not.toContain('hold_digest'); // no hold activity after the backup
      expect(gap).not.toContain('retention_run_digest');
    });

    it('R3 the drill\'s controls pass on the restored database (N1-N15, P1, P3-P5), rolled back: the manifest still holds afterwards', async () => {
      const c = new pg.Client({ connectionString: tgt.url });
      await c.connect();
      try {
        await c.query(controlsSql(src));
      } finally {
        await c.end();
      }
      writeFileSync(join(work, 'controls.txt'), 'nawara-drill-controls: N1-N10, N11a-f, N12a-c, N13a-c, N14 (restored held records), N15, P1, P3, P4, P5: passed, rolled back\n');
      expect(differing(manifest, await lines(tgt.url, factsSql()))).toEqual([]);
      expect((await sql<{ n: number }>(tgt.url, `SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'nawara_drill_retention'`))[0]!.n).toBe(0);
      expect((await sql<{ n: number }>(tgt.url, `SELECT count(*)::int AS n FROM audit_retention_policy`))[0]!.n).toBe(0); // nothing is purged: still no duration
    });

    it('R4 active holds still cover exactly their Company\'s restored records; the released hold and the other Company cover none', async () => {
      const held = await sql<{ company: string; n: number }>(tgt.url,
        `SELECT s."companyId"::text AS company, count(*)::int AS n FROM audit_record_scope s WHERE audit_record_is_held(s."recordId") GROUP BY 1 ORDER BY 1`);
      expect(held).toEqual([{ company: COMPANY_A, n: 3 }]);
    });
  });

  describe('negative controls: each defect of the restored database fails the drill (every mutation rolled back)', () => {
    it('NC1 a missing hold-event guard trigger: a fact differs, and the hold-event rewrite control is not refused', async () => {
      const r = await mutated(async (c) => { await c.query('DROP TRIGGER audit_legal_hold_event_guard ON audit_legal_hold_event'); }, { controls: true });
      expect(r.diff).toContain('trigger|audit_legal_hold_event');
      expect(r.control).toBe('nawara-control N12a');
    });

    it('NC2 a missing dead-letter append-only trigger: a fact differs, and the dead-letter update control is not refused', async () => {
      const r = await mutated(async (c) => { await c.query('DROP TRIGGER audit_dead_letter_transition_10_append_only ON audit_dead_letter_transition'); }, { controls: true });
      expect(r.diff).toContain('trigger|audit_dead_letter_transition');
      expect(r.control).toBe('nawara-control N11a');
    });

    it('NC3 hold-aware delete protection lost (the guard answers "not held"): the restored held records become deletable, N14 fails', async () => {
      const r = await mutated(async (c) => {
        await c.query(`CREATE OR REPLACE FUNCTION audit_record_hold_guard(record_id bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$`);
      }, { controls: true });
      expect(r.control).toBe('nawara-control N14');
    });

    it('NC3b a hold check that never covers anything: the active hold no longer covers its Company (P3 fails, the held-records fact differs)', async () => {
      const r = await mutated(async (c) => {
        await c.query(`CREATE OR REPLACE FUNCTION audit_record_is_held(record_id bigint) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT false $$`);
      }, { controls: true });
      expect(r.diff).toContain('held_records');
      expect(r.control).toBe('nawara-control P3');
    });

    it('NC3c a hold check that covers everything (another Company, a released hold): P4 fails and the held-records fact differs', async () => {
      const r = await mutated(async (c) => {
        await c.query(`CREATE OR REPLACE FUNCTION audit_record_is_held(record_id bigint) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT true $$`);
      }, { controls: true });
      expect(r.diff).toContain('held_records');
      expect(r.control).toBe('nawara-control P4');
    });

    it('NC4 a missing role grant (the retention role loses EXECUTE on the hold check): the function ACL fact differs', async () => {
      const r = await mutated(async (c) => { await c.query(`REVOKE EXECUTE ON FUNCTION audit_record_is_held(bigint) FROM ${src.retention}`); });
      expect(r.diff).toContain('funcacl|audit_record_is_held');
    });

    it('NC5 a missing scope row: the scope digest, the held records and the row count differ', async () => {
      const r = await mutated(async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`DELETE FROM audit_record_scope WHERE id = (SELECT min(id) FROM audit_record_scope)`);
      });
      expect(r.diff).toEqual(expect.arrayContaining(['scope_digest', 'held_records', 'table|audit_record_scope']));
    });

    it('NC6 cross-Company authority: a restored scope row moved to another Company differs from the manifest (scope and held records)', async () => {
      const r = await mutated(async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE audit_record_scope SET "companyId" = $1 WHERE "companyId" = $2`, [COMPANY_A, COMPANY_B]);
      });
      expect(r.diff).toEqual(expect.arrayContaining(['scope_digest', 'held_records']));
    });

    it('NC7 a rewritten hold event (its meaning changed): the hold digest differs', async () => {
      const r = await mutated(async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE audit_legal_hold_event SET "reasonCode" = 'rewritten' WHERE kind = 'placed'`);
      });
      expect(r.diff).toContain('hold_digest');
    });

    it('NC8 a lost hold release: the hold state, the hold digest and the held records differ', async () => {
      const r = await mutated(async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`DELETE FROM audit_legal_hold_event WHERE kind = 'released'`);
      });
      expect(r.diff).toEqual(expect.arrayContaining(['hold_state', 'hold_digest', 'held_records']));
    });

    it('NC9 an altered purge-ledger entry: its digest differs', async () => {
      const r = await mutated(async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE audit_retention_run SET deleted = deleted + 1`);
      });
      expect(r.diff).toContain('retention_run_digest');
    });

    it('NC10 an altered dead-letter transition or coverage fact: its digest differs', async () => {
      const t = await mutated(async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE audit_dead_letter_transition SET failure = 'permanent' WHERE transition = 'attempted'`);
      });
      expect(t.diff).toContain('dead_letter_transition_digest');
      const v = await mutated(async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE audit_dead_letter_coverage SET "droppedSink" = 1 WHERE kind = 'heartbeat'`);
      });
      expect(v.diff).toContain('dead_letter_coverage_digest');
    });

    it('NC11 a migration missing from the restored history: its migration_present fact differs', async () => {
      const r = await mutated(async (c) => { await c.query(`DELETE FROM schema_migrations WHERE name = '0009_dead_letter_observation.sql'`); });
      expect(r.diff).toEqual(expect.arrayContaining(['migration_present', 'migrations']));
    });
  });

  describe('an older source (before 0006): backed up and compared exactly as before', () => {
    it('O1 the facts query runs and records the evidence as absent; nothing of it is compared', async () => {
      const old = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'ardold');
      const dir = mkdtempSync(join(tmpdir(), 'audit-migrations-0005-'));
      try {
        for (const f of readdirSync(auditMigrationsDir).filter((n) => /^000[1-5]_.*\.sql$/.test(n))) copyFileSync(join(auditMigrationsDir, f), join(dir, f));
        await runMigrations(old.migratorUrl, [kitMigrationsDir, dir]);
        const facts = await lines(old.migratorUrl, factsSql());
        for (const k of ['scope_digest', 'hold_digest', 'hold_state', 'held_records', 'dead_letter_transition_digest', 'dead_letter_coverage_digest']) {
          expect(facts, k).toContain(`${k}|absent`);
        }
        expect(facts.filter((l) => l.startsWith('migration_present|'))).toEqual([]);
        expect(facts.find((l) => l.startsWith('retention_run_digest|'))).toBe('retention_run_digest|0|');
      } finally {
        rmSync(dir, { recursive: true, force: true });
        await old.drop();
      }
    });
  });
});
