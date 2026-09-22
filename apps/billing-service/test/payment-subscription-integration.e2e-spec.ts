import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import type { Caller, TransitionContext } from '../src/domain/actors.js';
import { normaliseCreateInvoiceInput, type NormalisedCreateInvoiceInput } from '../src/domain/invoice-input.js';
import type { PaymentEventFacts } from '../src/domain/payment-event-decision.js';
import { recordTransition } from '../src/domain/transitions.js';
import { InvoiceRepository } from '../src/invoices/invoice.repository.js';
import { PaymentRequestRepository } from '../src/invoices/payment-request.repository.js';
import type { PaymentSnapshot } from '../src/payment-integration/payment-client.js';
import { SubscriptionRepository } from '../src/subscriptions/subscription.repository.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const PRODUCER = 'test-producer';
const producer: Caller = { kind: 'service', service: PRODUCER };
const ctx: TransitionContext = { actor: { type: 'service', id: PRODUCER }, cause: { type: 'request', id: 'req-1' }, correlationId: 'corr-1' };
const paymentCtx: TransitionContext = { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: 'evt' }, correlationId: 'corr-evt' };
const day = 86_400_000;
const addMonthUTC = (d: Date, n = 1): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));

/**
 * Stage 12.4: the existing Payment-event consumption path (`PaymentRequestRepository.applyPaymentEvent`, exercised
 * directly here exactly like `test/invoices.e2e-spec.ts` already does for its own scenarios) now also links a
 * successfully-settled, correctly-classified recurring obligation to the Organization's Subscription, in the SAME
 * transaction. One test near the end goes through the REAL `PaymentEventConsumer`/`EventBus` wiring to prove the
 * `occurredAt` header actually reaches the Subscription anchor end to end; every other scenario calls the repository
 * directly for precision and speed, matching this repo's own convention for `invoices.e2e-spec.ts`'s payment-event
 * suite (section 66: consumer/handler integration + real PostgreSQL, not a real broker — that is Stage 12.7's).
 */
describeWithEnv('Payment -> Subscription integration (Stage 12.4), against a real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let invoices: InvoiceRepository;
  let requests: PaymentRequestRepository;
  let subs: SubscriptionRepository;
  let dbs: DbService;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingpaysub');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 20 });
    t = await createTestApp({ databaseUrl: db.url });
    invoices = t.app.get(InvoiceRepository);
    requests = t.app.get(PaymentRequestRepository);
    subs = t.app.get(SubscriptionRepository);
    dbs = t.app.get(DbService);
  });
  afterAll(async () => {
    await t.app.close();
    await admin.end();
    await db.drop();
  });

  // ------------------------------------------------------------------------------------------------------------ helpers
  let seq = 0;
  async function seedRecurringPrice(o: { organizationId?: string; unit?: number; currency?: string; intervalUnit?: string; intervalCount?: number } = {}): Promise<{ productId: string; priceId: string }> {
    seq += 1;
    const product = await admin.query(
      `INSERT INTO product (producer, "sellerType", "sellerId", code, name, status) VALUES ('test-producer', 'organization', $1, $2, $3, 'active') RETURNING id`,
      [o.organizationId ?? ORG, `sub-prod-${seq}-${Math.random().toString(36).slice(2, 8)}`, `Subscription product ${seq}`],
    );
    const price = await admin.query(
      `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount")
       VALUES ($1, $2, $3, $4, 'recurring', $5, $6) RETURNING id`,
      [product.rows[0].id, `ref-${seq}`, o.currency ?? 'TND', o.unit ?? 5000, o.intervalUnit ?? 'month', o.intervalCount ?? 1],
    );
    return { productId: product.rows[0].id, priceId: price.rows[0].id };
  }
  async function seedOneTimePrice(o: { organizationId?: string; unit?: number } = {}): Promise<string> {
    seq += 1;
    const product = await admin.query(
      `INSERT INTO product (producer, "sellerType", "sellerId", code, name) VALUES ('test-producer', 'organization', $1, $2, $3) RETURNING id`,
      [o.organizationId ?? ORG, `onetime-${seq}-${Math.random().toString(36).slice(2, 8)}`, `One-time product ${seq}`],
    );
    const price = await admin.query(
      `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval") VALUES ($1, $2, 'TND', $3, 'one_time') RETURNING id`,
      [product.rows[0].id, `ref-${seq}`, o.unit ?? 1000],
    );
    return price.rows[0].id;
  }

  async function draftInput(o: { organizationId?: string; priceId?: string; quantity?: number; extraPriceId?: string } = {}): Promise<NormalisedCreateInvoiceInput> {
    const organizationId = o.organizationId ?? ORG;
    const priceId = o.priceId ?? (await seedRecurringPrice({ organizationId })).priceId;
    const lines = [{ priceId, quantity: o.quantity ?? 1 }];
    if (o.extraPriceId) lines.push({ priceId: o.extraPriceId, quantity: 1 });
    return normaliseCreateInvoiceInput({
      invoiceRequestId: crypto.randomUUID(),
      seller: { type: 'organization', id: organizationId },
      payer: { type: 'user', id: 'user-1' },
      sourceType: 'contract',
      sourceId: `src-${++seq}`,
      issuerSnapshot: { schemaVersion: 1 },
      billToSnapshot: { schemaVersion: 1 },
      lines,
    });
  }
  const create = (input: NormalisedCreateInvoiceInput) => invoices.createDraft(PRODUCER, input, ['TND'], ctx);
  const openInvoice = async (o: Parameters<typeof draftInput>[0] = {}) => {
    const { invoice } = await create(await draftInput(o));
    return (await invoices.issue(invoice.id, producer, { template: 'system:1', locale: 'fr' }, ctx)).invoice;
  };

  /** What Stage 4's dispatcher does, so a test can start from a `requested` request (mirrors invoices.e2e-spec.ts). */
  async function dispatch(requestId: string, paymentId = crypto.randomUUID()): Promise<string> {
    await dbs.tx(async (q) => {
      for (const [from, to, extra] of [['created', 'sending', ''], ['sending', 'requested', `, "paymentId" = '${paymentId}'`]] as const) {
        const { rows: r } = await q.query(`UPDATE payment_request SET status = '${to}'${extra} WHERE id = $1 RETURNING revision`, [requestId]);
        await recordTransition(q, { entityType: 'payment_request', entityId: requestId, from, to, revision: r[0].revision, ctx });
      }
    });
    return paymentId;
  }
  /** A requested payment request for a fresh recurring-line invoice, ready to receive a `payment.succeeded`. */
  async function requestedRecurring(o: Parameters<typeof draftInput>[0] = {}) {
    const open = await openInvoice(o);
    const { request } = await requests.createForInvoice(open.id, producer, ctx);
    const paymentId = await dispatch(request.id);
    return { open, request, paymentId };
  }

  const eventFor = (invoice: { id: string; total: string; currency: string; organizationId?: string | null }, request: { id: string }, paymentId: string, name: PaymentEventFacts['name'] = 'payment.succeeded', over: Partial<PaymentEventFacts> = {}): PaymentEventFacts => ({
    name, source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId: request.id, sourceType: 'invoice', sourceId: invoice.id,
    payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: invoice.organizationId ?? ORG }, organizationId: invoice.organizationId ?? ORG,
    amount: Number(invoice.total), currency: invoice.currency, revision: 1, ...over,
  });
  const succeed = (open: { id: string; total: string; currency: string; organizationId?: string | null }, request: { id: string }, paymentId: string, settledAt: Date, over: Partial<PaymentEventFacts> = {}, eventId = crypto.randomUUID()) =>
    requests.applyPaymentEvent(eventId, eventFor(open, request, paymentId, 'payment.succeeded', over), paymentCtx, settledAt);
  const snapshotFor = (invoice: { id: string; total: string; currency: string; organizationId?: string | null }, request: { id: string }, paymentId: string, closedAt: Date, over: Partial<PaymentSnapshot> = {}): PaymentSnapshot => ({
    paymentId, paymentRequestId: request.id, status: 'succeeded', amount: Number(invoice.total), currency: invoice.currency,
    sourceType: 'invoice', sourceId: invoice.id, payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: invoice.organizationId ?? ORG },
    organizationId: invoice.organizationId ?? ORG, closedAt, ...over,
  });

  // -------------------------------------------------------------------------------------------------------------- tests
  it('1. initial activation: the very first successful recurring payment creates and activates the Subscription, anchored on the authoritative settlement instant', async () => {
    const organizationId = crypto.randomUUID();
    const price = await seedRecurringPrice({ organizationId });
    const { open, request, paymentId } = await requestedRecurring({ organizationId, priceId: price.priceId });
    const settledAt = new Date('2026-06-01T00:00:00Z');
    const result = await succeed(open, request, paymentId, settledAt);
    expect(result).toMatchObject({ outcome: 'applied', subscription: 'settled' });

    const row = await subs.getByOrganization(organizationId);
    expect(row).toMatchObject({
      organizationId, productId: price.productId, priceId: price.priceId, status: 'active',
      currentPeriodStart: settledAt, currentPeriodEnd: addMonthUTC(settledAt), cancelAtPeriodEnd: false,
    });
    const history = (await admin.query(`SELECT "fromStatus", "toStatus", revision FROM billing_transition WHERE "entityType"='subscription' AND "entityId"=$1 ORDER BY revision`, [row.id])).rows;
    expect(history).toEqual([{ fromStatus: null, toStatus: 'pending', revision: 0 }, { fromStatus: 'pending', toStatus: 'active', revision: 1 }]);
  });

  it('2. renewal: a second genuine successful payment for an already-active Subscription extends the period exactly once, offering unchanged', async () => {
    const organizationId = crypto.randomUUID();
    const price = await seedRecurringPrice({ organizationId });
    const first = await requestedRecurring({ organizationId, priceId: price.priceId });
    const firstSettledAt = new Date('2026-06-01T00:00:00Z');
    await succeed(first.open, first.request, first.paymentId, firstSettledAt);

    const second = await requestedRecurring({ organizationId, priceId: price.priceId });
    const secondSettledAt = new Date('2026-06-20T00:00:00Z'); // early renewal, still inside the first period
    const result = await succeed(second.open, second.request, second.paymentId, secondSettledAt);
    expect(result.subscription).toBe('settled');

    const row = await subs.getByOrganization(organizationId);
    expect(row).toMatchObject({ productId: price.productId, priceId: price.priceId, status: 'active', currentPeriodStart: addMonthUTC(firstSettledAt), currentPeriodEnd: addMonthUTC(firstSettledAt, 2) });
  });

  it('3. duplicate delivery of the SAME event has no additional commercial effect (idempotency via payment_event_receipt)', async () => {
    const organizationId = crypto.randomUUID();
    const { open, request, paymentId } = await requestedRecurring({ organizationId });
    const settledAt = new Date('2026-06-01T00:00:00Z');
    const eventId = crypto.randomUUID();
    const first = await succeed(open, request, paymentId, settledAt, {}, eventId);
    const rowAfterFirst = await subs.getByOrganization(organizationId);

    const second = await succeed(open, request, paymentId, settledAt, {}, eventId); // SAME eventId: a redelivery
    expect(second).toMatchObject({ firstDelivery: false, outcome: first.outcome });
    const rowAfterSecond = await subs.getByOrganization(organizationId);
    expect(rowAfterSecond).toEqual(rowAfterFirst); // byte-identical: no second period extension, no extra revision
  });

  it('4. concurrent duplicate delivery of the SAME event (real PostgreSQL contention): exactly one commercial effect', async () => {
    const organizationId = crypto.randomUUID();
    const { open, request, paymentId } = await requestedRecurring({ organizationId });
    const settledAt = new Date('2026-06-01T00:00:00Z');
    const eventId = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => succeed(open, request, paymentId, settledAt, {}, eventId)));
    expect(results.filter((r) => r.firstDelivery)).toHaveLength(1);
    expect(results.every((r) => r.subscription === 'settled' || r.subscription === null)).toBe(true);
    const row = await subs.getByOrganization(organizationId);
    expect(row.revision).toBe(1); // create(0) + exactly one activation, never lost, never doubled
    expect(row.currentPeriodEnd).toEqual(addMonthUTC(settledAt));
  });

  it('5. two genuine distinct payments both apply, stacking periods (idempotency is event-identity based, never organization-wide)', async () => {
    const organizationId = crypto.randomUUID();
    const price = await seedRecurringPrice({ organizationId });
    const a = await requestedRecurring({ organizationId, priceId: price.priceId });
    const aAt = new Date('2026-06-01T00:00:00Z');
    await succeed(a.open, a.request, a.paymentId, aAt); // eventId A

    const b = await requestedRecurring({ organizationId, priceId: price.priceId });
    const bAt = new Date('2026-07-01T00:00:00Z'); // exactly at the first period's end: an on-time renewal
    await succeed(b.open, b.request, b.paymentId, bAt); // eventId B, distinct from A

    const row = await subs.getByOrganization(organizationId);
    expect(row.revision).toBe(2); // create(0), activate(1), renew(2) — two genuine effects, not deduplicated
    expect(row.currentPeriodEnd).toEqual(addMonthUTC(aAt, 2));
  });

  it('6. amount mismatch: no Subscription effect at all, exactly like the existing financial conflict behavior', async () => {
    const organizationId = crypto.randomUUID();
    const { open, request, paymentId } = await requestedRecurring({ organizationId });
    const result = await succeed(open, request, paymentId, new Date(), { amount: Number(open.total) + 1 });
    expect(result).toMatchObject({ outcome: 'conflict', detail: 'amount_mismatch', subscription: null });
    await expect(subs.getByOrganization(organizationId)).rejects.toMatchObject({ status: 404 });
  });

  it('7. currency mismatch: no Subscription effect', async () => {
    const organizationId = crypto.randomUUID();
    await admin.query(`INSERT INTO currency (code, exponent) VALUES ('USD', 2) ON CONFLICT DO NOTHING`);
    const { open, request, paymentId } = await requestedRecurring({ organizationId });
    const result = await succeed(open, request, paymentId, new Date(), { currency: 'USD' });
    expect(result).toMatchObject({ outcome: 'conflict', detail: 'amount_mismatch', subscription: null }); // decidePaymentEvent checks amount+currency together
    await expect(subs.getByOrganization(organizationId)).rejects.toMatchObject({ status: 404 });
  });

  it('8. offering mismatch: a settled payment for a DIFFERENT product/price than the organization\'s existing Subscription is a reported conflict, never a silent renewal or offering mutation — but the underlying financial settlement still commits', async () => {
    const organizationId = crypto.randomUUID();
    const priceA = await seedRecurringPrice({ organizationId });
    const first = await requestedRecurring({ organizationId, priceId: priceA.priceId });
    await succeed(first.open, first.request, first.paymentId, new Date('2026-06-01T00:00:00Z'));
    const before = await subs.getByOrganization(organizationId);

    const priceB = await seedRecurringPrice({ organizationId }); // a different product AND price
    const second = await requestedRecurring({ organizationId, priceId: priceB.priceId });
    const result = await succeed(second.open, second.request, second.paymentId, new Date('2026-06-15T00:00:00Z'));

    expect(result).toMatchObject({ outcome: 'applied', subscription: 'conflict' }); // the payment/invoice itself still settled
    const secondInvoice = (await admin.query(`SELECT status FROM invoice WHERE id = $1`, [second.open.id])).rows[0];
    expect(secondInvoice.status).toBe('paid'); // financial fact recorded regardless of the commercial classification outcome
    const after = await subs.getByOrganization(organizationId);
    expect(after).toEqual(before); // the EXISTING subscription's offering and period are completely untouched
  });

  it('9. non-recurring (one-time) payment: never creates, activates or touches any Subscription', async () => {
    const organizationId = crypto.randomUUID();
    const priceId = await seedOneTimePrice({ organizationId });
    const { open, request, paymentId } = await requestedRecurring({ organizationId, priceId });
    const result = await succeed(open, request, paymentId, new Date());
    expect(result).toMatchObject({ outcome: 'applied', subscription: null });
    await expect(subs.getByOrganization(organizationId)).rejects.toMatchObject({ status: 404 });
    expect((await admin.query(`SELECT status FROM invoice WHERE id = $1`, [open.id])).rows[0].status).toBe('paid'); // the sale itself is unaffected
  });

  it('Stage 12.4 R1: a multi-line invoice with MORE THAN ONE recurring line can never reach Payment settlement at all — rejected at draft creation, before any PaymentRequest or Subscription obligation exists', async () => {
    const organizationId = crypto.randomUUID();
    const priceA = await seedRecurringPrice({ organizationId });
    const priceB = await seedRecurringPrice({ organizationId });
    await expect(create(await draftInput({ organizationId, priceId: priceA.priceId, extraPriceId: priceB.priceId }))).rejects.toMatchObject({ status: 422, response: { code: 'ambiguous_subscription_obligation' } });
    await expect(subs.getByOrganization(organizationId)).rejects.toMatchObject({ status: 404 });
  });

  it('an invoice with no organizationId is never treated as a Subscription obligation, even with a recurring line', async () => {
    seq += 1;
    const companyId = `company-${seq}`;
    const product = await admin.query(
      `INSERT INTO product (producer, "sellerType", "sellerId", code, name, status) VALUES ('test-producer', 'company', $1, $2, $3, 'active') RETURNING id`,
      [companyId, `company-sub-${seq}`, `Company subscription ${seq}`],
    );
    const price = await admin.query(
      `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, $2, 'TND', 5000, 'recurring', 'month', 1) RETURNING id`,
      [product.rows[0].id, `ref-${seq}`],
    );
    const input = normaliseCreateInvoiceInput({
      invoiceRequestId: crypto.randomUUID(), seller: { type: 'company', id: companyId }, payer: { type: 'user', id: 'user-1' },
      sourceType: 'contract', sourceId: `src-${++seq}`, issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 },
      lines: [{ priceId: price.rows[0].id, quantity: 1 }],
    });
    const { invoice } = await create(input);
    const open = (await invoices.issue(invoice.id, producer, { template: 'system:1', locale: 'fr' }, ctx)).invoice;
    expect(open.organizationId).toBeNull();
    const { request } = await requests.createForInvoice(open.id, producer, ctx);
    const paymentId = await dispatch(request.id);
    const result = await requests.applyPaymentEvent(
      crypto.randomUUID(),
      { name: 'payment.succeeded', source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId: request.id, sourceType: 'invoice', sourceId: open.id,
        payer: { type: 'user', id: 'user-1' }, seller: { type: 'company', id: companyId }, organizationId: null, amount: Number(open.total), currency: open.currency, revision: 1 },
      paymentCtx, new Date(),
    );
    expect(result).toMatchObject({ outcome: 'applied', subscription: null });
  });

  it('10. grace renewal: a payment settling WHILE the paid period has ended but the precomputed grace window is still open anchors on the ORIGINAL period end, never on the settlement instant', async () => {
    const organizationId = crypto.randomUUID();
    const price = await seedRecurringPrice({ organizationId });
    const first = await requestedRecurring({ organizationId, priceId: price.priceId });
    const firstSettledAt = new Date('2026-06-01T00:00:00Z');
    await succeed(first.open, first.request, first.paymentId, firstSettledAt);
    const activated = await subs.getByOrganization(organizationId);
    expect(activated.graceUntil).not.toBeNull(); // precomputed at activation (Stage 12.2 R1), test app default grace = 7 days

    const second = await requestedRecurring({ organizationId, priceId: price.priceId });
    const lateSettledAt = new Date(activated.currentPeriodEnd!.getTime() + 3 * day); // inside grace, past period end
    await succeed(second.open, second.request, second.paymentId, lateSettledAt);

    const row = await subs.getByOrganization(organizationId);
    expect(row.currentPeriodStart).toEqual(activated.currentPeriodEnd); // anchored on the ORIGINAL end, not on lateSettledAt
    expect(row.currentPeriodEnd).toEqual(addMonthUTC(activated.currentPeriodEnd!));
  });

  it('11. late renewal: a payment settling AFTER the grace window has fully elapsed anchors on the authoritative settlement instant itself, with no back-charging', async () => {
    const organizationId = crypto.randomUUID();
    const price = await seedRecurringPrice({ organizationId });
    const first = await requestedRecurring({ organizationId, priceId: price.priceId });
    const firstSettledAt = new Date('2026-06-01T00:00:00Z');
    await succeed(first.open, first.request, first.paymentId, firstSettledAt);
    const activated = await subs.getByOrganization(organizationId);

    const second = await requestedRecurring({ organizationId, priceId: price.priceId });
    const wayLateSettledAt = new Date(activated.graceUntil!.getTime() + 5 * day); // past grace entirely
    await succeed(second.open, second.request, second.paymentId, wayLateSettledAt);

    const row = await subs.getByOrganization(organizationId);
    expect(row.currentPeriodStart).toEqual(wayLateSettledAt); // anchored on settlement, not on the old (long-elapsed) boundary
    expect(row.currentPeriodEnd).toEqual(addMonthUTC(wayLateSettledAt));
  });

  it('12. failure events (failed/cancelled/expired) never activate a pending Subscription and never touch an existing one\'s period or grace', async () => {
    for (const name of ['payment.failed', 'payment.cancelled', 'payment.expired'] as const) {
      const organizationId = crypto.randomUUID();
      const { open, request, paymentId } = await requestedRecurring({ organizationId });
      const result = await requests.applyPaymentEvent(crypto.randomUUID(), eventFor(open, request, paymentId, name), paymentCtx, new Date());
      expect(result).toMatchObject({ outcome: 'applied', subscription: null }); // never even attempted: invoiceTo is null for these
      await expect(subs.getByOrganization(organizationId)).rejects.toMatchObject({ status: 404 }); // the pending row from requestedRecurring's flow was never even created
    }

    // an already-ACTIVE subscription: a later failure/cancellation must not change its period or grace either
    const organizationId = crypto.randomUUID();
    const price = await seedRecurringPrice({ organizationId });
    const first = await requestedRecurring({ organizationId, priceId: price.priceId });
    await succeed(first.open, first.request, first.paymentId, new Date('2026-06-01T00:00:00Z'));
    const before = await subs.getByOrganization(organizationId);

    const second = await requestedRecurring({ organizationId, priceId: price.priceId });
    await requests.applyPaymentEvent(crypto.randomUUID(), eventFor(second.open, second.request, second.paymentId, 'payment.failed'), paymentCtx, new Date());
    const after = await subs.getByOrganization(organizationId);
    expect(after).toEqual(before);
  });

  it('13. transaction atomicity: the receipt, the financial transition and the Subscription effect commit or roll back as ONE unit', async () => {
    const organizationId = crypto.randomUUID();
    const { open, request, paymentId } = await requestedRecurring({ organizationId });
    const settledAt = new Date('2026-06-01T00:00:00Z');
    // Force the Subscription step to fail with a genuine (non-conflict, non-recoverable) error, inside the SAME
    // transaction as the financial effect: retiring the invoice's own price makes `createTx`'s insert-guard trigger
    // raise. `retiredAt` is itself set-once (BI-06), so this is deliberately irreversible — the point is to prove the
    // WHOLE transaction, including the receipt and the invoice/payment_request transition already performed earlier
    // in this SAME call, rolls back together, not to demonstrate a subsequent recovery (already proven by every
    // other passing scenario in this file).
    await admin.query(`UPDATE price SET "retiredAt" = now() WHERE id = (SELECT "priceId" FROM invoice_line WHERE "invoiceId" = $1)`, [open.id]);
    await expect(succeed(open, request, paymentId, settledAt)).rejects.toMatchObject({ code: '23514' });

    // nothing committed: no receipt, the request/invoice are exactly as they were before the failed attempt
    expect((await admin.query(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [request.id])).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT status FROM payment_request WHERE id = $1`, [request.id])).rows[0].status).toBe('requested');
    expect((await admin.query(`SELECT status FROM invoice WHERE id = $1`, [open.id])).rows[0].status).toBe('open');

    // a retry of the SAME event fails identically and deterministically — no partial state accumulated across attempts
    await expect(succeed(open, request, paymentId, settledAt)).rejects.toMatchObject({ code: '23514' });
    expect((await admin.query(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [request.id])).rows[0].n).toBe(0);
  });

  it('14. end-to-end through the REAL PaymentEventConsumer/EventBus wiring: the occurredAt header reaches the Subscription anchor unchanged', async () => {
    const organizationId = crypto.randomUUID();
    const { open, request, paymentId } = await requestedRecurring({ organizationId });
    const settledAt = new Date('2026-06-01T00:00:00Z');
    const facts = eventFor(open, request, paymentId);
    const { name, source, ...payload } = facts;
    const envelope: EventEnvelope = { id: crypto.randomUUID(), name, payload: payload as Record<string, unknown>, headers: { eventId: crypto.randomUUID(), occurredAt: settledAt.toISOString(), source, version: 1 } };
    await t.bus.publish(envelope);

    const row = await subs.getByOrganization(organizationId);
    expect(row).toMatchObject({ status: 'active', currentPeriodStart: settledAt, currentPeriodEnd: addMonthUTC(settledAt) });
  });

  it('15. Stage 12.4 R2: the reconciliation path anchors on `snapshot.closedAt`, converging on the IDENTICAL Subscription anchor a live event for the same settlement instant would produce', async () => {
    const settledAt = new Date('2026-06-01T00:00:00Z');

    // organization A: settled through the normal live-event path
    const liveOrg = crypto.randomUUID();
    const live = await requestedRecurring({ organizationId: liveOrg });
    await succeed(live.open, live.request, live.paymentId, settledAt);
    const liveRow = await subs.getByOrganization(liveOrg);

    // organization B: the SAME settlement instant, but observed by the reconciler reading Payment's GET response
    const reconciledOrg = crypto.randomUUID();
    const reconciled = await requestedRecurring({ organizationId: reconciledOrg });
    const snapshot = snapshotFor(reconciled.open, reconciled.request, reconciled.paymentId, settledAt);
    const result = await requests.applyReconciledSnapshot(snapshot, paymentCtx);
    expect(result).toMatchObject({ outcome: 'applied' });
    const reconciledRow = await subs.getByOrganization(reconciledOrg);

    // both anchor on the SAME settledAt instant, not on Billing's own processing time (`new Date()` at call time)
    expect(reconciledRow.currentPeriodStart).toEqual(settledAt);
    expect(reconciledRow.currentPeriodEnd).toEqual(addMonthUTC(settledAt));
    expect(reconciledRow).toMatchObject({ status: liveRow.status, currentPeriodStart: liveRow.currentPeriodStart, currentPeriodEnd: liveRow.currentPeriodEnd });
  });

  it('Stage 12.4 R2: a repeated reconciliation tick observing the SAME terminal status is idempotent (deterministic per-status event id), even though `closedAt` never changes across ticks', async () => {
    const organizationId = crypto.randomUUID();
    const settledAt = new Date('2026-06-01T00:00:00Z');
    const { open, request, paymentId } = await requestedRecurring({ organizationId });
    const snapshot = snapshotFor(open, request, paymentId, settledAt);

    const first = await requests.applyReconciledSnapshot(snapshot, paymentCtx);
    expect(first).toMatchObject({ outcome: 'applied', firstDelivery: true });
    const second = await requests.applyReconciledSnapshot(snapshot, paymentCtx);
    expect(second).toMatchObject({ outcome: 'applied', firstDelivery: false });

    const row = await subs.getByOrganization(organizationId);
    expect(row).toMatchObject({ currentPeriodStart: settledAt, currentPeriodEnd: addMonthUTC(settledAt) }); // no double-application
  });
});
