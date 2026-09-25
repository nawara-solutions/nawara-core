import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { BrokerProxy, createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { APPS, PROHIBITED, deadDepth, resetAuditQueues, sql, startAudit, type LiveAudit } from './support/audit.js';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 18.7.1: REAL Payment → its outbox (same transaction) → its kit relay → a REAL RabbitMQ → a live audit-service → audit_record →
 * the Stage 18.6 query API. Payment talks to the broker through the kit's `BrokerProxy`, so the broker can be cut for Payment alone.
 */
const PAYMENT_DIR = `${APPS}payment-service`;
const PAYMENT_PORT = 3871;
const AUDIT_PORT = 3872;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;

describeWithEnv('Payment → outbox → RabbitMQ → audit-service (all real)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let paymentDb: TestDatabase;
  let payment: LiveService;
  let audit: LiveAudit;
  let proxy: BrokerProxy;
  const billing = generateServiceToken();

  const newPayment = async () => {
    const organizationId = crypto.randomUUID();
    const r = await fetch(`${PAYMENT_URL}/payment/payments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${billing.token}`, 'content-type': 'application/json', 'x-correlation-id': `e2e-${organizationId.slice(0, 8)}` },
      body: JSON.stringify({ paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: 'inv-1', payer: { type: 'user', id: 'payer-1' },
        seller: { type: 'organization', id: organizationId }, organizationId, amount: 1500, currency: 'TND' }),
    });
    expect(r.status).toBe(201);
    return { id: ((await r.json()) as { id: string }).id, organizationId };
  };
  const outboxAudit = (paymentId: string) =>
    sql(paymentDb.url, `SELECT id, name, payload, "correlationId", "occurredAt", "publishedAt" FROM outbox WHERE name LIKE 'audit.%' AND payload->'resource'->>'id' = $1`, [paymentId]);

  beforeAll(async () => {
    await resetAuditQueues(env.TEST_RABBITMQ_URL);
    audit = await startAudit(env.TEST_DATABASE_ADMIN_URL, env.TEST_RABBITMQ_URL, AUDIT_PORT);
    paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymentaudit');
    await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
    const target = new URL(env.TEST_RABBITMQ_URL);
    proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
    payment = spawnService('payment', PAYMENT_DIR, {
      NODE_ENV: 'test', PORT: String(PAYMENT_PORT), DATABASE_URL: paymentDb.url, AUTH_SERVICE_URL: 'http://127.0.0.1:9', RABBITMQ_URL: proxy.url,
      PAYMENT_SUPPORTED_CURRENCIES: 'TND', SERVICE_TOKENS: `billing-service:${billing.digest}`,
    });
    try {
      await waitForHealth(`${PAYMENT_URL}/health`, 30_000);
    } catch (e) {
      throw new Error(`${String(e)}\n${payment.tail()}`);
    }
  });
  afterAll(async () => {
    await payment?.stop();
    await audit?.stop();
    await proxy?.sever();
    await paymentDb?.drop();
    await audit?.db.drop();
  });

  it('payment.created reaches audit_record exactly as the outbox recorded it (source, event id, time, correlation, evidence)', async () => {
    const p = await newPayment();
    await waitFor(async () => (await audit.records(`"resourceId" = $1`, [p.id])).length === 1, 30_000, 'audit record');
    const [row] = await audit.records(`"resourceId" = $1`, [p.id]);
    const [ob] = await outboxAudit(p.id);
    expect(row).toMatchObject({
      eventId: ob!.id, sourceService: 'payment-service', action: 'payment.created', category: 'commercial', schemaVersion: 1,
      actorType: 'service', actorId: 'billing-service', userKind: null, organizationId: p.organizationId, resourceType: 'payment', resourceId: p.id,
      subjectType: null, outcome: 'succeeded', changes: null, correlationId: ob!.correlationId,
    });
    expect((row!.occurredAt as Date).getTime()).toBe(Math.floor((ob!.occurredAt as Date).getTime()));
    for (const re of PROHIBITED) expect(JSON.stringify(ob!.payload)).not.toMatch(re);
  });

  it('a relay re-publish of the same outbox row is absorbed: still one audit record', async () => {
    const p = await newPayment();
    await waitFor(async () => (await audit.records(`"resourceId" = $1`, [p.id])).length === 1, 30_000, 'first delivery');
    const [ob] = await outboxAudit(p.id);
    await sql(paymentDb.url, `ALTER TABLE outbox DISABLE TRIGGER outbox_immutable`);
    await sql(paymentDb.url, `UPDATE outbox SET "publishedAt" = NULL WHERE id = $1`, [ob!.id]);
    await sql(paymentDb.url, `ALTER TABLE outbox ENABLE TRIGGER outbox_immutable`);
    await waitFor(async () => (await outboxAudit(p.id))[0]!.publishedAt !== null, 30_000, 're-publish');
    await new Promise((r) => setTimeout(r, 1500));
    expect(await audit.records(`"resourceId" = $1`, [p.id])).toHaveLength(1);
    expect(await deadDepth(env.TEST_RABBITMQ_URL)).toBe(0);
  });

  it('AUDIT SERVICE DOWN: the payment and its audit intent commit, the relay publishes into the durable queue; audit-service stores it once when back', async () => {
    await audit.stop();
    const p = await newPayment(); // the business request does not depend on audit-service
    await waitFor(async () => (await outboxAudit(p.id))[0]?.publishedAt != null, 30_000, 'relay published while audit is down');
    expect(await audit.records(`"resourceId" = $1`, [p.id])).toHaveLength(0);
    await audit.start();
    await waitFor(async () => (await audit.records(`"resourceId" = $1`, [p.id])).length === 1, 30_000, 'stored after restart');
  });

  it('RABBITMQ DOWN (for Payment): the payment still commits with its audit intent pending; when the broker returns the relay delivers it, once', async () => {
    await proxy.sever();
    const p = await newPayment();
    await new Promise((r) => setTimeout(r, 1500));
    expect((await outboxAudit(p.id))[0]!.publishedAt).toBeNull(); // durable, unpublished
    await proxy.start();
    await waitFor(async () => (await audit.records(`"resourceId" = $1`, [p.id])).length === 1, 60_000, 'delivered after the broker returned');
    await new Promise((r) => setTimeout(r, 1000));
    expect(await audit.records(`"resourceId" = $1`, [p.id])).toHaveLength(1);
  });

  it('the evidence is readable through the 18.6 API: the organization reader sees it in its organization; a platform read is itself recorded', async () => {
    const p = await newPayment();
    await waitFor(async () => (await audit.records(`"resourceId" = $1`, [p.id])).length === 1, 30_000, 'stored');
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const org = await audit.get(`/audit/organizations/${p.organizationId}/records?from=${from}&to=${to}`, audit.orgReader.token);
    expect(org.status).toBe(200);
    expect(org.body.items.map((i: { resource: { id: string } }) => i.resource.id)).toEqual([p.id]);
    const other = await audit.get(`/audit/organizations/${crypto.randomUUID()}/records?from=${from}&to=${to}`, audit.orgReader.token);
    expect(other.body.items).toEqual([]);
    const before = (await audit.records(`action = 'platform_query.executed'`)).length;
    const platform = await audit.get(`/audit/platform/records?from=${from}&to=${to}&sourceService=payment-service`, audit.platformReader.token);
    expect(platform.status).toBe(200);
    expect(platform.body.items.some((i: { resource: { id: string } }) => i.resource.id === p.id)).toBe(true);
    expect((await audit.records(`action = 'platform_query.executed'`)).length).toBe(before + 1);
  });
});
