import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { APPS, PROHIBITED, deadDepth, resetAuditQueues, sql, startAudit, type LiveAudit } from './support/audit.js';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 18.7.2: REAL Billing (HTTP) → its outbox (same transaction as the change and its billing_transition row) → its kit relay → a REAL
 * RabbitMQ → a live audit-service. Catalog actions driven through Billing's own routes: product, price, invoice issue, payment request.
 */
const BILLING_DIR = `${APPS}billing-service`;
const BILLING_PORT = 3873;
const AUDIT_PORT = 3874;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYER = '1a1a1a1a-0000-4000-8000-000000000001';

describeWithEnv('Billing → outbox → RabbitMQ → audit-service (all real)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let billingDb: TestDatabase;
  let billing: LiveService;
  let audit: LiveAudit;
  const producer = generateServiceToken();
  const post = async (path: string, body?: unknown) => {
    const r = await fetch(`${BILLING_URL}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${producer.token}`, 'content-type': 'application/json', 'x-correlation-id': 'billing-e2e-corr-01' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };

  beforeAll(async () => {
    await resetAuditQueues(env.TEST_RABBITMQ_URL);
    audit = await startAudit(env.TEST_DATABASE_ADMIN_URL, env.TEST_RABBITMQ_URL, AUDIT_PORT);
    billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingaudit');
    await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
    billing = spawnService('billing', BILLING_DIR, {
      NODE_ENV: 'test', PORT: String(BILLING_PORT), DATABASE_URL: billingDb.url, AUTH_SERVICE_URL: 'http://127.0.0.1:9', RABBITMQ_URL: env.TEST_RABBITMQ_URL,
      BILLING_SUPPORTED_CURRENCIES: 'TND', SERVICE_TOKENS: `test-producer:${producer.digest}`, PAYMENT_SERVICE_URL: 'http://127.0.0.1:9', PAYMENT_SERVICE_TOKEN: generateServiceToken().token,
      BILLING_DISPATCH_INTERVAL_MS: '300000', BILLING_RECONCILE_INTERVAL_MS: '3600000',
    });
    try {
      await waitForHealth(`${BILLING_URL}/health`, 30_000);
    } catch (e) {
      throw new Error(`${String(e)}\n${billing.tail()}`);
    }
  });
  afterAll(async () => {
    await billing?.stop();
    await audit?.stop();
    await billingDb?.drop();
    await audit?.db.drop();
  });

  it('product.created, price.created, invoice.issued and payment_request.created reach audit_record with the persisted organization and the service actor', async () => {
    const org = crypto.randomUUID();
    const product = await post('/billing/products', { seller: { type: 'organization', id: org }, code: `p-${org.slice(0, 6)}`, name: 'Not In Audit' });
    expect(product.status).toBe(201);
    const price = await post('/billing/prices', { productId: product.body.id, clientReference: 'r1', currency: 'TND', unitAmount: 2500, interval: 'one_time', effectiveFrom: new Date().toISOString() });
    expect(price.status).toBe(201);
    const invoice = await post('/billing/invoices', {
      invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: org }, payer: { type: 'user', id: PAYER }, sourceType: 'contract', sourceId: 'c-1',
      issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: price.body.id, quantity: 2 }],
    });
    expect(invoice.status).toBe(201);
    expect((await post(`/billing/invoices/${invoice.body.id}/issue`)).status).toBe(200);
    const pr = await post(`/billing/invoices/${invoice.body.id}/payment-requests`);
    expect(pr.status).toBe(201);

    await waitFor(async () => (await audit.records(`"sourceService" = 'billing-service' AND "organizationId" = $1`, [org])).length === 4, 30_000, 'four billing records');
    const rows = await audit.records(`"sourceService" = 'billing-service' AND "organizationId" = $1`, [org]);
    const by = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(Object.keys(by).sort()).toEqual(['invoice.issued', 'payment_request.created', 'price.created', 'product.created']);
    for (const r of rows) expect(r).toMatchObject({ actorType: 'service', actorId: 'test-producer', userKind: null, outcome: 'succeeded', correlationId: 'billing-e2e-corr-01' });
    expect(by['product.created']).toMatchObject({ category: 'administrative', resourceType: 'product', resourceId: product.body.id, changes: null });
    expect(by['price.created']).toMatchObject({ resourceId: price.body.id, changes: { product_id: product.body.id } });
    expect(by['invoice.issued']).toMatchObject({ category: 'commercial', resourceId: invoice.body.id });
    expect(by['payment_request.created']).toMatchObject({ resourceId: pr.body.id, changes: { invoice_id: invoice.body.id } });
    // The outbox payloads themselves: identifiers and codes only.
    const payloads = await sql(billingDb.url, `SELECT payload FROM outbox WHERE name LIKE 'audit.%'`);
    for (const p of payloads) for (const re of PROHIBITED) expect(JSON.stringify(p.payload)).not.toMatch(re);
    for (const p of payloads) expect(JSON.stringify(p.payload)).not.toMatch(/Not In Audit|2500|5000|TND/);
    expect(await deadDepth(env.TEST_RABBITMQ_URL)).toBe(0);
  });

  it('a relay re-publish of a Billing audit event is absorbed: still one record', async () => {
    const org = crypto.randomUUID();
    const product = await post('/billing/products', { seller: { type: 'organization', id: org }, code: `q-${org.slice(0, 6)}`, name: 'N' });
    await waitFor(async () => (await audit.records(`"resourceId" = $1`, [product.body.id])).length === 1, 30_000, 'first');
    await sql(billingDb.url, `ALTER TABLE outbox DISABLE TRIGGER outbox_immutable`);
    await sql(billingDb.url, `UPDATE outbox SET "publishedAt" = NULL WHERE name = 'audit.product.created' AND payload->'resource'->>'id' = $1`, [product.body.id]);
    await sql(billingDb.url, `ALTER TABLE outbox ENABLE TRIGGER outbox_immutable`);
    await waitFor(async () => (await sql(billingDb.url, `SELECT "publishedAt" FROM outbox WHERE name = 'audit.product.created' AND payload->'resource'->>'id' = $1`, [product.body.id]))[0]!.publishedAt !== null, 30_000, 're-published');
    await new Promise((r) => setTimeout(r, 1500));
    expect(await audit.records(`"resourceId" = $1`, [product.body.id])).toHaveLength(1);
  });
});
