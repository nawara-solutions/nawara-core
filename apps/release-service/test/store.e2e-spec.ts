import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { releaseMigrationsDir } from '../src/app.module.js';
import type { ComponentKind } from '../src/domain/model.js';
import { ReleaseStoreError } from '../src/persistence/persistence-error.js';
import { ReleaseStore } from '../src/persistence/release-store.js';
import { createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Stage 20.2: the persistence primitives later stages build on (registration and publication in 20.3, withdrawal and policy in 20.4,
 * the decision read in 20.5), through the real module graph as the runtime role. Refusals are bounded codes, never database text.
 */
describeWithEnv('release-service persistence primitives (real PostgreSQL, runtime role)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  let store: ReleaseStore;
  let n = 0;
  const component = async (kind: ComponentKind = 'web') => {
    const p = await store.ensureProduct(`prod-${n++}`);
    return store.ensureComponent(p.id, `comp-${n++}`, kind);
  };
  const identity = (componentId: string, version: string, over: Partial<{ buildId: string | null; sourceRevision: string | null; notesRef: string | null }> = {}) =>
    ({ componentId, version, buildId: null, sourceRevision: null, notesRef: null, ...over });
  const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof ReleaseStoreError ? e.code : `unexpected:${String(e)}`));
  const published = async (componentId: string, version: string) => {
    const r = await store.registerRelease(identity(componentId, version));
    return (await store.publishRelease(r.release.id)).release;
  };

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'relstore');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, releaseMigrationsDir]);
    t = await createTestApp({ databaseUrl: d.appUrl });
    store = t.app.get(ReleaseStore);
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
  });

  it('products and components: idempotent by key; a different kind for an existing component is a conflict; bad input is `invalid`', async () => {
    const p = await store.ensureProduct('same-product');
    expect((await store.ensureProduct('same-product')).id).toBe(p.id);
    expect((await store.findProduct('same-product'))?.id).toBe(p.id);
    expect(await store.findProduct('missing')).toBeNull();
    const c = await store.ensureComponent(p.id, 'student-app', 'mobile_ios');
    expect((await store.ensureComponent(p.id, 'student-app', 'mobile_ios')).id).toBe(c.id);
    expect(await code(store.ensureComponent(p.id, 'student-app', 'mobile_android'))).toBe('conflict');
    expect((await store.findComponent('same-product', 'student-app'))?.kind).toBe('mobile_ios');
    expect(await code(store.ensureProduct('Bad Key'))).toBe('invalid');
    expect(await code(store.ensureComponent(p.id, 'x', 'tauri' as ComponentKind))).toBe('invalid');
    expect(await code(store.ensureComponent('00000000-0000-4000-8000-000000000000', 'x', 'web'))).toBe('not_found');
  });

  it('registration: once per (component, version); the same identity again is idempotent; a different identity is a conflict', async () => {
    const c = await component('desktop');
    const first = await store.registerRelease(identity(c.id, '1.2.0', { buildId: '1200', sourceRevision: 'abcdef1234' }));
    expect(first).toMatchObject({ created: true, release: { status: 'registered', version: '1.2.0', buildId: '1200', publishedAt: null } });
    const again = await store.registerRelease(identity(c.id, '1.2.0', { buildId: '1200', sourceRevision: 'abcdef1234' }));
    expect(again).toMatchObject({ created: false, release: { id: first.release.id } });
    expect(await code(store.registerRelease(identity(c.id, '1.2.0', { buildId: '1201' })))).toBe('conflict');
    for (const bad of ['v1.2.0', '1.2', '1.2.0+7']) expect(await code(store.registerRelease(identity(c.id, bad))), bad).toBe('invalid');
    expect(await code(store.registerRelease(identity(c.id, '1.3.0', { buildId: 'with space' })))).toBe('invalid');
  });

  it('Stage 20.3: concurrent FIRST creation of one product and one component, each in its own transaction, yields one row each and every caller gets it', async () => {
    // A concurrent insert makes `ON CONFLICT DO NOTHING` return no row; the committed row must then be read by a NEW statement.
    const productKey = `racer-${n++}`;
    const products = await Promise.all(Array.from({ length: 8 }, () => store.tx((q) => store.ensureProduct(productKey, q))));
    expect(new Set(products.map((p) => p?.id)).size).toBe(1);
    expect(products.every((p) => p?.key === productKey)).toBe(true);
    const components = await Promise.all(Array.from({ length: 8 }, () => store.tx((q) => store.ensureComponent(products[0]!.id, 'racer-app', 'web', q))));
    expect(new Set(components.map((c) => c?.id)).size).toBe(1);
    expect(components.every((c) => c?.kind === 'web')).toBe(true);
  });

  it('concurrent registrations of one version produce exactly one release; the rest are idempotent', async () => {
    const c = await component('mobile_android');
    const results = await Promise.all(Array.from({ length: 8 }, () => store.registerRelease(identity(c.id, '3.0.0', { buildId: '300' }))));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.release.id)).size).toBe(1);
    expect((await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM release WHERE "componentId" = $1`, [c.id]))[0]!.n).toBe(1);
  });

  it('lifecycle primitives: publish and withdraw are state-idempotent; a withdrawn release is never republished; a registered one is never withdrawn', async () => {
    const c = await component();
    const r = (await store.registerRelease(identity(c.id, '1.0.0'))).release;
    expect(await code(store.withdrawRelease(r.id))).toBe('invalid_transition'); // registered → withdrawn is not in ADR-0051's lifecycle
    const p = await store.publishRelease(r.id);
    expect(p).toMatchObject({ changed: true, release: { status: 'published' } });
    expect(await store.publishRelease(r.id)).toMatchObject({ changed: false, release: { status: 'published', publishedAt: p.release.publishedAt } });
    await published(c.id, '1.1.0'); // keeps a latest after the withdrawal below
    const w = await store.withdrawRelease(r.id);
    expect(w).toMatchObject({ changed: true, release: { status: 'withdrawn' } });
    expect(await store.withdrawRelease(r.id)).toMatchObject({ changed: false });
    expect(await code(store.publishRelease(r.id))).toBe('invalid_transition');
    expect(await code(store.publishRelease('00000000-0000-4000-8000-000000000000'))).toBe('not_found');
  });

  it('latest: only published, not-withdrawn, non-pre-release; by SemVer precedence; native build ids never decide', async () => {
    const c = await component('mobile_ios');
    expect(await store.latestRelease(c.id)).toBeNull();
    // build ids that would sort the other way lexically or numerically: they must be ignored
    const a = await store.registerRelease(identity(c.id, '1.9.0', { buildId: '900' }));
    await store.publishRelease(a.release.id);
    const b = await store.registerRelease(identity(c.id, '1.10.0', { buildId: '1000' }));
    await store.publishRelease(b.release.id);
    const beta = await store.registerRelease(identity(c.id, '2.0.0-beta.1', { buildId: '99999' }));
    await store.publishRelease(beta.release.id);
    await store.registerRelease(identity(c.id, '3.0.0')); // registered only
    expect((await store.latestRelease(c.id))?.version).toBe('1.10.0');
  });

  it('policy: optimistic versions (0 → 1 → 2); a stale expectation is `policy_conflict`; minimum above latest is `invariant_violation`; backend is `invalid`', async () => {
    const c = await component('web');
    await published(c.id, '1.0.0');
    await published(c.id, '2.0.0');
    expect(await store.currentPolicy(c.id)).toBeNull();
    expect(await store.appendPolicy(c.id, 0, '1.0.0')).toMatchObject({ policyVersion: 1, minimumVersion: '1.0.0' });
    expect(await code(store.appendPolicy(c.id, 0, '2.0.0'))).toBe('policy_conflict'); // someone else changed it first
    expect(await store.appendPolicy(c.id, 1, '2.0.0')).toMatchObject({ policyVersion: 2 });
    expect(await code(store.appendPolicy(c.id, 2, '3.0.0'))).toBe('invariant_violation');
    expect(await code(store.appendPolicy(c.id, 2, '2.0.0-rc.1'))).toBe('invalid');
    expect((await store.currentPolicy(c.id))?.minimumVersion).toBe('2.0.0');
    const backend = await component('backend');
    await published(backend.id, '1.0.0');
    expect(await code(store.appendPolicy(backend.id, 0, '1.0.0'))).toBe('invalid');
  });

  it('two concurrent policy changes from the same expectation: exactly one wins, the other is `policy_conflict`', async () => {
    const c = await component('desktop');
    await published(c.id, '1.0.0');
    await published(c.id, '1.1.0');
    const outcomes = await Promise.all(['1.0.0', '1.1.0'].map((m) => code(store.appendPolicy(c.id, 0, m))));
    expect(outcomes.sort()).toEqual(['ok', 'policy_conflict']);
    expect((await store.currentPolicy(c.id))?.policyVersion).toBe(1);
  });

  it('a withdrawal that would break the minimum is `invariant_violation` and changes nothing; in one transaction with a lower minimum it passes', async () => {
    const c = await component('mobile_android');
    await published(c.id, '1.0.0');
    const top = await published(c.id, '2.0.0');
    await store.appendPolicy(c.id, 0, '2.0.0');
    expect(await code(store.withdrawRelease(top.id))).toBe('invariant_violation');
    expect((await store.findRelease(c.id, '2.0.0'))?.status).toBe('published');
    await store.tx(async (q) => {
      await store.appendPolicy(c.id, 1, '1.0.0', q);
      await store.withdrawRelease(top.id, q);
    });
    expect((await store.latestRelease(c.id))?.version).toBe('1.0.0');
  });
});
