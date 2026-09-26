import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { releaseMigrationsDir } from '../src/app.module.js';
import { createTestApp } from './support/app.js';
import { failure, sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Stage 20.2 (ADR-0051): every invariant of the Release Management schema, attacked DIRECTLY as the least-privilege runtime role (the
 * role the service runs as), on real PostgreSQL 16. The service's own checks are not involved: the database alone must refuse.
 */
describeWithEnv('release-service schema invariants (real PostgreSQL, runtime role)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  const app = (text: string, params: unknown[] = []) => sql<Record<string, any>>(d.appUrl, text, params);
  const refused = (text: string, params: unknown[] = []) => failure(d.appUrl, text, params);
  let n = 0;
  const key = (p: string) => `${p}-${n++}`;
  const product = async () => (await app(`INSERT INTO product (key) VALUES ($1) RETURNING id`, [key('p')]))[0]!.id as string;
  const component = async (kind = 'web', productId?: string) =>
    (await app(`INSERT INTO component ("productId", key, kind) VALUES ($1, $2, $3) RETURNING id`, [productId ?? (await product()), key('c'), kind]))[0]!.id as string;
  const release = async (componentId: string, version: string, status: 'registered' | 'published' | 'withdrawn' = 'registered') => {
    const id = (await app(`INSERT INTO release ("componentId", version) VALUES ($1, $2) RETURNING id`, [componentId, version]))[0]!.id as string;
    if (status !== 'registered') await app(`UPDATE release SET status = 'published', "publishedAt" = now() WHERE id = $1`, [id]);
    if (status === 'withdrawn') await app(`UPDATE release SET status = 'withdrawn', "withdrawnAt" = now() WHERE id = $1`, [id]);
    return id;
  };
  const policy = (componentId: string, v: number, minimum: string) =>
    app(`INSERT INTO compatibility_policy ("componentId", "policyVersion", "minimumVersion") VALUES ($1, $2, $3)`, [componentId, v, minimum]);
  const latest = async (componentId: string) =>
    (await app(`SELECT version FROM release WHERE "componentId" = $1 AND status = 'published' AND prerelease IS NULL ORDER BY major DESC, minor DESC, patch DESC LIMIT 1`, [componentId]))[0]?.version as string | undefined;

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'relschema');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, releaseMigrationsDir]); // the explicit step, as the schema owner
  });
  afterAll(async () => {
    await d?.drop();
  });

  // ─────────────────────────────────────────────────────────────── the runtime role

  it('the service is ready as the runtime role, which owns nothing', async () => {
    const t = await createTestApp({ databaseUrl: d.appUrl });
    try {
      await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' });
    } finally {
      await t.app.close();
    }
    const owned = await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND pg_get_userbyid(c.relowner) = $1`, [d.app]);
    expect(owned[0]!.n).toBe(0);
  });

  it.each([
    ['create a table', 'CREATE TABLE deployment (id int)'],
    ['drop a trigger', 'DROP TRIGGER release_lifecycle ON release'],
    ['disable a trigger', 'ALTER TABLE release DISABLE TRIGGER release_identity_immutable'],
    ['replace a trigger function', `CREATE OR REPLACE FUNCTION release_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$`],
    ['drop a constraint', 'ALTER TABLE release DROP CONSTRAINT release_version_semver'],
    ['bypass triggers (session_replication_role)', 'SET session_replication_role = replica'],
    ['re-grant itself privileges', 'SELECT release_revoke(\'product\', \'SELECT\')'],
  ])('the runtime role cannot %s', async (_label, statement) => {
    expect((await refused(statement)).code).toMatch(/^(42501|42939)$/);
  });

  it('layer 2: the triggers refuse even the schema OWNER (who keeps every privilege): no update or delete of products, components, policies; no release delete', async () => {
    const owner = (text: string, params: unknown[] = []) => failure(d.migratorUrl, text, params);
    const c = await component('web');
    await release(c, '1.0.0', 'published');
    await policy(c, 1, '1.0.0');
    for (const statement of [
      `UPDATE product SET key = 'x' WHERE id = (SELECT "productId" FROM component WHERE id = '${c}')`,
      `DELETE FROM product WHERE id = (SELECT "productId" FROM component WHERE id = '${c}')`,
      `UPDATE component SET kind = 'desktop' WHERE id = '${c}'`,
      `DELETE FROM component WHERE id = '${c}'`,
      `UPDATE compatibility_policy SET "minimumVersion" = '0.1.0' WHERE "componentId" = '${c}'`,
      `DELETE FROM compatibility_policy WHERE "componentId" = '${c}'`,
      `DELETE FROM release WHERE "componentId" = '${c}'`,
    ]) {
      expect((await owner(statement)).message, statement).toMatch(/refused/);
    }
  });

  // ─────────────────────────────────────────────────────────────── product / component

  it('product: unique, well-formed key; immutable; never deleted', async () => {
    const k = key('dup');
    await app(`INSERT INTO product (key) VALUES ($1)`, [k]);
    expect((await refused(`INSERT INTO product (key) VALUES ($1)`, [k])).constraint).toBe('product_key_unique');
    for (const bad of ['', 'Upper', '1starts-with-digit', 'has space', 'a'.repeat(64), 'under_score']) {
      expect((await refused(`INSERT INTO product (key) VALUES ($1)`, [bad])).code, bad).toBe('23514');
    }
    expect((await refused(`UPDATE product SET key = 'renamed' WHERE key = $1`, [k])).code).toBe('42501');
    expect((await refused(`DELETE FROM product WHERE key = $1`, [k])).code).toBe('42501');
    expect((await refused(`TRUNCATE product CASCADE`)).code).toBe('42501');
  });

  it('component: unique key per product, the same key allowed in another product; bounded kinds (no tauri, no ai yet); kind immutable', async () => {
    const p1 = await product();
    const p2 = await product();
    await app(`INSERT INTO component ("productId", key, kind) VALUES ($1, 'admin-web', 'web')`, [p1]);
    expect((await refused(`INSERT INTO component ("productId", key, kind) VALUES ($1, 'admin-web', 'desktop')`, [p1])).constraint).toBe('component_product_key_unique');
    await app(`INSERT INTO component ("productId", key, kind) VALUES ($1, 'admin-web', 'web')`, [p2]); // no cross-product collision
    for (const kind of ['backend', 'web', 'desktop', 'mobile_ios', 'mobile_android']) await component(kind, p1);
    for (const kind of ['tauri', 'ai', 'mobile', 'ios', 'Web', '']) {
      expect((await refused(`INSERT INTO component ("productId", key, kind) VALUES ($1, $2, $3)`, [p1, key('k'), kind])).constraint, kind).toBe('component_kind_valid');
    }
    expect((await refused(`UPDATE component SET kind = 'desktop' WHERE "productId" = $1 AND key = 'admin-web'`, [p1])).code).toBe('42501');
    expect((await refused(`DELETE FROM component WHERE "productId" = $1`, [p1])).code).toBe('42501');
    expect((await refused(`INSERT INTO component ("productId", key, kind) VALUES (gen_random_uuid(), 'x', 'web')`)).code).toBe('23503');
  });

  // ─────────────────────────────────────────────────────────────── release

  it('release: canonical SemVer only; unique per component (the same version in another component is fine)', async () => {
    const c1 = await component();
    const c2 = await component();
    await release(c1, '1.0.0');
    expect((await refused(`INSERT INTO release ("componentId", version) VALUES ($1, '1.0.0')`, [c1])).constraint).toBe('release_component_version_unique');
    await release(c2, '1.0.0');
    for (const bad of ['v1.0.0', '1.0', '01.0.0', '1.0.0+build.7', '1.0.0-01', 'latest', '1.0.0 ', '1000000000000000.0.0']) {
      expect((await refused(`INSERT INTO release ("componentId", version) VALUES ($1, $2)`, [c1, bad])).constraint, bad).toBe('release_version_semver');
    }
    expect((await refused(`INSERT INTO release ("componentId", version, "buildId") VALUES ($1, '9.0.0', 'has space')`, [c1])).constraint).toBe('release_build_id_shape');
    expect((await refused(`INSERT INTO release ("componentId", version, "sourceRevision") VALUES ($1, '9.0.1', 'NOT-A-SHA')`, [c1])).constraint).toBe('release_source_revision_shape');
    const [row] = await app(`SELECT major, minor, patch, prerelease FROM release WHERE "componentId" = $1 AND version = '1.0.0'`, [c1]);
    expect(row).toEqual({ major: '1', minor: '0', patch: '0', prerelease: null });
  });

  it('release shapes ACCEPT their valid values at the bounds (Stage 20.3, 0002: the 0001 notes-reference check could never be evaluated)', async () => {
    const c = await component();
    const ok = { buildId: 'b'.repeat(128), sourceRevision: 'a'.repeat(64), notesRef: 'n'.repeat(512) };
    await app(`INSERT INTO release ("componentId", version, "buildId", "sourceRevision", "notesRef") VALUES ($1, '1.0.0', $2, $3, $4)`, [c, ok.buildId, ok.sourceRevision, ok.notesRef]);
    await app(`INSERT INTO release ("componentId", version, "buildId", "sourceRevision", "notesRef") VALUES ($1, '1.0.1', '1', 'abcdef1', 'https://notes.example/1.0.1')`, [c]);
    expect((await app(`SELECT count(*)::int AS n FROM release WHERE "componentId" = $1`, [c]))[0]!.n).toBe(2);
    for (const bad of ['n'.repeat(513), '', 'has space', 'tab\there', 'é']) {
      expect((await refused(`INSERT INTO release ("componentId", version, "notesRef") VALUES ($1, '2.0.0', $2)`, [c, bad])).constraint, JSON.stringify(bad)).toBe('release_notes_ref_shape');
    }
    expect((await refused(`INSERT INTO release ("componentId", version, "buildId") VALUES ($1, '2.0.0', $2)`, [c, 'b'.repeat(129)])).constraint).toBe('release_build_id_shape');
    expect((await refused(`INSERT INTO release ("componentId", version, "sourceRevision") VALUES ($1, '2.0.0', $2)`, [c, 'a'.repeat(65)])).constraint).toBe('release_source_revision_shape');
  });

  it('release: born registered; the identity never changes (version, build, revision, notes, component), whatever the status', async () => {
    const c = await component();
    expect((await refused(`INSERT INTO release ("componentId", version, status, "publishedAt") VALUES ($1, '1.0.0', 'published', now())`, [c])).code).toBe('23514');
    const id = await release(c, '1.0.0');
    for (const [col, value] of [['version', '1.0.1'], ['"buildId"', '42'], ['"sourceRevision"', 'abcdef1'], ['"notesRef"', 'notes://x'], ['"componentId"', await component()], ['"registeredAt"', '2020-01-01T00:00:00Z']]) {
      const e = await refused(`UPDATE release SET ${col} = $2 WHERE id = $1`, [id, value]);
      expect(e.message, col).toMatch(/immutable/);
    }
    await app(`UPDATE release SET status = 'published', "publishedAt" = now() WHERE id = $1`, [id]);
    expect((await refused(`UPDATE release SET "buildId" = '43' WHERE id = $1`, [id])).message).toMatch(/immutable/);
    expect((await refused(`UPDATE release SET version = '1.0.0-rc.1' WHERE id = $1`, [id])).message).toMatch(/immutable/);
  });

  it('release lifecycle: exactly registered → published → withdrawn; no reverse, no skip, no resurrection; never deleted', async () => {
    const c = await component();
    const r1 = await release(c, '1.0.0');
    // registered → withdrawn is not a transition of ADR-0051 (only a published release is withdrawn)
    expect((await refused(`UPDATE release SET status = 'withdrawn', "publishedAt" = now(), "withdrawnAt" = now() WHERE id = $1`, [r1])).message).toMatch(/lifecycle/);
    await app(`UPDATE release SET status = 'published', "publishedAt" = now() WHERE id = $1`, [r1]);
    expect((await refused(`UPDATE release SET status = 'registered', "publishedAt" = NULL WHERE id = $1`, [r1])).message).toMatch(/lifecycle/);
    expect((await refused(`UPDATE release SET "publishedAt" = now() - interval '1 day' WHERE id = $1`, [r1])).code).toBe('23514'); // same status is no move
    await app(`UPDATE release SET status = 'withdrawn', "withdrawnAt" = now() WHERE id = $1`, [r1]);
    for (const back of [`status = 'published', "withdrawnAt" = NULL`, `status = 'registered', "publishedAt" = NULL, "withdrawnAt" = NULL`]) {
      expect((await refused(`UPDATE release SET ${back} WHERE id = $1`, [r1])).message).toMatch(/lifecycle/);
    }
    expect((await refused(`UPDATE release SET status = 'draft' WHERE id = $1`, [r1])).code).toBe('23514');
    expect((await refused(`DELETE FROM release WHERE id = $1`, [r1])).code).toBe('42501');
    expect((await refused(`TRUNCATE release`)).code).toBe('42501');
    // timestamps must agree with the status
    const r2 = await release(c, '1.1.0');
    expect((await refused(`UPDATE release SET status = 'published' WHERE id = $1`, [r2])).constraint).toBe('release_status_timestamps');
  });

  it('latest: the highest published, not-withdrawn release without a pre-release tag (registered-only and withdrawn never count)', async () => {
    const c = await component();
    expect(await latest(c)).toBeUndefined(); // nothing published yet
    await release(c, '1.0.0', 'published');
    await release(c, '1.1.0', 'published');
    await release(c, '1.10.0', 'registered'); // numerically highest, but only registered
    await release(c, '2.0.0-beta.1', 'published'); // pre-release: never latest
    expect(await latest(c)).toBe('1.1.0');
    await release(c, '1.9.0', 'published');
    expect(await latest(c)).toBe('1.9.0'); // numeric, not lexical (1.9.0 > 1.1.0; 1.10.0 is not published)
    await release(c, '2.0.0', 'withdrawn');
    expect(await latest(c)).toBe('1.9.0'); // withdrawn never counts
    const plan = await app(`EXPLAIN SELECT version FROM release WHERE "componentId" = $1 AND status = 'published' AND prerelease IS NULL ORDER BY major DESC, minor DESC, patch DESC LIMIT 1`, [c]);
    expect(JSON.stringify(plan)).toMatch(/release_latest_idx|Seq Scan/); // the partial index serves it once the table grows
  });

  // ─────────────────────────────────────────────────────────────── compatibility policy

  it('policy: client components only; versions 1, 2, 3 … (a stale version is refused); a stable minimum; append-only', async () => {
    const backend = await component('backend');
    await release(backend, '1.0.0', 'published');
    expect((await refused(`INSERT INTO compatibility_policy ("componentId", "policyVersion", "minimumVersion") VALUES ($1, 1, '1.0.0')`, [backend])).message).toMatch(/backend/);
    const c = await component('mobile_ios');
    await release(c, '1.0.0', 'published');
    await release(c, '2.0.0', 'published');
    expect((await refused(`INSERT INTO compatibility_policy ("componentId", "policyVersion", "minimumVersion") VALUES ($1, 2, '1.0.0')`, [c])).code).toBe('40001'); // must be 1
    await policy(c, 1, '1.0.0');
    expect((await refused(`INSERT INTO compatibility_policy ("componentId", "policyVersion", "minimumVersion") VALUES ($1, 1, '2.0.0')`, [c])).code).toBe('40001'); // stale
    await policy(c, 2, '2.0.0');
    for (const bad of ['2.0.0-rc.1', 'v2.0.0', '2.0']) {
      expect((await refused(`INSERT INTO compatibility_policy ("componentId", "policyVersion", "minimumVersion") VALUES ($1, 3, $2)`, [c, bad])).constraint, bad).toBe('compatibility_policy_minimum_stable');
    }
    expect((await refused(`UPDATE compatibility_policy SET "minimumVersion" = '1.0.0' WHERE "componentId" = $1`, [c])).code).toBe('42501');
    expect((await refused(`DELETE FROM compatibility_policy WHERE "componentId" = $1`, [c])).code).toBe('42501');
    expect((await refused(`TRUNCATE compatibility_policy`)).code).toBe('42501');
    expect((await app(`SELECT "policyVersion", "minimumVersion" FROM compatibility_policy WHERE "componentId" = $1 ORDER BY 1`, [c])).map((r) => [r.policyVersion, r.minimumVersion]))
      .toEqual([[1, '1.0.0'], [2, '2.0.0']]); // history preserved
  });

  it('minimum ≤ latest: a minimum above the latest (or with no published release) is refused; equal to it is accepted', async () => {
    const c = await component('desktop');
    expect((await refused(`INSERT INTO compatibility_policy ("componentId", "policyVersion", "minimumVersion") VALUES ($1, 1, '1.0.0')`, [c])).message).toMatch(/minimum version/);
    await release(c, '1.0.0', 'published');
    await release(c, '1.5.0', 'registered');
    await release(c, '2.0.0-rc.1', 'published');
    expect((await refused(`INSERT INTO compatibility_policy ("componentId", "policyVersion", "minimumVersion") VALUES ($1, 1, '1.5.0')`, [c])).message).toMatch(/minimum version/); // registered only
    expect((await refused(`INSERT INTO compatibility_policy ("componentId", "policyVersion", "minimumVersion") VALUES ($1, 1, '2.0.0')`, [c])).message).toMatch(/minimum version/); // only a pre-release above
    await policy(c, 1, '1.0.0');
  });

  it('minimum ≤ latest: a withdrawal that would leave the minimum above the new latest is refused; lowering the minimum first allows it', async () => {
    const c = await component('mobile_android');
    await release(c, '1.0.0', 'published');
    const r2 = await release(c, '2.0.0', 'published');
    await policy(c, 1, '2.0.0');
    expect((await refused(`UPDATE release SET status = 'withdrawn', "withdrawnAt" = now() WHERE id = $1`, [r2])).message).toMatch(/minimum version/);
    await policy(c, 2, '1.0.0');
    await app(`UPDATE release SET status = 'withdrawn', "withdrawnAt" = now() WHERE id = $1`, [r2]);
    expect(await latest(c)).toBe('1.0.0');
    // withdrawing a release that is not the latest never breaks the invariant
    const r3 = await release(c, '0.9.0', 'published');
    await app(`UPDATE release SET status = 'withdrawn', "withdrawnAt" = now() WHERE id = $1`, [r3]);
  });

  it('no write skew: a concurrent policy change and withdrawal of the same component are serialized, so both can never commit into a broken state', async () => {
    const c = await component('web');
    await release(c, '1.0.0', 'published');
    const r2 = await release(c, '2.0.0', 'published');
    const a = new pg.Client({ connectionString: d.appUrl });
    const b = new pg.Client({ connectionString: d.appUrl });
    await a.connect();
    await b.connect();
    try {
      await a.query('BEGIN');
      await a.query(`INSERT INTO compatibility_policy ("componentId", "policyVersion", "minimumVersion") VALUES ($1, 1, '2.0.0')`, [c]); // holds the component lock
      await b.query('BEGIN');
      const withdrawal = b.query(`UPDATE release SET status = 'withdrawn', "withdrawnAt" = now() WHERE id = $1`, [r2]).then(() => 'withdrawn', (e: { message: string }) => e.message);
      await new Promise((r) => setTimeout(r, 300)); // b is now waiting on a's lock
      await a.query('COMMIT');
      expect(await withdrawal).toMatch(/minimum version/); // b re-checked AFTER a's commit and refused
      await b.query('ROLLBACK');
    } finally {
      await a.end();
      await b.end();
    }
    expect(await latest(c)).toBe('2.0.0');
  });
});
