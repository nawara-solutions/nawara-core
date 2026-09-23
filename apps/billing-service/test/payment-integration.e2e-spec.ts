import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import type { Caller, TransitionContext } from '../src/domain/actors.js';
import { normaliseCreateInvoiceInput } from '../src/domain/invoice-input.js';
import type { PaymentEventFacts } from '../src/domain/payment-event-decision.js';
import { InvoiceRepository } from '../src/invoices/invoice.repository.js';
import { PaymentRequestRepository } from '../src/invoices/payment-request.repository.js';
import { PaymentDispatcher } from '../src/payment-integration/payment-dispatcher.js';
import { PaymentReconciler } from '../src/payment-integration/payment-reconciler.js';
import type {
  CancelPaymentOutcome, CreatePaymentOutcome, PaymentClient, PaymentSnapshot,
} from '../src/payment-integration/payment-client.js';
import type { PaymentCreateBody } from '../src/domain/payment-request-mapping.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const ORG = '00000000-0000-4000-8000-0000000000c3';
const PRODUCER = 'test-producer';
const OTHER_PRODUCER = 'other-producer';
const producer: Caller = { kind: 'service', service: PRODUCER };
const ctx: TransitionContext = { actor: { type: 'service', id: PRODUCER }, cause: { type: 'request', id: 'req-1' }, correlationId: 'corr-1' };

/**
 * A test double for the Payment port (SDD 21.2): no network, and scoped by request/payment id (not one shared
 * global answer) — this suite shares ONE database across its `it`s (as `invoices.e2e-spec.ts` already does), so an
 * earlier test's still-`sending`/`requested` row must never pick up a LATER test's scripted answer. An unconfigured
 * id always gets the same safe default the real client would report for something it does not recognise: `transient`
 * for create (stays `sending`, retried later — never invented), `null` for get (logged for manual reconciliation,
 * never settled). Records every call so tests can assert exactly what Billing sent, including that a retry reuses
 * the SAME `paymentRequestId` (Billing's own natural key), never a fresh one (SDD 21.5).
 */
class FakePaymentClient implements PaymentClient {
  createCalls: PaymentCreateBody[] = [];
  cancelCalls: { paymentId: string; idempotencyKey: string }[] = [];
  getCalls: string[] = [];
  private readonly createByRequestId = new Map<string, CreatePaymentOutcome | ((body: PaymentCreateBody) => CreatePaymentOutcome)>();
  private readonly getByPaymentId = new Map<string, PaymentSnapshot | null | 'throw' | (() => PaymentSnapshot | null)>();
  private readonly cancelByPaymentId = new Map<string, CancelPaymentOutcome>();

  whenCreate(requestId: string, outcome: CreatePaymentOutcome | ((body: PaymentCreateBody) => CreatePaymentOutcome)): void {
    this.createByRequestId.set(requestId, outcome);
  }
  whenGet(paymentId: string, outcome: PaymentSnapshot | null | 'throw' | (() => PaymentSnapshot | null)): void {
    this.getByPaymentId.set(paymentId, outcome);
  }
  whenCancel(paymentId: string, outcome: CancelPaymentOutcome): void {
    this.cancelByPaymentId.set(paymentId, outcome);
  }

  async createPayment(body: PaymentCreateBody): Promise<CreatePaymentOutcome> {
    this.createCalls.push(body);
    const o = this.createByRequestId.get(body.paymentRequestId) ?? { kind: 'transient' as const };
    return typeof o === 'function' ? o(body) : o;
  }
  async getPayment(paymentId: string): Promise<PaymentSnapshot | null> {
    this.getCalls.push(paymentId);
    const o = this.getByPaymentId.get(paymentId) ?? null;
    if (o === 'throw') throw new Error('payment-service unreachable (simulated)');
    return typeof o === 'function' ? o() : o;
  }
  async cancelPayment(paymentId: string, idempotencyKey: string): Promise<CancelPaymentOutcome> {
    this.cancelCalls.push({ paymentId, idempotencyKey });
    return this.cancelByPaymentId.get(paymentId) ?? { kind: 'cancelled' };
  }
}

/**
 * The Payment/Billing Stage 4 cross-service loop (SDD section 21): the dispatcher, the reconciler and the event
 * consumer, plus the new producer-only cancel endpoint. The domain decision logic itself (`decidePaymentEvent` /
 * `applyPaymentEvent`: duplicates, out-of-order, conflicts, deferrals) is already exhaustively proven against a real
 * database in invoices.e2e-spec.ts and is NOT re-proven here — this file proves the NEW Stage 4 transport and
 * scheduling pieces that call into that same, unmodified logic. All `it`s share one database (like
 * invoices.e2e-spec.ts): assertions target the SPECIFIC row a test created, never an exact aggregate count, since
 * `dispatchOnce`/`reconcileOnce` scan the whole table and may also see other tests' rows still in flight.
 */
describeWithEnv('Payment/Billing Stage 4: dispatcher, reconciler, event consumer, cancel (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let invoices: InvoiceRepository;
  let requests: PaymentRequestRepository;
  let dispatcher: PaymentDispatcher;
  let reconciler: PaymentReconciler;
  let payment: FakePaymentClient;

  const producerToken = generateServiceToken();
  const otherProducerToken = generateServiceToken();

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingpay');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 20 });
    payment = new FakePaymentClient();
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [
        { caller: PRODUCER, digest: producerToken.digest },
        { caller: OTHER_PRODUCER, digest: otherProducerToken.digest },
      ],
      paymentClient: payment,
    });
    invoices = t.app.get(InvoiceRepository);
    requests = t.app.get(PaymentRequestRepository);
    dispatcher = t.app.get(PaymentDispatcher);
    reconciler = t.app.get(PaymentReconciler);
    // `PaymentEventConsumer` subscribes to the bus in its own `onApplicationBootstrap`, already run by `app.listen()`
    // above — nothing here needs to touch it directly, publishing to `t.bus` is enough to exercise it.
  });
  afterAll(async () => {
    await t.app.close();
    await admin.end();
    await db.drop();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    payment.createCalls = [];
    payment.cancelCalls = [];
    payment.getCalls = [];
  });

  // ------------------------------------------------------------------------------------------------------------------ helpers
  let seq = 0;
  async function seedPrice(unit = 1500): Promise<string> {
    seq += 1;
    const product = await admin.query(
      `INSERT INTO product (producer, "sellerType", "sellerId", code, name, status) VALUES ($1, 'organization', $2, $3, $4, 'active') RETURNING id`,
      [PRODUCER, ORG, `prod-${seq}-${Math.random().toString(36).slice(2, 8)}`, `Product ${seq}`],
    );
    const price = await admin.query(
      `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "effectiveFrom") VALUES ($1, $2, 'TND', $3, 'one_time', now()) RETURNING id`,
      [product.rows[0].id, `ref-${seq}`, unit],
    );
    return price.rows[0].id;
  }

  async function openInvoice(payerId = 'user-1') {
    const priceId = await seedPrice();
    const input = normaliseCreateInvoiceInput({
      invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: ORG }, payer: { type: 'user', id: payerId }, sourceType: 'contract', sourceId: `src-${++seq}`,
      issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId, quantity: 1 }],
    });
    const { invoice: draft } = await invoices.createDraft(PRODUCER, input, ['TND'], ctx);
    return (await invoices.issue(draft.id, producer, { template: 'system:1', locale: 'fr' }, ctx)).invoice;
  }

  const rows = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await admin.query(sql, params)).rows;
  const requestRow = async (id: string) => (await rows(`SELECT * FROM payment_request WHERE id = $1`, [id]))[0];

  const snapshotFor = (invoice: { id: string; total: string; currency: string }, request: { id: string }, paymentId: string, status = 'succeeded', over: Partial<PaymentSnapshot> = {}): PaymentSnapshot => ({
    paymentId, paymentRequestId: request.id, status, amount: Number(invoice.total), currency: invoice.currency,
    sourceType: 'invoice', sourceId: invoice.id, payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: ORG }, organizationId: ORG,
    closedAt: new Date(), ...over,
  });

  const factsFor = (invoice: { id: string; total: string; currency: string }, request: { id: string }, paymentId: string, name: PaymentEventFacts['name'] = 'payment.succeeded', over: Partial<PaymentEventFacts> = {}): PaymentEventFacts => ({
    name, source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId: request.id, sourceType: 'invoice', sourceId: invoice.id,
    payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: ORG }, organizationId: ORG, amount: Number(invoice.total), currency: invoice.currency, revision: 1, ...over,
  });

  function envelopeFor(facts: PaymentEventFacts, id = crypto.randomUUID()): EventEnvelope {
    const { name, source, ...payload } = facts;
    return { id, name, payload: payload as Record<string, unknown>, headers: { eventId: id, occurredAt: new Date().toISOString(), source, version: 1 } };
  }

  /** Creates a request and dispatches it to `requested` with an `accepted` outcome, scoped to only that request. */
  async function requestedRow(o: { payerId?: string } = {}) {
    const open = await openInvoice(o.payerId);
    const { request } = await requests.createForInvoice(open.id, producer, ctx);
    const paymentId = crypto.randomUUID();
    payment.whenCreate(request.id, { kind: 'accepted', snapshot: snapshotFor(open, request, paymentId, 'pending') });
    await dispatcher.dispatchOnce(60_000, 50);
    return { open, request, paymentId };
  }

  // -------------------------------------------------------------------------------------------------------------- dispatcher
  describe('PaymentDispatcher (SDD 21.5): translates a payment_request into a call to Payment, no business logic of its own', () => {
    it('an accepted create moves the request to requested with the paymentId Payment returned, sending the request natural key as reference', async () => {
      const open = await openInvoice();
      const { request } = await requests.createForInvoice(open.id, producer, ctx);
      const paymentId = crypto.randomUUID();
      payment.whenCreate(request.id, { kind: 'accepted', snapshot: snapshotFor(open, request, paymentId, 'pending') });

      await dispatcher.dispatchOnce(60_000, 50);
      const mine = payment.createCalls.find((c) => c.paymentRequestId === request.id);
      expect(mine).toMatchObject({ paymentRequestId: request.id, sourceType: 'invoice', sourceId: open.id, amount: Number(open.total), currency: 'TND', reference: open.number });
      const after = await requestRow(request.id);
      expect(after.status).toBe('requested');
      expect(after.paymentId).toBe(paymentId);
    });

    it('a rejected create is a permanent, non-retried failure: the request moves to rejected and Payment is never asked again for it', async () => {
      const open = await openInvoice();
      const { request } = await requests.createForInvoice(open.id, producer, ctx);
      payment.whenCreate(request.id, { kind: 'rejected', code: 'some_billing_defect' });

      await dispatcher.dispatchOnce(60_000, 50);
      expect((await requestRow(request.id)).status).toBe('rejected');
      const callsBefore = payment.createCalls.filter((c) => c.paymentRequestId === request.id).length;
      await dispatcher.dispatchOnce(60_000, 50); // a rejected request is no longer `created`/stale-`sending`: never re-claimed
      expect(payment.createCalls.filter((c) => c.paymentRequestId === request.id)).toHaveLength(callsBefore);
    });

    it('a transient failure leaves the request `sending`; the NEXT pass retries the IDENTICAL request (same natural key), never a new one', async () => {
      const open = await openInvoice();
      const { request } = await requests.createForInvoice(open.id, producer, ctx);
      payment.whenCreate(request.id, { kind: 'transient' });

      await dispatcher.dispatchOnce(60_000, 50);
      expect((await requestRow(request.id)).status).toBe('sending');
      expect(payment.createCalls.filter((c) => c.paymentRequestId === request.id)).toHaveLength(1);

      const paymentId = crypto.randomUUID();
      payment.whenCreate(request.id, { kind: 'accepted', snapshot: snapshotFor(open, request, paymentId, 'pending') });
      // staleSendingMs=0: the sending row from the failed pass is immediately eligible again (mirrors AttemptResolver's own tests)
      await dispatcher.dispatchOnce(0, 50);
      const mine = payment.createCalls.filter((c) => c.paymentRequestId === request.id);
      expect(mine).toHaveLength(2);
      expect(mine[0]!.paymentRequestId).toBe(mine[1]!.paymentRequestId); // identical retry, same key
      expect((await requestRow(request.id)).status).toBe('requested');
    });

    it('an auth fault (Billing\'s own service token misconfigured) leaves the request `sending` for a later retry, same as a transient failure', async () => {
      const open = await openInvoice();
      const { request } = await requests.createForInvoice(open.id, producer, ctx);
      payment.whenCreate(request.id, { kind: 'auth_fault' });
      await dispatcher.dispatchOnce(60_000, 50);
      expect((await requestRow(request.id)).status).toBe('sending');
    });

    it('a thrown network error for one claim never blocks the others (per-item isolation)', async () => {
      const [a, b] = await Promise.all([openInvoice(), openInvoice()]);
      const ra = (await requests.createForInvoice(a.id, producer, ctx)).request;
      const rb = (await requests.createForInvoice(b.id, producer, ctx)).request;
      payment.whenCreate(ra.id, () => {
        throw new Error('connection reset (simulated)');
      });
      payment.whenCreate(rb.id, { kind: 'accepted', snapshot: snapshotFor(b, rb, crypto.randomUUID(), 'pending') });
      await dispatcher.dispatchOnce(60_000, 50);
      const [statusA, statusB] = await Promise.all([requestRow(ra.id), requestRow(rb.id)]);
      expect(statusA.status).toBe('sending'); // the throw leaves it exactly where it was: safe to retry later
      expect(statusB.status).toBe('requested'); // the OTHER claim in the same pass was unaffected
    });

    it('two overlapping dispatch passes never run at once: the second call while one is in flight is a no-op', async () => {
      const open = await openInvoice();
      await requests.createForInvoice(open.id, producer, ctx);
      let resolveCreate!: (o: CreatePaymentOutcome) => void;
      let signalCalled!: () => void;
      const called = new Promise<void>((resolve) => {
        signalCalled = resolve;
      });
      const gate = new Promise<CreatePaymentOutcome>((resolve) => {
        resolveCreate = resolve;
      });
      payment.createPayment = async () => {
        signalCalled();
        return gate;
      };
      try {
        const first = dispatcher.dispatchOnce(60_000, 50); // starts, claims the row, then calls createPayment
        await called; // createPayment has now actually been invoked: `running` is still true, guaranteed (no timing guess)
        const second = await dispatcher.dispatchOnce(60_000, 50); // running=true already: immediate no-op
        expect(second).toEqual({ dispatched: 0 });
        resolveCreate({ kind: 'transient' });
        await first;
      } finally {
        // this test replaces the instance method directly (there is no per-request outcome to configure a "hang");
        // undo it so every later test goes back through the scoped `createByRequestId` lookup.
        delete (payment as unknown as { createPayment?: unknown }).createPayment;
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------- reconciler
  describe('PaymentReconciler (SDD 21.5): the recovery path for a terminal event Billing never received', () => {
    it('a stale requested row whose Payment status is terminal is settled through the SAME decision procedure a live event uses', async () => {
      const { open, request, paymentId } = await requestedRow();
      payment.whenGet(paymentId, snapshotFor(open, request, paymentId, 'succeeded'));
      const result = await reconciler.reconcileOnce(0, 50); // staleRequestedMs=0: immediately eligible
      expect(result.settled).toBeGreaterThanOrEqual(1);
      expect((await requestRow(request.id)).status).toBe('paid');
      expect((await invoices.findForCaller(open.id, producer)).status).toBe('paid');
    });

    it('still pending/created at Payment: not settled, and stays requested (not stale enough to act on)', async () => {
      const { open, request, paymentId } = await requestedRow();
      payment.whenGet(paymentId, snapshotFor(open, request, paymentId, 'pending'));
      await reconciler.reconcileOnce(0, 50);
      expect((await requestRow(request.id)).status).toBe('requested');
      expect(payment.getCalls).toContain(paymentId);
    });

    it('Payment no longer has the payment (unconfigured / 404): logged for manual reconciliation, never crashes, never mutates the request', async () => {
      const { request, paymentId } = await requestedRow();
      // deliberately no `whenGet`: the default (unconfigured) answer is `null`, exactly like a real 404
      await reconciler.reconcileOnce(0, 50);
      expect((await requestRow(request.id)).status).toBe('requested');
      expect(payment.getCalls).toContain(paymentId);
    });

    it('a getPayment failure (Payment unreachable) for one row never blocks reconciliation of the others', async () => {
      const a = await requestedRow();
      const b = await requestedRow();
      payment.whenGet(a.paymentId, 'throw');
      payment.whenGet(b.paymentId, snapshotFor(b.open, b.request, b.paymentId, 'succeeded'));
      await reconciler.reconcileOnce(0, 50);
      expect((await requestRow(a.request.id)).status).toBe('requested'); // the failure never mutated it
      expect((await requestRow(b.request.id)).status).toBe('paid'); // the other row in the same pass still settled
    });

    it('a conflicting snapshot (e.g. amount mismatch) is recorded as a conflict, never applied, and never crashes the pass', async () => {
      const { open, request, paymentId } = await requestedRow();
      payment.whenGet(paymentId, snapshotFor(open, request, paymentId, 'succeeded', { amount: Number(open.total) + 1 }));
      await reconciler.reconcileOnce(0, 50);
      expect((await requestRow(request.id)).status).toBe('requested');
    });

    it('running the reconciler again after settling finds that SPECIFIC row already gone (repeatable, idempotent)', async () => {
      const { open, request, paymentId } = await requestedRow();
      payment.whenGet(paymentId, snapshotFor(open, request, paymentId, 'succeeded'));
      await reconciler.reconcileOnce(0, 50);
      expect((await requestRow(request.id)).status).toBe('paid');
      payment.getCalls = [];
      await reconciler.reconcileOnce(0, 50); // `paid`, not `requested`: no longer picked up at all
      expect(payment.getCalls).not.toContain(paymentId);
    });

    it('fairness (H-02): unpaid requests at the head of the scan never starve a later stale request, even when the batch is smaller than the backlog', async () => {
      const early = [await requestedRow(), await requestedRow(), await requestedRow(), await requestedRow(), await requestedRow()];
      for (const e of early) payment.whenGet(e.paymentId, snapshotFor(e.open, e.request, e.paymentId, 'pending'));
      const late = await requestedRow();
      payment.whenGet(late.paymentId, snapshotFor(late.open, late.request, late.paymentId, 'succeeded'));

      const scanner = new PaymentReconciler(requests, payment, t.config);
      const batch = 3;
      const eligible = (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM payment_request WHERE status = 'requested' AND "paymentId" IS NOT NULL`))[0]!.n;
      const asked: string[] = [];
      let passes = 0;
      while ((await requestRow(late.request.id)).status !== 'paid' && passes <= Math.ceil(eligible / batch)) {
        payment.getCalls = [];
        await scanner.reconcileOnce(0, batch);
        expect(payment.getCalls.length).toBeLessThanOrEqual(batch); // bounded work per pass
        asked.push(...payment.getCalls);
        passes += 1;
      }
      expect((await requestRow(late.request.id)).status).toBe('paid'); // reached although every earlier row stayed unresolved
      expect(passes).toBeGreaterThan(1); // it was NOT in the first batch: the scan moved on
      expect(new Set(asked).size).toBe(asked.length); // within one cycle no request is asked about twice
      for (const e of early) expect((await requestRow(e.request.id)).status).toBe('requested'); // the unpaid ones are untouched
    });

    it('a restarted reconciler (no remembered position) still reaches later requests: nothing is skipped or lost', async () => {
      const early = [await requestedRow(), await requestedRow(), await requestedRow(), await requestedRow()];
      for (const e of early) payment.whenGet(e.paymentId, snapshotFor(e.open, e.request, e.paymentId, 'pending'));
      const late = await requestedRow();
      payment.whenGet(late.paymentId, snapshotFor(late.open, late.request, late.paymentId, 'succeeded'));
      const eligible = (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM payment_request WHERE status = 'requested' AND "paymentId" IS NOT NULL`))[0]!.n;

      await new PaymentReconciler(requests, payment, t.config).reconcileOnce(0, 3); // a first process makes some progress, then "dies"
      const restarted = new PaymentReconciler(requests, payment, t.config); // a second one starts with no position
      for (let i = 0; i <= Math.ceil(eligible / 3) && (await requestRow(late.request.id)).status !== 'paid'; i++) await restarted.reconcileOnce(0, 3);
      expect((await requestRow(late.request.id)).status).toBe('paid');
    });

    it('the scan resumes strictly after the last row it examined, in (updatedAt, id) order, and the supporting partial index exists', async () => {
      const a = await requestedRow();
      const b = await requestedRow();
      const page1 = await requests.findStaleRequested(1000, 0);
      const ids = page1.map((r) => r.id);
      expect(ids.indexOf(a.request.id)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(a.request.id)).toBeLessThan(ids.indexOf(b.request.id));
      const afterA = await requests.findStaleRequested(1000, 0, page1.find((r) => r.id === a.request.id)!.position);
      expect(afterA.map((r) => r.id)).not.toContain(a.request.id);
      expect(afterA.map((r) => r.id)).toContain(b.request.id);
      const idx = await rows(`SELECT indexdef FROM pg_indexes WHERE indexname = 'payment_request_reconcile_idx'`);
      expect(idx).toHaveLength(1);
    });

    it('two overlapping reconciliation passes never run at once: the second call while one is in flight is a no-op', async () => {
      const { open, request, paymentId } = await requestedRow();
      payment.whenGet(paymentId, snapshotFor(open, request, paymentId, 'succeeded'));

      const [first, second] = await Promise.all([reconciler.reconcileOnce(0, 50), reconciler.reconcileOnce(0, 50)]);
      const noop = [first, second].find((r) => r.checked === 0 && r.settled === 0);
      expect(noop).toBeDefined(); // exactly one of the two overlapping calls is the guarded no-op
      expect((await requestRow(request.id)).status).toBe('paid'); // the other one still did the real work
    });
  });

  // ------------------------------------------------------------------------------------------------------------------ consumer
  describe('PaymentEventConsumer (SDD 21.3, 21.4): transport only, reuses the SAME decision procedure — no business rule lives here', () => {
    it('a well-formed payment.succeeded event settles the request and invoice, exactly like a direct applyPaymentEvent call', async () => {
      const { open, request, paymentId } = await requestedRow();
      await t.bus.publish(envelopeFor(factsFor(open, request, paymentId)));
      expect((await requestRow(request.id)).status).toBe('paid');
      expect((await invoices.findForCaller(open.id, producer)).status).toBe('paid');
    });

    it('a malformed payload is dead-lettered, never silently dropped or misapplied (the consumer trusts nothing about the wire shape)', async () => {
      const { open, request, paymentId } = await requestedRow();
      const bad = envelopeFor(factsFor(open, request, paymentId));
      delete (bad.payload as Record<string, unknown>).producer; // required field missing
      const before = t.bus.deadLettered.length;
      await t.bus.publish(bad);
      expect(t.bus.deadLettered.length).toBe(before + 1);
      expect((await requestRow(request.id)).status).toBe('requested'); // untouched
    });

    it('a redelivery of the same event id (at-least-once broker semantics) settles the request exactly once', async () => {
      const { open, request, paymentId } = await requestedRow();
      const id = crypto.randomUUID();
      const before = (await invoices.findForCaller(open.id, producer)).revision;
      await t.bus.publish(envelopeFor(factsFor(open, request, paymentId), id));
      await t.bus.publish(envelopeFor(factsFor(open, request, paymentId), id));
      const receipts = await rows(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "eventId" = $1`, [id]);
      expect(receipts[0].n).toBe(1);
      expect((await invoices.findForCaller(open.id, producer)).revision).toBe(before + 1); // one paid transition, not two
    });

    it('a producer mismatch is a recorded conflict; the request and invoice are left exactly as they were', async () => {
      const { open, request, paymentId } = await requestedRow();
      await t.bus.publish(envelopeFor(factsFor(open, request, paymentId, 'payment.succeeded', { producer: 'someone-else' })));
      expect((await requestRow(request.id)).status).toBe('requested');
      expect((await invoices.findForCaller(open.id, producer)).status).toBe('open');
    });

    it('payment.created is never bound (SDD 21.3): publishing it has no subscriber here and changes nothing', async () => {
      const { request, paymentId } = await requestedRow();
      const before = t.bus.deadLettered.length;
      await t.bus.publish({
        id: crypto.randomUUID(), name: 'payment.created',
        payload: { paymentId, producer: 'billing-service', paymentRequestId: request.id },
        headers: { eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 },
      });
      expect(t.bus.deadLettered.length).toBe(before); // not even dead-lettered: no subscriber binds it at all
      expect((await requestRow(request.id)).status).toBe('requested');
    });
  });

  // -------------------------------------------------------------------------------------------------------------------- cancel
  describe('POST /billing/payment-requests/:id/cancel (SDD 17.3, endpoint 15, producer-only)', () => {
    const http = () => t.app.getHttpServer();
    const asProducer = {
      post: (path: string) => request(http()).post(path).set('authorization', `Bearer ${producerToken.token}`),
    };
    const asOtherProducer = {
      post: (path: string) => request(http()).post(path).set('authorization', `Bearer ${otherProducerToken.token}`),
    };

    it('a request never sent (still created) is cancelled locally: 200, cancelled, and Payment is never called', async () => {
      const open = await openInvoice();
      const { request } = await requests.createForInvoice(open.id, producer, ctx);
      const r = await asProducer.post(`/billing/payment-requests/${request.id}/cancel`).expect(200);
      expect(r.body).toMatchObject({ id: request.id, status: 'cancelled' });
      expect(payment.cancelCalls.filter((c) => c.paymentId === request.id)).toHaveLength(0);
    });

    it('a request already sent (requested) stamps cancelRequestedAt and asks Payment to cancel with a deterministic idempotency key; the request itself stays "requested" (the terminal state arrives only via the event/reconciliation path)', async () => {
      const { request, paymentId } = await requestedRow();
      const r = await asProducer.post(`/billing/payment-requests/${request.id}/cancel`).expect(200);
      expect(r.body).toMatchObject({ id: request.id, status: 'requested', paymentId });
      const mine = payment.cancelCalls.filter((c) => c.paymentId === paymentId);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ paymentId, idempotencyKey: `billing-cancel-${request.id}` });
      expect((await requestRow(request.id)).cancelRequestedAt).toBeInstanceOf(Date);
    });

    it('a repeat cancel of an already-cancel-requested request is a safe replay: same idempotency key, cancelRequestedAt not re-stamped', async () => {
      const { request, paymentId } = await requestedRow();
      await asProducer.post(`/billing/payment-requests/${request.id}/cancel`).expect(200);
      const firstStamp = (await requestRow(request.id)).cancelRequestedAt;

      await asProducer.post(`/billing/payment-requests/${request.id}/cancel`).expect(200);
      const mine = payment.cancelCalls.filter((c) => c.paymentId === paymentId);
      expect(mine).toHaveLength(2);
      expect(mine[0]!.idempotencyKey).toBe(mine[1]!.idempotencyKey);
      expect((await requestRow(request.id)).cancelRequestedAt).toEqual(firstStamp);
    });

    // Stage 15.5 (F-B): success is answered only when Payment confirmed the cancellation. It used to be 200 whatever Payment answered,
    // and nothing re-sent it: a cancellation made while Payment was unavailable was silently lost and the payment stayed payable.
    it('Payment unavailable (transient): 503 payment_unavailable, nothing claimed; once Payment is back, the same call is a replay and succeeds', async () => {
      const { request, paymentId } = await requestedRow();
      payment.whenCancel(paymentId, { kind: 'transient' });
      const r = await asProducer.post(`/billing/payment-requests/${request.id}/cancel`).expect(503);
      expect(r.body.code).toBe('payment_unavailable');
      expect((await requestRow(request.id)).status).toBe('requested');
      const firstStamp = (await requestRow(request.id)).cancelRequestedAt;
      payment.whenCancel(paymentId, { kind: 'cancelled' });
      await asProducer.post(`/billing/payment-requests/${request.id}/cancel`).expect(200);
      const mine = payment.cancelCalls.filter((c) => c.paymentId === paymentId);
      expect(mine).toHaveLength(2);
      expect(mine[0]!.idempotencyKey).toBe(mine[1]!.idempotencyKey);
      expect((await requestRow(request.id)).cancelRequestedAt).toEqual(firstStamp);
    });

    it('a Payment answer that is not a confirmation (auth fault, unknown payment) is 503 too, never a success', async () => {
      for (const kind of ['auth_fault', 'not_found'] as const) {
        const { request, paymentId } = await requestedRow();
        payment.whenCancel(paymentId, { kind });
        const r = await asProducer.post(`/billing/payment-requests/${request.id}/cancel`).expect(503);
        expect(r.body.code).toBe('payment_unavailable');
      }
    });

    it('Payment refuses because money may be in flight (open attempt): 409 payment_request_in_flight, as SDD 21.2 says', async () => {
      const { request, paymentId } = await requestedRow();
      payment.whenCancel(paymentId, { kind: 'in_flight' });
      const r = await asProducer.post(`/billing/payment-requests/${request.id}/cancel`).expect(409);
      expect(r.body.code).toBe('payment_request_in_flight');
    });

    it('Payment already terminal: 200, no error (the terminal event or the reconciler settles the request, SDD 21.2)', async () => {
      const { request, paymentId } = await requestedRow();
      payment.whenCancel(paymentId, { kind: 'already_terminal' });
      await asProducer.post(`/billing/payment-requests/${request.id}/cancel`).expect(200);
    });

    it('cancelling an already cancelled request answers 200 with it (a retry after a lost answer), without calling Payment', async () => {
      const open = await openInvoice();
      const { request } = await requests.createForInvoice(open.id, producer, ctx);
      await asProducer.post(`/billing/payment-requests/${request.id}/cancel`).expect(200);
      const r = await asProducer.post(`/billing/payment-requests/${request.id}/cancel`).expect(200);
      expect(r.body).toMatchObject({ id: request.id, status: 'cancelled' });
      expect(payment.cancelCalls.filter((c) => c.paymentId === request.id)).toHaveLength(0);
    });

    it('a request still `sending` (in flight to Payment, no answer yet) is 409 payment_request_in_flight, neither case applies', async () => {
      const open = await openInvoice();
      const { request } = await requests.createForInvoice(open.id, producer, ctx);
      await requests.claimForDispatch(50, 60_000, ctx); // claims it into `sending`, deliberately never resolved
      const r = await asProducer.post(`/billing/payment-requests/${request.id}/cancel`).expect(409);
      expect(r.body.code).toBe('payment_request_in_flight');
    });

    it('an already-terminal request (e.g. rejected by Payment) is 409 payment_request_in_flight, never silently accepted', async () => {
      const open = await openInvoice();
      const { request } = await requests.createForInvoice(open.id, producer, ctx);
      payment.whenCreate(request.id, { kind: 'rejected', code: 'some_defect' });
      await dispatcher.dispatchOnce(60_000, 50);
      expect((await requestRow(request.id)).status).toBe('rejected');
      const r = await asProducer.post(`/billing/payment-requests/${request.id}/cancel`).expect(409);
      expect(r.body.code).toBe('payment_request_in_flight');
    });

    it('only the producer that owns the invoice may cancel; another service and an unauthenticated caller both get refused, never leaking existence', async () => {
      const open = await openInvoice();
      const { request: pr } = await requests.createForInvoice(open.id, producer, ctx);
      await asOtherProducer.post(`/billing/payment-requests/${pr.id}/cancel`).expect(404);
      await request(http()).post(`/billing/payment-requests/${pr.id}/cancel`).expect(401);
    });

    it('an unknown request id is 404', async () => {
      await asProducer.post(`/billing/payment-requests/${crypto.randomUUID()}/cancel`).expect(404);
    });
  });
});
