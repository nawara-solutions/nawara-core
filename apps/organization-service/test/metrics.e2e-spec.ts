import { randomUUID } from 'node:crypto';
import { MetricsHost, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { organizationMigrationsDir } from '../src/app.module.js';
import { bearer, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

/**
 * V2 A12.2: a real generic service receives the metrics foundation through the kit's configureApp alone (no service code). Off by
 * default; when on, route templates only (no identifier or token in the exposition), probes excluded, no /metrics on the application.
 */
describeWithEnv('metrics through configureApp (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let on: TestApp;
  let off: TestApp;
  const companyId = randomUUID();
  const correlation = 'corr-org-seeded-6a3f';

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgmetrics');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    on = await createTestApp({ databaseUrl: db.url, env: { METRICS_ENABLED: 'true', METRICS_PORT: '0' } });
    off = await createTestApp({ databaseUrl: db.url, ownership: 'inactive' });
    await on.http().get(`/organization/companies/${companyId}`).set(bearer(on.callers['billing-service']!)).set('x-correlation-id', correlation);
    await on.http().get(`/organization/companies/${randomUUID()}`); // no token
    await on.http().get('/health').expect(200);
    await on.http().get('/ready').expect(200);
  });
  afterAll(async () => {
    await on?.app.close();
    await off?.app.close();
    await db?.drop();
  });

  async function scrape(): Promise<string> {
    const addr = await on.app.get(MetricsHost).address();
    if (!addr) throw new Error('the metrics listener is not running');
    return (await fetch(`http://127.0.0.1:${addr.port}/metrics`)).text();
  }

  it('is off by default', async () => {
    expect(off.app.get(MetricsHost).metrics).toBeUndefined();
    expect(await off.app.get(MetricsHost).address()).toBeUndefined();
  });

  it('labels requests by route template only, and never with an identifier or token', async () => {
    const body = await scrape();
    expect(body).toMatch(/nawara_http_server_requests_total\{method="GET",route="\/organization\/companies\/:id",status_class="4xx"\} 2/);
    expect(body).toContain('nawara_service_info{service="organization-service"} 1');
    expect(body).not.toContain(companyId);
    expect(body).not.toContain(correlation);
    expect(body).not.toContain(on.callers['billing-service']!);
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('probes are excluded from HTTP metrics; readiness metrics follow /ready (database, migrations)', async () => {
    const body = await scrape();
    expect(body).not.toMatch(/route="\/(health|ready)"/);
    expect(body).toMatch(/^nawara_readiness_ready 1$/m);
    expect(body).toMatch(/^nawara_readiness_check_up\{check="database"\} 1$/m);
    expect(body).toMatch(/^nawara_readiness_check_up\{check="migrations"\} 1$/m);
  });

  it('no metrics endpoint on the application port', async () => {
    for (const p of ['/metrics', '/organization/metrics']) expect((await on.http().get(p)).status, p).toBe(404);
  });
});
