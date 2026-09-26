import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type EventBus, type EventEnvelope } from '@nawara/service-kit';
import { releaseMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/** A broker the test can take down and bring back: while down every publish fails, as a real outage would. */
class SwitchableBus implements EventBus {
  up = false;
  readonly published: EventEnvelope[] = [];
  async publish(event: EventEnvelope): Promise<void> {
    if (!this.up) throw new Error('broker unavailable (test)');
    this.published.push(event);
  }
  async subscribe(): Promise<{ close(): Promise<void> }> {
    throw new Error('release-service consumes nothing');
  }
  async close(): Promise<void> {}
}

/**
 * Stage 20.3: the audit intent leaves release-service only through the kit outbox relay, after COMMIT. A broker (and therefore
 * audit-service) outage never fails, delays or undoes a registration or publication: the committed intent waits in the outbox and the
 * relay delivers it when the broker returns (at least once; audit-service deduplicates by (source, event id)).
 */
describeWithEnv('release-service audit relay: broker outage after commit (real PostgreSQL, runtime role)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  const bus = new SwitchableBus();
  const ci = generateServiceToken();

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'relrelay');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, releaseMigrationsDir]);
    t = await createTestApp({
      databaseUrl: d.appUrl, bus,
      env: { SERVICE_TOKENS: `drive-ci:${ci.digest}`, RELEASE_SERVICE_POLICY: JSON.stringify({ callers: { 'drive-ci': { products: { drive: ['release.register', 'release.publish'] } } } }) },
    });
    await t.app.listen(0, '127.0.0.1'); // bootstraps the relay, as in production
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
  });

  it('broker down: registration and publication still commit (201 / 200); the intent is durable and pending; when the broker returns the relay delivers each event exactly as recorded', async () => {
    const auth = { authorization: `Bearer ${ci.token}`, 'x-correlation-id': 'relay-outage-0001' };
    const path = '/release/products/drive/components/web-app/releases';
    const r = await request(t.app.getHttpServer()).post(path).set(auth).send({ kind: 'web', version: '1.0.0' });
    expect(r.status).toBe(201);
    expect((await request(t.app.getHttpServer()).post(`${path}/1.0.0/publish`).set(auth)).status).toBe(200);
    expect((await sql(d.adminUrl, `SELECT status FROM release WHERE id = $1`, [r.body.id]))[0]).toEqual({ status: 'published' });

    // The relay keeps trying and failing; nothing is lost and the domain state is untouched.
    await expect.poll(async () => (await sql<{ attempts: number }>(d.adminUrl, `SELECT min(attempts)::int AS attempts FROM outbox`))[0]!.attempts, { timeout: 10_000 }).toBeGreaterThan(0);
    const pending = await sql<{ name: string; publishedAt: Date | null }>(d.adminUrl, `SELECT name, "publishedAt" FROM outbox ORDER BY "occurredAt", id`);
    expect(pending).toEqual([{ name: 'audit.release.registered', publishedAt: null }, { name: 'audit.release.published', publishedAt: null }]);
    expect(t.logs.some((l) => String(l.msg).startsWith('outbox_publish_failure'))).toBe(true);
    expect(bus.published).toEqual([]);

    // Recovery: the backoff is honoured (no reset needed); both rows are delivered and marked.
    bus.up = true;
    await expect.poll(async () => (await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`))[0]!.n, { timeout: 30_000, interval: 250 }).toBe(0);
    const rows = await sql<{ id: string; payload: unknown }>(d.adminUrl, `SELECT id, payload FROM outbox ORDER BY "occurredAt", id`);
    expect(bus.published.map((e) => [e.id, e.name, e.headers.source, e.headers.correlationId])).toEqual([
      [rows[0]!.id, 'audit.release.registered', 'release-service', 'relay-outage-0001'],
      [rows[1]!.id, 'audit.release.published', 'release-service', 'relay-outage-0001'],
    ]);
    expect(bus.published.map((e) => e.payload)).toEqual(rows.map((x) => x.payload));
    expect((await sql(d.adminUrl, `SELECT status FROM release WHERE id = $1`, [r.body.id]))[0]).toEqual({ status: 'published' }); // never rolled back
    expect(JSON.stringify(t.logs)).not.toContain(ci.token);
  });
});
