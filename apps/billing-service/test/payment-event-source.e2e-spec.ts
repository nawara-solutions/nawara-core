import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import { deterministicEventId } from '../src/common/deterministic-id.js';
import type { Caller, TransitionContext } from '../src/domain/actors.js';
import { normaliseCreateInvoiceInput } from '../src/domain/invoice-input.js';
import type { PaymentEventFacts } from '../src/domain/payment-event-decision.js';
import { InvoiceRepository } from '../src/invoices/invoice.repository.js';
import { PaymentRequestRepository } from '../src/invoices/payment-request.repository.js';
import { PaymentDispatcher } from '../src/payment-integration/payment-dispatcher.js';
import { PaymentReconciler } from '../src/payment-integration/payment-reconciler.js';
import type { CancelPaymentOutcome, CreatePaymentOutcome, PaymentClient, PaymentSnapshot } from '../src/payment-integration/payment-client.js';
import type { PaymentCreateBody } from '../src/domain/payment-request-mapping.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

/**
 * V2 A3M.3, finding G11 (A3M record §12): Billing's `payment_event_receipt` is the de-duplication record of a Payment outcome. An event id
 * must never be claimed by a message that did not apply: Payment's event ids (and the reconciler's) are deterministic, and a publisher can
 * set any header, `source` included, so a forged message carrying the genuine id must not stop the genuine outcome from being applied.
 * These tests state the SAFE behaviour, through the real consumer (in-memory bus) and the real reconciler, on a scratch database.
 */
const ORG = '00000000-0000-4000-8000-0000000000d4';
const PRODUCER = 'test-producer';
const producer: Caller = { kind: 'service', service: PRODUCER };
const ctx: TransitionContext = { actor: { type: 'service', id: PRODUCER }, cause: { type: 'request', id: 'req-g11' }, correlationId: 'corr-g11' };

/** The Payment port, scripted per request / payment id; no network. */
class FakePaymentClient implements PaymentClient {
  private readonly creates = new Map<string, CreatePaymentOutcome>();
  private readonly gets = new Map<string, PaymentSnapshot>();
  whenCreate(requestId: string, outcome: CreatePaymentOutcome): void {
    this.creates.set(requestId, outcome);
  }
  whenGet(paymentId: string, snapshot: PaymentSnapshot): void {
    this.gets.set(paymentId, snapshot);
  }
  async createPayment(body: PaymentCreateBody): Promise<CreatePaymentOutcome> {
    return this.creates.get(body.paymentRequestId) ?? { kind: 'transient' };
  }
  async getPayment(paymentId: string): Promise<PaymentSnapshot | null> {
    return this.gets.get(paymentId) ?? null;
  }
  async cancelPayment(): Promise<CancelPaymentOutcome> {
    return { kind: 'cancelled' };
  }
}

describeWithEnv('G11: a message that does not apply never claims the event id (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let invoices: InvoiceRepository;
  let requests: PaymentRequestRepository;
  let dispatcher: PaymentDispatcher;
  let reconciler: PaymentReconciler;
  const payment = new FakePaymentClient();

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingg11');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    t = await createTestApp({ databaseUrl: db.url, tokens: [{ caller: PRODUCER, digest: generateServiceToken().digest }], paymentClient: payment });
    invoices = t.app.get(InvoiceRepository);
    requests = t.app.get(PaymentRequestRepository);
    dispatcher = t.app.get(PaymentDispatcher);
    reconciler = t.app.get(PaymentReconciler);
  });
  afterAll(async () => {
    await t.app.close();
    await admin.end();
    await db.drop();
  });

  let seq = 0;
  async function openInvoice() {
    seq += 1;
    const product = await admin.query(
      `INSERT INTO product (producer, "sellerType", "sellerId", code, name, status) VALUES ($1, 'organization', $2, $3, $4, 'active') RETURNING id`,
      [PRODUCER, ORG, `g11-${seq}-${Math.random().toString(36).slice(2, 8)}`, `G11 product ${seq}`],
    );
    const price = await admin.query(
      `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "effectiveFrom") VALUES ($1, $2, 'TND', 1500, 'one_time', now()) RETURNING id`,
      [product.rows[0].id, `g11-ref-${seq}`],
    );
    const input = normaliseCreateInvoiceInput({
      invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: ORG }, payer: { type: 'user', id: 'user-1' }, sourceType: 'contract', sourceId: `g11-src-${seq}`,
      issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: price.rows[0].id, quantity: 1 }],
    });
    const { invoice: draft } = await invoices.createDraft(PRODUCER, input, ['TND'], ctx);
    return (await invoices.issue(draft.id, producer, { template: 'system:1', locale: 'fr' }, ctx)).invoice;
  }
  const snapshot = (open: { id: string; total: string }, requestId: string, paymentId: string, status: string): PaymentSnapshot => ({
    paymentId, paymentRequestId: requestId, status, amount: Number(open.total), currency: 'TND', sourceType: 'invoice', sourceId: open.id,
    payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: ORG }, organizationId: ORG, closedAt: new Date(),
  });
  /** An invoice and its payment request; `dispatched` records Payment's paymentId on the request (Billing's own authenticated call). */
  async function setup(dispatched = true) {
    const open = await openInvoice();
    const { request } = await requests.createForInvoice(open.id, producer, ctx);
    const paymentId = crypto.randomUUID();
    payment.whenCreate(request.id, { kind: 'accepted', snapshot: snapshot(open, request.id, paymentId, 'pending') });
    if (dispatched) await dispatcher.dispatchOnce(60_000, 50);
    return { open, request, paymentId };
  }
  const facts = (open: { id: string; total: string }, requestId: string, paymentId: string, over: Partial<PaymentEventFacts> = {}): PaymentEventFacts => ({
    name: 'payment.succeeded', source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId: requestId, sourceType: 'invoice', sourceId: open.id,
    payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: ORG }, organizationId: ORG, amount: Number(open.total), currency: 'TND', revision: 1, ...over,
  });
  const envelope = (f: PaymentEventFacts, id: string): EventEnvelope => {
    const { name, source, ...payload } = f;
    return { id, name, payload: payload as Record<string, unknown>, headers: { eventId: id, occurredAt: new Date().toISOString(), source, version: 1 } };
  };
  const status = async (requestId: string) => (await admin.query(`SELECT status FROM payment_request WHERE id = $1`, [requestId])).rows[0].status as string;
  const receipts = async (eventId: string) => (await admin.query(`SELECT outcome, "detailCode" FROM payment_event_receipt WHERE "eventId" = $1 ORDER BY "receivedAt"`, [eventId])).rows;
  /** Publishes, then reports what the run left behind; never lets a dead-letter throw stop the test. */
  const deliver = async (e: EventEnvelope) => {
    const before = t.bus.deadLettered.length;
    await t.bus.publish(e);
    return { deadLettered: t.bus.deadLettered.length - before };
  };

  describe('G11: forged messages carrying the genuine event id', () => {
    it('G11-1: a wrong-source message first, then the genuine event: the genuine one is applied', async () => {
      const { open, request, paymentId } = await setup();
      const id = deterministicEventId(paymentId, 'payment.succeeded'); // as predictable as Payment's own ids
      const forged = await deliver(envelope(facts(open, request.id, paymentId, { source: 'evil-service' }), id));
      const genuine = await deliver(envelope(facts(open, request.id, paymentId), id));
      console.log(`G11_1 ${JSON.stringify({ forged, genuine, receipts: await receipts(id), status: await status(request.id) })}`);
      expect(await status(request.id)).toBe('paid');
      expect((await invoices.findForCaller(open.id, producer)).status).toBe('paid');
      expect(forged.deadLettered).toBe(1); // refused before any receipt (wrong_source), dead-lettered for an operator
      expect(await receipts(id)).toEqual([{ outcome: 'applied', detailCode: null }]);
    });

    it('G11-2: a message with the genuine source header but forged facts first, then the genuine event: the genuine one is applied', async () => {
      const { open, request, paymentId } = await setup();
      const id = deterministicEventId(paymentId, 'payment.succeeded');
      const forged = await deliver(envelope(facts(open, request.id, paymentId, { amount: Number(open.total) + 1 }), id));
      const genuine = await deliver(envelope(facts(open, request.id, paymentId), id));
      console.log(`G11_2 ${JSON.stringify({ forged, genuine, receipts: await receipts(id), status: await status(request.id) })}`);
      expect(await status(request.id)).toBe('paid');
      // the forged message is recorded (it carried the right source header, so only the decision could refuse it) but claimed nothing
      expect(await receipts(id)).toEqual([{ outcome: 'conflict', detailCode: 'amount_mismatch' }, { outcome: 'applied', detailCode: null }]);
    });

    it('G11-3: the event before Billing recorded the paymentId is deferred; delivered again afterwards it is applied', async () => {
      const { open, request, paymentId } = await setup(false);
      const id = deterministicEventId(paymentId, 'payment.succeeded');
      const early = await deliver(envelope(facts(open, request.id, paymentId), id));
      await dispatcher.dispatchOnce(60_000, 50); // Billing's own authenticated call records the paymentId
      expect(await status(request.id)).toBe('requested');
      const again = await deliver(envelope(facts(open, request.id, paymentId), id));
      console.log(`G11_3 ${JSON.stringify({ early, again, receipts: await receipts(id), status: await status(request.id) })}`);
      expect(await status(request.id)).toBe('paid');
      expect(await receipts(id)).toEqual([{ outcome: 'deferred', detailCode: 'payment_id_not_recorded' }, { outcome: 'applied', detailCode: null }]);
    });

    it('G11-4: a forged message carrying the reconciler\'s own id first: the reconciler still settles the request', async () => {
      const { open, request, paymentId } = await setup();
      const rid = deterministicEventId(paymentId, 'succeeded', 'reconciliation'); // the id the reconciler will use
      const forged = await deliver(envelope(facts(open, request.id, paymentId, { amount: Number(open.total) + 1 }), rid));
      payment.whenGet(paymentId, snapshot(open, request.id, paymentId, 'succeeded'));
      await reconciler.reconcileOnce(0, 50);
      console.log(`G11_4 ${JSON.stringify({ forged, receipts: await receipts(rid), status: await status(request.id) })}`);
      expect(await status(request.id)).toBe('paid');
      expect(await receipts(rid)).toEqual([{ outcome: 'conflict', detailCode: 'amount_mismatch' }, { outcome: 'applied', detailCode: null }]);
    });
  });

  describe('migration 0016: the receipt claim', () => {
    it('allows at most one applied receipt per event id, while non-applied receipts of that id may repeat', async () => {
      const id = crypto.randomUUID();
      const insert = (outcome: string) => admin.query(
        `INSERT INTO payment_event_receipt ("eventId", "eventName", outcome, "causeType") VALUES ($1, 'payment.succeeded', $2, 'payment_event')`, [id, outcome]);
      await insert('conflict');
      await insert('deferred');
      await insert('conflict');
      await insert('applied');
      await expect(insert('applied')).rejects.toMatchObject({ code: '23505' });
      expect((await receipts(id)).map((r) => r.outcome)).toEqual(['conflict', 'deferred', 'conflict', 'applied']);
      const indexes = (await admin.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'payment_event_receipt' ORDER BY indexname`)).rows;
      expect(indexes.map((i) => i.indexname)).not.toContain('payment_event_receipt_event_unique');
      expect(indexes.find((i) => i.indexname === 'payment_event_receipt_applied_event_unique')?.indexdef).toMatch(/UNIQUE.*WHERE \(\("eventId" IS NOT NULL\) AND \(outcome = 'applied'::text\)\)/);
    });
  });

  describe('controls', () => {
    it('the genuine event delivered twice is applied once; the second is a duplicate', async () => {
      const { open, request, paymentId } = await setup();
      const id = deterministicEventId(paymentId, 'payment.succeeded');
      await deliver(envelope(facts(open, request.id, paymentId), id));
      const revision = (await invoices.findForCaller(open.id, producer)).revision;
      await deliver(envelope(facts(open, request.id, paymentId), id));
      expect(await status(request.id)).toBe('paid');
      expect((await invoices.findForCaller(open.id, producer)).revision).toBe(revision);
      expect((await receipts(id)).filter((r) => r.outcome === 'applied')).toHaveLength(1);
    });

    it('a forged message after the genuine one changes nothing', async () => {
      const { open, request, paymentId } = await setup();
      const id = deterministicEventId(paymentId, 'payment.succeeded');
      await deliver(envelope(facts(open, request.id, paymentId), id));
      const revision = (await invoices.findForCaller(open.id, producer)).revision;
      await deliver(envelope(facts(open, request.id, paymentId, { amount: Number(open.total) + 1 }), id));
      expect(await status(request.id)).toBe('paid');
      expect((await invoices.findForCaller(open.id, producer)).revision).toBe(revision);
    });

    it('a forged message racing the genuine one (same id, concurrent) never prevents exactly one application', async () => {
      const { open, request, paymentId } = await setup();
      const id = deterministicEventId(paymentId, 'payment.succeeded');
      await Promise.all([
        deliver(envelope(facts(open, request.id, paymentId, { amount: Number(open.total) + 1 }), id)),
        ...Array.from({ length: 4 }, () => deliver(envelope(facts(open, request.id, paymentId), id))),
      ]);
      expect(await status(request.id)).toBe('paid');
      expect((await receipts(id)).filter((r) => r.outcome === 'applied')).toHaveLength(1);
      expect((await admin.query(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityId" = $1 AND "toStatus" = 'paid'`, [open.id])).rows[0].n).toBe(1);
    });
  });
});
