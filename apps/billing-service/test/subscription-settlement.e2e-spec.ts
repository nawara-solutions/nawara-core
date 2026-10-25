import pg from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DbService, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { BillingAudit } from '../src/audit/billing-audit.js';
import { billingMigrationsDir } from '../src/app.module.js';
import type { TransitionContext } from '../src/domain/actors.js';
import { normaliseCreateInvoiceInput } from '../src/domain/invoice-input.js';
import { recordTransition } from '../src/domain/transitions.js';
import { InvoiceRepository } from '../src/invoices/invoice.repository.js';
import { PaymentRequestRepository } from '../src/invoices/payment-request.repository.js';
import { SubscriptionRepository } from '../src/subscriptions/subscription.repository.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { settle, subscriptionPrice } from './support/settlement.js';

/**
 * Core V2 S3b (ADR-0044 B3; S0 DB-9 to DB-11, S-4; register BIL-09): an Organization Subscription starts or extends a period only
 * through the verified settlement of an `organization_subscription` invoice, recorded as an append-only `subscription_settlement` in
 * the same transaction. These tests prove the settlement record, its evidence, its uniqueness and its atomicity on the real
 * application; the direct-SQL negative tests of DB-9 / DB-10 / DB-11 live in db/tests/invariants.sql.
 */
describeWithEnv('verified settlement activation (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let subs: SubscriptionRepository;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingsettle');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 6 });
    t = await createTestApp({ databaseUrl: db.url });
    subs = t.app.get(SubscriptionRepository);
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  const org = () => crypto.randomUUID();
  const settlements = (organizationId: string) =>
    admin.query(`SELECT s.*, r."eventName", r.outcome FROM subscription_settlement s JOIN payment_event_receipt r ON r.id = s."receiptId" WHERE s."organizationId" = $1 ORDER BY s."settledAt"`, [organizationId]).then((r) => r.rows);

  it('a verified settlement activates THAT Organization\'s Subscription and records its evidence: the routed invoice, the paid request, the applied payment.succeeded receipt', async () => {
    const organizationId = org();
    const { productId, priceId } = await subscriptionPrice(admin);
    const at = new Date('2030-03-15T09:30:00Z');
    const { application, subscription, invoiceId } = await settle(t.app, { organizationId, priceId, at });
    expect(application).toMatchObject({ outcome: 'applied', subscription: 'settled' });
    expect(subscription).toMatchObject({ status: 'active', organizationId, productId, priceId, currentPeriodStart: at });
    const [s] = await settlements(organizationId);
    expect(s).toMatchObject({ invoiceId, purpose: 'organization_subscription', organizationId, productId, subscriptionId: subscription!.id, settledAt: at, eventName: 'payment.succeeded', outcome: 'applied' });
    const evidence = (await admin.query(`SELECT pr.status AS request, i.status AS invoice FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" WHERE pr.id = $1`, [s.paymentRequestId])).rows[0];
    expect(evidence).toEqual({ request: 'paid', invoice: 'paid' });
  });

  it('every renewal is its own settlement (one per invoice); the period moves exactly once per settlement', async () => {
    const organizationId = org();
    const { priceId } = await subscriptionPrice(admin);
    await settle(t.app, { organizationId, priceId, at: new Date('2030-01-31T09:30:00Z') });
    await settle(t.app, { organizationId, priceId, at: new Date('2030-02-10T09:30:00Z') });
    const rows = await settlements(organizationId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.invoiceId)).size).toBe(2);
    expect((await subs.getByOrganization(organizationId)).currentPeriodEnd).toEqual(new Date('2030-03-31T09:30:00Z'));
  });

  it('a settlement replayed for the SAME invoice (a repeated application, a lost acknowledgement) extends nothing (DB-10)', async () => {
    const organizationId = org();
    const { productId, priceId } = await subscriptionPrice(admin);
    const { invoiceId, subscription } = await settle(t.app, { organizationId, priceId, at: new Date('2030-05-01T00:00:00Z') });
    const [s] = await settlements(organizationId);
    const ctx: TransitionContext = { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: 'replay' }, correlationId: 'replay' };
    const again = await t.app.get(DbService).tx((q) => subs.applySettlement(q, { organizationId, productId, priceId, settledAt: new Date('2030-05-20T00:00:00Z'), invoiceId, paymentRequestId: s.paymentRequestId, receiptId: s.receiptId }, ctx));
    expect(again.changed).toBe(false);
    expect(await subs.getByOrganization(organizationId)).toEqual(subscription);
    expect(await settlements(organizationId)).toHaveLength(1);
  });

  it('settlement is atomic with its period: a failure after it (the audit intent refused) leaves neither a settlement nor a period', async () => {
    const organizationId = org();
    const { priceId } = await subscriptionPrice(admin);
    const audit = t.app.get(BillingAudit);
    const original = audit.record.bind(audit);
    const spy = vi.spyOn(audit, 'record').mockImplementation((q, action, fact, ctx) => {
      if (action === 'subscription.activated') throw new Error('simulated audit failure');
      return original(q, action, fact, ctx);
    });
    try {
      await expect(settle(t.app, { organizationId, priceId, at: new Date('2030-06-01T00:00:00Z') })).rejects.toThrow('simulated audit failure');
    } finally {
      spy.mockRestore();
    }
    expect(await settlements(organizationId)).toEqual([]);
    const row = (await admin.query(`SELECT status, "currentPeriodStart" FROM subscription WHERE "organizationId" = $1`, [organizationId])).rows[0];
    expect(row === undefined || (row.status === 'pending' && row.currentPeriodStart === null)).toBe(true);
  });

  it('only a payment.succeeded applied from Payment settles: a failed, cancelled or expired payment, or an event from another source, settles nothing', async () => {
    const organizationId = org();
    const { priceId } = await subscriptionPrice(admin);
    // a genuine settlement first, so the Subscription exists; then non-settling outcomes on further invoices change nothing
    await settle(t.app, { organizationId, priceId, at: new Date('2030-07-01T00:00:00Z') });
    const before = await subs.getByOrganization(organizationId);
    const ctx: TransitionContext = { actor: { type: 'service', id: 'test-producer' }, cause: { type: 'request', id: 'x' }, correlationId: 'x' };
    for (const name of ['payment.failed', 'payment.cancelled', 'payment.expired', 'wrong-source'] as const) {
      const input = normaliseCreateInvoiceInput({
        invoiceRequestId: crypto.randomUUID(), seller: { type: 'company', id: 'nawara-test-seller' }, payer: { type: 'user', id: 'subscription-payer' }, organizationId,
        sourceType: 'contract', sourceId: 'x', issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId, quantity: 1 }],
      });
      const invoices = t.app.get(InvoiceRepository);
      const { invoice } = await invoices.createDraft('test-producer', input, ['TND'], ctx);
      const open = (await invoices.issue(invoice.id, { kind: 'service', service: 'test-producer' }, { template: 'system:1', locale: 'fr' }, ctx,
        { callerPlatforms: new Set(['99999999-9999-4999-8999-999999999999']), organizationPlatformId: '99999999-9999-4999-8999-999999999999' })).invoice;
      const requests = t.app.get(PaymentRequestRepository);
      const { request } = await requests.createForInvoice(open.id, { kind: 'service', service: 'test-producer' }, ctx);
      const paymentId = crypto.randomUUID();
      await t.app.get(DbService).tx(async (q) => {
        for (const [from, to, extra] of [['created', 'sending', ''], ['sending', 'requested', `, "paymentId" = '${paymentId}'`]] as const) {
          const { rows } = await q.query<{ revision: number }>(`UPDATE payment_request SET status = '${to}'${extra} WHERE id = $1 RETURNING revision`, [request.id]);
          await recordTransition(q, { entityType: 'payment_request', entityId: request.id, from, to, revision: rows[0]!.revision, ctx });
        }
      });
      const result = await requests.applyPaymentEvent(crypto.randomUUID(), {
        name: name === 'wrong-source' ? 'payment.succeeded' : name, source: name === 'wrong-source' ? 'someone-else' : 'payment-service', paymentId, producer: 'billing-service',
        paymentRequestId: request.id, sourceType: 'invoice', sourceId: open.id, payer: { type: 'user', id: 'subscription-payer' }, seller: { type: 'company', id: 'nawara-test-seller' },
        organizationId, amount: Number(open.total), currency: open.currency, revision: 1,
      }, { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: 'e' }, correlationId: 'e' }, new Date('2030-07-10T00:00:00Z'));
      expect(result.subscription, name).toBeNull();
    }
    expect(await subs.getByOrganization(organizationId)).toEqual(before);
    expect(await settlements(organizationId)).toHaveLength(1);
  });

  it('an ordinary paid invoice (non_entitlement) records no subscription settlement', async () => {
    const before = (await admin.query(`SELECT count(*)::int AS n FROM subscription_settlement`)).rows[0].n as number;
    const productId = (await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name) VALUES ('test-producer', 'company', 'nawara-test-seller', $1, 'Ordinary') RETURNING id`, [`ord-${crypto.randomUUID().slice(0, 8)}`])).rows[0].id;
    const priceId = (await admin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, 'o', 'TND', 700, 'recurring', 'month', 1) RETURNING id`, [productId])).rows[0].id;
    const r = await settle(t.app, { organizationId: org(), priceId, at: new Date('2030-08-01T00:00:00Z') });
    expect(r.application).toMatchObject({ outcome: 'applied', subscription: null });
    expect(r.subscription).toBeNull();
    expect((await admin.query(`SELECT count(*)::int AS n FROM subscription_settlement`)).rows[0].n).toBe(before);
  });
});
