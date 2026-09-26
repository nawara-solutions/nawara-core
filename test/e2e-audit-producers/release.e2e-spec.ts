import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { APPS, PROHIBITED, deadDepth, resetAuditQueues, sql, startAudit, type LiveAudit } from './support/audit.js';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 20.3: REAL release-service (HTTP, its dist build) → its outbox → its kit relay → a REAL RabbitMQ → a live audit-service →
 * audit_record → the 18.6 platform read: `release.registered` and `release.published` from CI automation (a service actor, platform-level),
 * once each however often CI retries; and audit-service being DOWN never fails a registration (the intent waits in the outbox).
 */
const RELEASE_DIR = `${APPS}release-service`;
const RELEASE_PORT = 3887;
const AUDIT_PORT = 3888;
const RELEASE_URL = `http://127.0.0.1:${RELEASE_PORT}`;

describeWithEnv('Release → outbox → RabbitMQ → audit-service (all real)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let releaseDb: TestDatabase;
  let release: LiveService;
  let audit: LiveAudit;
  const ci = generateServiceToken();

  const call = async (path: string, body?: unknown, correlation = 'release-e2e-corr-01') => {
    const r = await fetch(`${RELEASE_URL}${path}`, {
      method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${ci.token}`, 'content-type': 'application/json', 'x-correlation-id': correlation },
    });
    return { status: r.status, replayed: r.headers.get('idempotent-replayed'), body: (await r.json()) as Record<string, any> };
  };
  const releases = '/release/products/drive/components/mobile-app/releases';

  beforeAll(async () => {
    await resetAuditQueues(env.TEST_RABBITMQ_URL);
    audit = await startAudit(env.TEST_DATABASE_ADMIN_URL, env.TEST_RABBITMQ_URL, AUDIT_PORT);
    releaseDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ereleaseaudit');
    await runMigrations(releaseDb.url, [kitMigrationsDir, `${RELEASE_DIR}/db/migrations/`]);
    release = spawnService('release', RELEASE_DIR, {
      NODE_ENV: 'test', PORT: String(RELEASE_PORT), DATABASE_URL: releaseDb.url, RABBITMQ_URL: env.TEST_RABBITMQ_URL,
      SERVICE_TOKENS: `drive-ci:${ci.digest}`,
      RELEASE_SERVICE_POLICY: JSON.stringify({ callers: { 'drive-ci': { products: { drive: ['release.register', 'release.publish'] } } } }),
    });
    try {
      await waitForHealth(`${RELEASE_URL}/health`, 30_000);
    } catch (e) {
      throw new Error(`${String(e)}\n${release.tail()}`);
    }
  });
  afterAll(async () => {
    await release?.stop();
    await audit?.stop();
    await releaseDb?.drop();
    await audit?.db.drop();
  });

  it('registration and publication, each retried: exactly one release.registered and one release.published in audit_record, the CI service as actor, platform-level, readable on the platform read', async () => {
    const body = { kind: 'mobile_ios', version: '1.4.0', buildId: '1400', sourceRevision: 'a1b2c3d4e5f6', notesRef: 'https://notes.example/1.4.0' };
    const first = await call(releases, body);
    expect(first.status).toBe(201);
    expect((await call(releases, body)).replayed).toBe('true');
    expect((await call(`${releases}/1.4.0/publish`)).status).toBe(200);
    expect((await call(`${releases}/1.4.0/publish`)).replayed).toBe('true');
    const id = first.body.id as string;

    await waitFor(async () => (await audit.records(`"sourceService" = 'release-service' AND "resourceId" = $1`, [id])).length === 2, 30_000, 'two release records');
    await new Promise((r) => setTimeout(r, 1000));
    const rows = await audit.records(`"sourceService" = 'release-service' AND "resourceId" = $1`, [id]);
    expect(rows).toHaveLength(2);
    const [{ componentId }] = await sql<{ componentId: string }>(releaseDb.url, `SELECT "componentId" FROM release WHERE id = $1`, [id]);
    const [{ productId }] = await sql<{ productId: string }>(releaseDb.url, `SELECT "productId" FROM component WHERE id = $1`, [componentId]);
    for (const action of ['release.registered', 'release.published']) {
      expect(rows.find((r) => r.action === action)).toMatchObject({
        category: 'administrative', actorType: 'service', actorId: 'drive-ci', organizationId: null, resourceType: 'release', resourceId: id,
        outcome: 'succeeded', changes: { product_id: productId, component_id: componentId, kind: 'mobile_ios' }, correlationId: 'release-e2e-corr-01',
      });
    }
    for (const r of rows) {
      const text = JSON.stringify(r);
      for (const re of PROHIBITED) expect(text).not.toMatch(re);
      for (const leak of ['1.4.0', '1400', 'a1b2c3d4e5f6', 'notes.example', ci.token]) expect(text).not.toContain(leak);
    }

    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const platform = await audit.get(`/audit/platform/records?from=${from}&to=${to}&sourceService=release-service`, audit.platformReader.token);
    expect(platform.status).toBe(200);
    expect(platform.body.items.filter((i: { resource: { id: string } }) => i.resource.id === id)).toHaveLength(2);
    const org = await audit.get(`/audit/organizations/${crypto.randomUUID()}/records?from=${from}&to=${to}`, audit.orgReader.token);
    expect(org.body.items.filter((i: { resource: { id: string } }) => i.resource.id === id)).toEqual([]); // platform-level: in no organization
    expect(await deadDepth(env.TEST_RABBITMQ_URL)).toBe(0);
  });

  it('AUDIT-SERVICE DOWN: registration still commits (201) with its intent; when audit-service returns, the record arrives, once', async () => {
    await audit.stop();
    let restarted = false;
    try {
      const r = await call(releases, { kind: 'mobile_ios', version: '1.5.0' }, 'release-e2e-corr-02');
      expect(r.status).toBe(201);
      expect((await sql(releaseDb.url, `SELECT status FROM release WHERE id = $1`, [r.body.id]))[0]).toEqual({ status: 'registered' });
      await audit.start();
      restarted = true;
      await waitFor(async () => (await audit.records(`"resourceId" = $1`, [r.body.id])).length === 1, 30_000, 'delivered after audit-service returned');
      await new Promise((res) => setTimeout(res, 1000));
      expect(await audit.records(`"resourceId" = $1`, [r.body.id])).toHaveLength(1);
    } finally {
      if (!restarted) await audit.start().catch(() => undefined);
    }
  });
});
