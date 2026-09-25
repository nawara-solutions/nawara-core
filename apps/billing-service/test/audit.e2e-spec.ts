import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DbService, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import { BillingAudit } from '../src/audit/billing-audit.js';
import { PriceRepository } from '../src/catalog/price.repository.js';
import { ProductRepository } from '../src/catalog/product.repository.js';
import { withVerifiedKind, type Caller, type TransitionContext } from '../src/domain/actors.js';
import { normaliseCreateInvoiceInput } from '../src/domain/invoice-input.js';
import type { PaymentEventFacts } from '../src/domain/payment-event-decision.js';
import { recordTransition } from '../src/domain/transitions.js';
import { InvoiceRepository } from '../src/invoices/invoice.repository.js';
import { PaymentRequestRepository } from '../src/invoices/payment-request.repository.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 18.7.2: Billing's central audit intent on real PostgreSQL 16. Every one of the 11 Billing catalog actions is written by
 * `AuditEventWriter` into the kit outbox on the SAME transaction as the change and its `billing_transition` row; the organization is always
 * the persisted one (catalog corrections G3 / G4: the invoice's, or the product seller's, or null); actors are Billing's own attribution.
 */
const ORG = '00000000-0000-4000-8000-0000000000a1';
const PRODUCER = 'test-producer';
const PAYER = '1a1a1a1a-0000-4000-8000-000000000001';
const producer: Caller = { kind: 'service', service: PRODUCER };
const payer: Caller = { kind: 'user', userId: PAYER };
const svcCtx: TransitionContext = { actor: { type: 'service', id: PRODUCER }, cause: { type: 'request', id: 'req-1' }, correlationId: 'corr-billing-audit' };
const userCtx = (userKind: 'member' | 'owner' | 'operator'): TransitionContext => ({ actor: { type: 'user', id: PAYER, userKind }, cause: { type: 'request', id: 'req-2' } });

describeWithEnv('Billing central audit intent (real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let invoices: InvoiceRepository;
  let requests: PaymentRequestRepository;
  const rows = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await admin.query(sql, params)).rows;
  const audit = (resourceId: string) => rows(`SELECT id, name, payload, "correlationId" FROM outbox WHERE name LIKE 'audit.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", name`, [resourceId]);
  let seq = 0;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingaudit');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 5 });
    t = await createTestApp({ databaseUrl: db.url });
    invoices = t.app.get(InvoiceRepository);
    requests = t.app.get(PaymentRequestRepository);
  });
  afterAll(async () => {
    await t.app.close();
    await admin.end();
    await db.drop();
  });
  afterEach(() => vi.restoreAllMocks());

  async function seedPrice(o: { seller?: { type: string; id: string }; recurring?: boolean } = {}) {
    seq += 1;
    const seller = o.seller ?? { type: 'organization', id: ORG };
    const product = await rows(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status) VALUES ($1, $2, $3, $4, 'Secret Product Name', 'active') RETURNING id`, [PRODUCER, seller.type, seller.id, `p-${seq}-${Math.random().toString(36).slice(2, 7)}`]);
    const price = await rows(
      `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, $2, 'TND', 9876, $3, $4, $5) RETURNING id`,
      [product[0].id, `r-${seq}`, o.recurring ? 'recurring' : 'one_time', o.recurring ? 'month' : null, o.recurring ? 1 : null],
    );
    return { productId: product[0].id as string, priceId: price[0].id as string };
  }
  async function openInvoice(o: { seller?: { type: string; id: string }; recurring?: boolean } = {}) {
    const { priceId } = await seedPrice(o);
    const seller = o.seller ?? { type: 'organization', id: ORG };
    const input = normaliseCreateInvoiceInput({
      invoiceRequestId: crypto.randomUUID(), seller, payer: { type: 'user', id: PAYER }, sourceType: 'contract', sourceId: `src-${seq}`,
      issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId, quantity: 1 }],
    });
    const { invoice } = await invoices.createDraft(PRODUCER, input, ['TND'], svcCtx);
    return (await invoices.issue(invoice.id, producer, { template: 'system:1', locale: 'fr' }, svcCtx)).invoice;
  }
  async function requested(invoice: { id: string }) {
    const { request } = await requests.createForInvoice(invoice.id, payer, userCtx('member'));
    const paymentId = crypto.randomUUID();
    await t.app.get(DbService).tx(async (q) => {
      for (const [from, to, extra] of [['created', 'sending', ''], ['sending', 'requested', `, "paymentId" = '${paymentId}'`]] as const) {
        const { rows: r } = await q.query(`UPDATE payment_request SET status = '${to}'${extra} WHERE id = $1 RETURNING revision`, [request.id]);
        await recordTransition(q, { entityType: 'payment_request', entityId: request.id, from, to, revision: r[0].revision, ctx: svcCtx });
      }
    });
    return { request, paymentId };
  }
  const eventFor = (invoice: { id: string; total: string; currency: string; organizationId: string | null }, request: { id: string }, paymentId: string, name: PaymentEventFacts['name'] = 'payment.succeeded'): PaymentEventFacts => ({
    name, source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId: request.id, sourceType: 'invoice', sourceId: invoice.id,
    payer: { type: 'user', id: PAYER }, seller: invoice.organizationId ? { type: 'organization', id: invoice.organizationId } : { type: 'user', id: 'seller-user' },
    organizationId: invoice.organizationId, amount: Number(invoice.total), currency: invoice.currency, revision: 1,
  });
  const consumer = (eventId: string): TransitionContext => ({ actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: eventId }, correlationId: `corr-${eventId.slice(0, 8)}` });

  describe('invoices (G3: the invoice\'s own organization, or null)', () => {
    it('invoice.issued: service actor, the invoice\'s organization, identifiers only', async () => {
      const inv = await openInvoice();
      const [ev] = await audit(inv.id);
      expect(ev!.name).toBe('audit.invoice.issued');
      expect(ev!.payload).toEqual({ action: 'invoice.issued', actor: { type: 'service', id: PRODUCER }, organizationId: ORG, resource: { type: 'invoice', id: inv.id }, outcome: 'succeeded' });
      expect(ev!.correlationId).toBe('corr-billing-audit');
      for (const s of ['9876', 'TND', 'Secret Product Name', PAYER, 'total', 'amount', 'number']) expect(JSON.stringify(ev!.payload)).not.toContain(s);
    });

    it('an organization-less invoice (a user seller) records organizationId null, and its issue no longer fails', async () => {
      const inv = await openInvoice({ seller: { type: 'user', id: 'seller-user-9' } });
      expect(inv.organizationId).toBeNull();
      expect((await audit(inv.id))[0]!.payload.organizationId).toBeNull();
    });

    it('invoice.discarded', async () => {
      const { priceId } = await seedPrice();
      const input = normaliseCreateInvoiceInput({ invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: ORG }, payer: { type: 'user', id: PAYER }, sourceType: 'contract', sourceId: 'x', issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId, quantity: 1 }] });
      const { invoice } = await invoices.createDraft(PRODUCER, input, ['TND'], svcCtx);
      expect(await audit(invoice.id)).toHaveLength(0); // a draft is never announced, nor audited
      await invoices.discard(invoice.id, producer, svcCtx);
      expect((await audit(invoice.id)).map((x) => x.payload)).toEqual([{ action: 'invoice.discarded', actor: { type: 'service', id: PRODUCER }, organizationId: ORG, resource: { type: 'invoice', id: invoice.id }, outcome: 'succeeded' }]);
    });
  });

  describe('payment requests', () => {
    it('payment_request.created by a user: the kind Auth verified (withVerifiedKind), the invoice as a change fact, the invoice\'s organization', async () => {
      const inv = await openInvoice();
      const ctx = { actor: withVerifiedKind({ type: 'user', id: PAYER }, { kind: 'user', identity: { adminTier: 'owner' } }), cause: { type: 'request' as const, id: 'r' } };
      const { request } = await requests.createForInvoice(inv.id, payer, ctx);
      expect((await audit(request.id))[0]!.payload).toEqual({
        action: 'payment_request.created', actor: { type: 'user', id: PAYER, userKind: 'owner' }, organizationId: ORG, resource: { type: 'payment_request', id: request.id }, outcome: 'succeeded', changes: { invoice_id: inv.id },
      });
      expect(withVerifiedKind({ type: 'user', id: PAYER }, { kind: 'user', identity: { adminTier: null } }).userKind).toBe('member');
      expect(withVerifiedKind({ type: 'service', id: 'svc' }, { kind: 'service' }).userKind).toBeUndefined();
    });

    it('payment_request.cancelled locally (never sent): service actor', async () => {
      const inv = await openInvoice();
      const { request } = await requests.createForInvoice(inv.id, payer, userCtx('member'));
      await requests.cancelUnsent(request.id, producer, svcCtx);
      const ev = (await audit(request.id)).find((x) => x.name === 'audit.payment_request.cancelled');
      expect(ev!.payload).toMatchObject({ actor: { type: 'service', id: PRODUCER }, organizationId: ORG, changes: { invoice_id: inv.id } });
    });

    it('G2: a REQUESTED payment\'s cancellation completed by Payment\'s event: system payment_event_consumer, causation = the event id', async () => {
      const inv = await openInvoice();
      const { request, paymentId } = await requested(inv);
      const eventId = crypto.randomUUID();
      await requests.applyPaymentEvent(eventId, eventFor(inv, request, paymentId, 'payment.cancelled'), consumer(eventId), new Date());
      const ev = (await audit(request.id)).find((x) => x.name === 'audit.payment_request.cancelled');
      expect(ev!.payload).toEqual({
        action: 'payment_request.cancelled', actor: { type: 'system', id: 'payment_event_consumer' }, organizationId: ORG,
        resource: { type: 'payment_request', id: request.id }, outcome: 'succeeded', changes: { invoice_id: inv.id }, causationId: eventId,
      });
    });
  });

  describe('settlement: invoice.paid and the subscription it drives', () => {
    it('invoice.paid + subscription.activated from Payment\'s event; a second settlement renews with the REAL period ends; the reconciler is its own actor', async () => {
      const first = await openInvoice({ recurring: true });
      const r1 = await requested(first);
      const e1 = crypto.randomUUID();
      await requests.applyPaymentEvent(e1, eventFor(first, r1.request, r1.paymentId), consumer(e1), new Date('2026-09-01T10:00:00Z'));
      expect((await audit(first.id)).map((x) => x.payload)).toContainEqual({ action: 'invoice.paid', actor: { type: 'system', id: 'payment_event_consumer' }, organizationId: ORG, resource: { type: 'invoice', id: first.id }, outcome: 'succeeded', causationId: e1 });
      const [sub] = await rows(`SELECT * FROM subscription WHERE "organizationId" = $1`, [ORG]);
      const activated = (await audit(sub.id)).find((x) => x.name === 'audit.subscription.activated');
      expect(activated!.payload).toEqual({ action: 'subscription.activated', actor: { type: 'system', id: 'payment_event_consumer' }, organizationId: ORG, resource: { type: 'subscription', id: sub.id }, outcome: 'succeeded', changes: { product_id: sub.productId, price_id: sub.priceId }, causationId: e1 });

      // Renewal (same offering), settled by the RECONCILER: actor payment_reconciler, no causation (no real Payment event id).
      const [line] = await rows(`SELECT "priceId" FROM invoice_line WHERE "invoiceId" = $1`, [first.id]);
      const input = normaliseCreateInvoiceInput({ invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: ORG }, payer: { type: 'user', id: PAYER }, sourceType: 'contract', sourceId: 'renewal', issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: line.priceId, quantity: 1 }] });
      const draft = (await invoices.createDraft(PRODUCER, input, ['TND'], svcCtx)).invoice;
      const second = (await invoices.issue(draft.id, producer, { template: 'system:1', locale: 'fr' }, svcCtx)).invoice;
      const r2 = await requested(second);
      const before = (await rows(`SELECT "currentPeriodEnd" FROM subscription WHERE id = $1`, [sub.id]))[0].currentPeriodEnd as Date;
      const reconciler: TransitionContext = { actor: { type: 'system', id: null }, cause: { type: 'reconciliation', id: null }, correlationId: 'reconcile-run-0001' };
      await requests.applyPaymentEvent(crypto.randomUUID(), eventFor(second, r2.request, r2.paymentId), reconciler, new Date('2026-09-20T10:00:00Z'));
      const after = (await rows(`SELECT "currentPeriodEnd" FROM subscription WHERE id = $1`, [sub.id]))[0].currentPeriodEnd as Date;
      const renewed = (await audit(sub.id)).find((x) => x.name === 'audit.subscription.renewed');
      expect(renewed!.payload).toEqual({ action: 'subscription.renewed', actor: { type: 'system', id: 'payment_reconciler' }, organizationId: ORG, resource: { type: 'subscription', id: sub.id }, outcome: 'succeeded', changes: { period_end: { from: before.toISOString(), to: after.toISOString() } } });
    });
  });

  describe('catalog (G4: the seller organization, or null)', () => {
    it('product.created / product.archived / price.created / price.retired for an organization seller carry that organization; for a user seller, null', async () => {
      const products = t.app.get(ProductRepository);
      const prices = t.app.get(PriceRepository);
      for (const seller of [{ type: 'organization' as const, id: ORG }, { type: 'user' as const, id: 'seller-user-5' }]) {
        const expectOrg = seller.type === 'organization' ? ORG : null;
        const { product } = await products.create(PRODUCER, { seller, code: `c-${++seq}`, name: 'Name Not In Audit', description: 'Desc Not In Audit', entitlementKind: 'none' } as never);
        const { price } = await prices.create(producer, { productId: product.id, clientReference: `ref-${seq}`, currency: 'TND', unitAmount: 1234n, interval: 'one_time', intervalUnit: null, intervalCount: null, effectiveFrom: new Date() } as never, ['TND']);
        await prices.retire(price.id, producer);
        await products.archive(product.id, producer);
        const p = (await audit(product.id)).map((x) => x.payload);
        expect(p).toEqual([
          { action: 'product.created', actor: { type: 'service', id: PRODUCER }, organizationId: expectOrg, resource: { type: 'product', id: product.id }, outcome: 'succeeded' },
          { action: 'product.archived', actor: { type: 'service', id: PRODUCER }, organizationId: expectOrg, resource: { type: 'product', id: product.id }, outcome: 'succeeded' },
        ]);
        expect((await audit(price.id)).map((x) => x.payload)).toEqual([
          { action: 'price.created', actor: { type: 'service', id: PRODUCER }, organizationId: expectOrg, resource: { type: 'price', id: price.id }, outcome: 'succeeded', changes: { product_id: product.id } },
          { action: 'price.retired', actor: { type: 'service', id: PRODUCER }, organizationId: expectOrg, resource: { type: 'price', id: price.id }, outcome: 'succeeded', changes: { product_id: product.id } },
        ]);
        for (const s of ['Name Not In Audit', 'Desc Not In Audit', '1234', seller.id === ORG ? 'x' : seller.id]) for (const x of p) expect(JSON.stringify(x)).not.toContain(s);
      }
    });

    it('a replayed product creation (same seller and code) writes no second audit intent', async () => {
      const products = t.app.get(ProductRepository);
      const input = { seller: { type: 'organization', id: ORG }, code: `replay-${++seq}`, name: 'N', description: 'D', entitlementKind: 'none' } as never;
      const a = await products.create(PRODUCER, input);
      const b = await products.create(PRODUCER, input);
      expect(b.changed).toBe(false);
      expect(await audit(a.product.id)).toHaveLength(1);
    });
  });

  describe('atomicity', () => {
    it('an audit-writer failure rolls the invoice issue back: still a draft, no number, no domain event, no history row', async () => {
      const { priceId } = await seedPrice();
      const input = normaliseCreateInvoiceInput({ invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: ORG }, payer: { type: 'user', id: PAYER }, sourceType: 'contract', sourceId: 'y', issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId, quantity: 1 }] });
      const { invoice } = await invoices.createDraft(PRODUCER, input, ['TND'], svcCtx);
      vi.spyOn(t.app.get(BillingAudit), 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
      await expect(invoices.issue(invoice.id, producer, { template: 'system:1', locale: 'fr' }, svcCtx)).rejects.toThrow('simulated audit failure');
      const [row] = await rows(`SELECT status, number FROM invoice WHERE id = $1`, [invoice.id]);
      expect(row).toEqual({ status: 'draft', number: null });
      expect(await rows(`SELECT 1 FROM outbox WHERE payload->>'invoiceId' = $1 OR payload->'resource'->>'id' = $1`, [invoice.id])).toHaveLength(0);
      expect((await rows(`SELECT "toStatus" FROM billing_transition WHERE "entityId" = $1`, [invoice.id])).map((x) => x.toStatus)).toEqual(['draft']);
    });

    it('evidence the contract refuses (a malformed organization) is never written and takes the product creation with it', async () => {
      const audit_ = t.app.get(BillingAudit);
      const original = audit_.record.bind(audit_);
      vi.spyOn(audit_, 'record').mockImplementationOnce((q, action, fact, ctx) => original(q, action, { ...fact, organizationId: 'NOT-A-UUID' }, ctx));
      const code = `refused-${++seq}`;
      await expect(t.app.get(ProductRepository).create(PRODUCER, { seller: { type: 'organization', id: ORG }, code, name: 'N', description: 'D', entitlementKind: 'none' } as never)).rejects.toThrow('invalid_organization');
      expect(await rows(`SELECT 1 FROM product WHERE code = $1`, [code])).toHaveLength(0);
    });

    it('an uncataloged actor is a programming error that rolls the change back (no evidence is ever guessed)', async () => {
      const inv = await openInvoice();
      const bad: TransitionContext = { actor: { type: 'user', id: PAYER }, cause: { type: 'request', id: 'r' } }; // a user WITHOUT a verified kind
      await expect(requests.createForInvoice(inv.id, payer, bad)).rejects.toThrow('billing_audit_actor_not_cataloged');
      expect(await rows(`SELECT 1 FROM payment_request WHERE "invoiceId" = $1`, [inv.id])).toHaveLength(0);
    });
  });
});
