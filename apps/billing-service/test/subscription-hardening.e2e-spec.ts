import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
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

/**
 * Stage 12.6: lifecycle/concurrency/idempotency HARDENING of the already-built Payment -> Subscription -> Entitlement
 * chain (Stages 12.2-12.5). This file adds exactly the coverage that file (`payment-subscription-integration.e2e-spec.ts`)
 * does NOT already have — genuine concurrent races (not sequential composition), the live-event-vs-reconciliation race
 * with two DIFFERENT event ids for the SAME settlement, lifecycle-operation races, and cross-connection committed-read
 * isolation — rather than duplicating any already-proven scenario (that file's own section 80 convention). Every
 * concurrency assertion runs against REAL PostgreSQL 16 (no mocks), per repo convention.
 */
describeWithEnv('Subscription lifecycle / concurrency / idempotency hardening (Stage 12.6), against a real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let invoices: InvoiceRepository;
  let requests: PaymentRequestRepository;
  let subs: SubscriptionRepository;
  let dbs: DbService;

  const ORG = '00000000-0000-4000-8000-0000000000c6';
  const PRODUCER = 'test-producer';
  const producer: Caller = { kind: 'service', service: PRODUCER };
  const ctx: TransitionContext = { actor: { type: 'service', id: PRODUCER }, cause: { type: 'request', id: 'req-1' }, correlationId: 'corr-1' };
  const paymentCtx: TransitionContext = { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: 'evt' }, correlationId: 'corr-evt' };
  const day = 86_400_000;
  const addMonthUTC = (d: Date, n = 1): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billinghardening');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 30 });
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

  // ------------------------------------------------------------------------------------------------------------ helpers (mirrors payment-subscription-integration.e2e-spec.ts)
  let seq = 0;
  async function seedRecurringPrice(o: { organizationId?: string; unit?: number } = {}): Promise<{ productId: string; priceId: string }> {
    seq += 1;
    const product = await admin.query(
      `INSERT INTO product (producer, "sellerType", "sellerId", code, name, status) VALUES ('test-producer', 'organization', $1, $2, $3, 'active') RETURNING id`,
      [o.organizationId ?? ORG, `sub-prod-${seq}-${Math.random().toString(36).slice(2, 8)}`, `Subscription product ${seq}`],
    );
    const price = await admin.query(
      `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, $2, 'TND', $3, 'recurring', 'month', 1) RETURNING id`,
      [product.rows[0].id, `ref-${seq}`, o.unit ?? 5000],
    );
    return { productId: product.rows[0].id, priceId: price.rows[0].id };
  }
  async function draftInput(o: { organizationId?: string; priceId?: string } = {}): Promise<NormalisedCreateInvoiceInput> {
    const organizationId = o.organizationId ?? ORG;
    const priceId = o.priceId ?? (await seedRecurringPrice({ organizationId })).priceId;
    return normaliseCreateInvoiceInput({
      invoiceRequestId: crypto.randomUUID(),
      seller: { type: 'organization', id: organizationId },
      payer: { type: 'user', id: 'user-1' },
      sourceType: 'contract',
      sourceId: `src-${++seq}`,
      issuerSnapshot: { schemaVersion: 1 },
      billToSnapshot: { schemaVersion: 1 },
      lines: [{ priceId, quantity: 1 }],
    });
  }
  const create = (input: NormalisedCreateInvoiceInput) => invoices.createDraft(PRODUCER, input, ['TND'], ctx);
  const openInvoice = async (o: Parameters<typeof draftInput>[0] = {}) => {
    const { invoice } = await create(await draftInput(o));
    return (await invoices.issue(invoice.id, producer, { template: 'system:1', locale: 'fr' }, ctx)).invoice;
  };
  async function dispatch(requestId: string, paymentId = crypto.randomUUID()): Promise<string> {
    await dbs.tx(async (q) => {
      for (const [from, to, extra] of [['created', 'sending', ''], ['sending', 'requested', `, "paymentId" = '${paymentId}'`]] as const) {
        const { rows: r } = await q.query(`UPDATE payment_request SET status = '${to}'${extra} WHERE id = $1 RETURNING revision`, [requestId]);
        await recordTransition(q, { entityType: 'payment_request', entityId: requestId, from, to, revision: r[0].revision, ctx });
      }
    });
    return paymentId;
  }
  async function requestedRecurring(o: Parameters<typeof draftInput>[0] = {}) {
    const open = await openInvoice(o);
    const { request } = await requests.createForInvoice(open.id, producer, ctx);
    const paymentId = await dispatch(request.id);
    return { open, request, paymentId };
  }
  const eventFor = (invoice: { id: string; total: string; currency: string; organizationId?: string | null }, request: { id: string }, paymentId: string, over: Partial<PaymentEventFacts> = {}): PaymentEventFacts => ({
    name: 'payment.succeeded', source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId: request.id, sourceType: 'invoice', sourceId: invoice.id,
    payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: invoice.organizationId ?? ORG }, organizationId: invoice.organizationId ?? ORG,
    amount: Number(invoice.total), currency: invoice.currency, revision: 1, ...over,
  });
  const succeed = (open: { id: string; total: string; currency: string; organizationId?: string | null }, request: { id: string }, paymentId: string, settledAt: Date, eventId = crypto.randomUUID()) =>
    requests.applyPaymentEvent(eventId, eventFor(open, request, paymentId), paymentCtx, settledAt);
  const snapshotFor = (invoice: { id: string; total: string; currency: string; organizationId?: string | null }, request: { id: string }, paymentId: string, closedAt: Date): PaymentSnapshot => ({
    paymentId, paymentRequestId: request.id, status: 'succeeded', amount: Number(invoice.total), currency: invoice.currency,
    sourceType: 'invoice', sourceId: invoice.id, payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: invoice.organizationId ?? ORG },
    organizationId: invoice.organizationId ?? ORG, closedAt,
  });
  const org = () => crypto.randomUUID();

  // ============================================================================================================== A. concurrent distinct renewals (section 11/33)
  it('A. concurrent distinct renewal purchases for the SAME organization/offering: neither purchased period is lost, regardless of lock-acquisition order', async () => {
    const organizationId = org();
    const price = await seedRecurringPrice({ organizationId });
    const first = await requestedRecurring({ organizationId, priceId: price.priceId });
    const anchor = new Date('2026-06-01T00:00:00Z');
    await succeed(first.open, first.request, first.paymentId, anchor); // activation: end = Jul 1

    // Two MORE genuine, distinct renewal purchases, settling concurrently, both while still within the active period
    // (early renewals: `renewalAnchor` anchors each on whatever currentPeriodEnd it observes AT LOCK TIME, so they
    // must stack onto EACH OTHER, not just onto the original activation).
    const b = await requestedRecurring({ organizationId, priceId: price.priceId });
    const c = await requestedRecurring({ organizationId, priceId: price.priceId });
    const results = await Promise.all([succeed(b.open, b.request, b.paymentId, new Date('2026-06-10T00:00:00Z')), succeed(c.open, c.request, c.paymentId, new Date('2026-06-11T00:00:00Z'))]);
    expect(results.every((r) => r.outcome === 'applied' && r.subscription === 'settled')).toBe(true); // both are genuine distinct effects, neither a duplicate

    const row = await subs.getByOrganization(organizationId);
    expect(row.revision).toBe(3); // create(0) + activate(1) + renew(2) + renew(3): three genuine effects, not deduplicated
    expect(row.currentPeriodEnd).toEqual(addMonthUTC(anchor, 3)); // Jul1 -> Aug1 -> Sep1: BOTH purchased months present, whichever transaction won the lock first
    const history = (await admin.query(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityType"='subscription' AND "entityId"=$1`, [row.id])).rows[0].n;
    expect(history).toBe(4); // pending(0), active(1), active(2), active(3) — one transition per genuine effect, none missing, none duplicated
  });

  // ============================================================================================================== B. concurrent first activation (section 12)
  it('B. concurrent FIRST activation for a brand-new organization: exactly one Subscription row, and BOTH legitimate purchased periods are preserved, never silently lost', async () => {
    const organizationId = org();
    const price = await seedRecurringPrice({ organizationId });
    const a = await requestedRecurring({ organizationId, priceId: price.priceId });
    const b = await requestedRecurring({ organizationId, priceId: price.priceId });
    const aAt = new Date('2026-06-01T00:00:00Z');
    const bAt = new Date('2026-06-02T00:00:00Z');

    const results = await Promise.all([succeed(a.open, a.request, a.paymentId, aAt), succeed(b.open, b.request, b.paymentId, bAt)]);
    expect(results.every((r) => r.outcome === 'applied' && r.subscription === 'settled')).toBe(true);

    expect((await admin.query(`SELECT count(*)::int AS n FROM subscription WHERE "organizationId" = $1`, [organizationId])).rows[0].n).toBe(1); // the unique-organization invariant holds
    const row = await subs.getByOrganization(organizationId);
    expect(row.revision).toBe(2); // create(0) + activation(1) + a genuine second renewal(2) — the SECOND purchase became a renewal, not a lost/duplicate no-op
    // Whichever settlement's INSERT wins the `ON CONFLICT (organizationId) DO NOTHING` race becomes the activation
    // anchor (not necessarily whichever has the chronologically earlier `settledAt` — the race is on lock acquisition,
    // not on the settlement timestamps); the OTHER stacks one full interval on top of THAT anchor. Either way, exactly
    // two full purchased months are present — never one lost, never a silent no-op.
    expect([addMonthUTC(aAt, 2), addMonthUTC(bAt, 2)]).toContainEqual(row.currentPeriodEnd);
  });

  // ============================================================================================================== C. concurrent offering conflict (section 13)
  it('C. concurrent settlements for the SAME brand-new organization but DIFFERENT offerings: exactly one becomes the Subscription, the other is a reported conflict — never silently mutated, and both financial settlements still commit', async () => {
    const organizationId = org();
    const priceA = await seedRecurringPrice({ organizationId });
    const priceB = await seedRecurringPrice({ organizationId });
    const a = await requestedRecurring({ organizationId, priceId: priceA.priceId });
    const b = await requestedRecurring({ organizationId, priceId: priceB.priceId });

    const results = await Promise.all([succeed(a.open, a.request, a.paymentId, new Date('2026-06-01T00:00:00Z')), succeed(b.open, b.request, b.paymentId, new Date('2026-06-02T00:00:00Z'))]);
    expect(results.every((r) => r.outcome === 'applied')).toBe(true); // the underlying financial settlement ALWAYS commits regardless of the commercial classification
    expect(results.filter((r) => r.subscription === 'settled')).toHaveLength(1);
    expect(results.filter((r) => r.subscription === 'conflict')).toHaveLength(1);

    // both invoices are genuinely paid: no commercial obligation silently vanished, it is explicitly flagged instead
    expect((await admin.query(`SELECT status FROM invoice WHERE id = $1`, [a.open.id])).rows[0].status).toBe('paid');
    expect((await admin.query(`SELECT status FROM invoice WHERE id = $1`, [b.open.id])).rows[0].status).toBe('paid');
    expect((await admin.query(`SELECT count(*)::int AS n FROM subscription WHERE "organizationId" = $1`, [organizationId])).rows[0].n).toBe(1);
  });

  // ============================================================================================================== D/E/F. live vs reconciliation race (sections 10, 17-19)
  it('D. CONCURRENT live event and reconciliation tick for the SAME settlement (two DIFFERENT event ids): exactly one Subscription effect, the other observes "already_applied" via request-status gating, never via the receipt table alone', async () => {
    const organizationId = org();
    const { open, request, paymentId } = await requestedRecurring({ organizationId });
    const settledAt = new Date('2026-06-01T00:00:00Z');

    const [live, reconciled] = await Promise.all([
      succeed(open, request, paymentId, settledAt), // eventId: random (the live-consumer path)
      requests.applyReconciledSnapshot(snapshotFor(open, request, paymentId, settledAt), paymentCtx), // eventId: deterministic, DIFFERENT from the live one
    ]);
    const outcomes = [live.outcome, reconciled!.outcome].sort();
    expect(outcomes).toEqual(['applied', 'ignored']); // exactly one of each, whichever order the invoice lock resolved in
    const winner = live.outcome === 'applied' ? live : reconciled!;
    const loser = live.outcome === 'applied' ? reconciled! : live;
    expect(winner.subscription).toBe('settled');
    expect(loser).toMatchObject({ detail: 'already_applied', subscription: null });

    // exactly two receipts exist (different event ids), but exactly ONE Subscription effect
    expect((await admin.query(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [request.id])).rows[0].n).toBe(2);
    const row = await subs.getByOrganization(organizationId);
    expect(row.revision).toBe(1); // create(0) + exactly one activation — never doubled
    expect(row.currentPeriodEnd).toEqual(addMonthUTC(settledAt));
  });

  it('E. reconciliation observes the settlement FIRST, the live event arrives later: no second renewal', async () => {
    const organizationId = org();
    const { open, request, paymentId } = await requestedRecurring({ organizationId });
    const settledAt = new Date('2026-06-01T00:00:00Z');
    const reconciled = await requests.applyReconciledSnapshot(snapshotFor(open, request, paymentId, settledAt), paymentCtx);
    expect(reconciled).toMatchObject({ outcome: 'applied', subscription: 'settled' });

    const live = await succeed(open, request, paymentId, settledAt); // arrives after; DIFFERENT event id
    expect(live).toMatchObject({ outcome: 'ignored', detail: 'already_applied', subscription: null });

    const row = await subs.getByOrganization(organizationId);
    expect(row.revision).toBe(1);
    expect(row.currentPeriodEnd).toEqual(addMonthUTC(settledAt));
  });

  it('F. the live event applies FIRST, reconciliation observes the same settlement later: no second renewal', async () => {
    const organizationId = org();
    const { open, request, paymentId } = await requestedRecurring({ organizationId });
    const settledAt = new Date('2026-06-01T00:00:00Z');
    const live = await succeed(open, request, paymentId, settledAt);
    expect(live).toMatchObject({ outcome: 'applied', subscription: 'settled' });

    const reconciled = await requests.applyReconciledSnapshot(snapshotFor(open, request, paymentId, settledAt), paymentCtx);
    expect(reconciled).toMatchObject({ outcome: 'ignored', detail: 'already_applied', subscription: null });

    const row = await subs.getByOrganization(organizationId);
    expect(row.revision).toBe(1);
    expect(row.currentPeriodEnd).toEqual(addMonthUTC(settledAt));
  });

  // ============================================================================================================== G/H. lifecycle operation races (sections 28, 29)
  it('G. concurrent renew() and terminate() on the same active Subscription: deterministic, valid outcome under either lock order — never a malformed period, never an undefined resurrection', async () => {
    const organizationId = org();
    const price = await seedRecurringPrice({ organizationId });
    await subs.create(organizationId, price.productId, price.priceId, ctx);
    // terminate() anchors `effectiveTerminationAt` to the DATABASE's own real now() (section 31, unlike renew()/activate(),
    // which always take an explicit anchor) — the period must stay comfortably around REAL wall-clock time, not a fixed
    // calendar fixture, or the termination CHECK (`effectiveTerminationAt <= COALESCE(graceUntil, currentPeriodEnd)`) would
    // reject it for reasons that have nothing to do with this race.
    const start = new Date(Date.now() - day);
    const end = new Date(Date.now() + 60 * day);
    const activated = await subs.activate(organizationId, { start, end }, ctx);

    const [renewResult, terminateResult] = await Promise.allSettled([subs.renew(organizationId, new Date(), ctx), subs.terminate(organizationId, ctx)]);
    // Both operations are ALWAYS valid on an active subscription (renew: any non-pending status; terminate: active|grace) —
    // whichever wins the row lock first, the second sees the first's already-committed change and proceeds from there.
    expect(renewResult.status).toBe('fulfilled');
    expect(terminateResult.status).toBe('fulfilled');

    const row = await subs.getByOrganization(organizationId);
    if (row.status === 'expired') {
      // renew committed first (extending the period), THEN terminate shortened access from there — an explicit, already-established lifecycle move
      expect(row.effectiveTerminationAt).not.toBeNull();
      expect(row.currentPeriodStart!.getTime()).toBeGreaterThanOrEqual(activated.subscription.currentPeriodEnd!.getTime());
    } else {
      // terminate committed first, THEN renew reactivated it — "expired -> active: a late renewal can always reactivate" (Stage 12.2, already established policy, never invented here)
      expect(row.status).toBe('active');
      expect(row.effectiveTerminationAt).toBeNull(); // force-cleared on the move back into active
    }
    // exactly two more genuine effects on top of create(0)+activate(1): no lost transition, no duplicate
    const history = (await admin.query(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityType"='subscription' AND "entityId"=$1`, [row.id])).rows[0].n;
    expect(history).toBe(row.revision + 1);
  });

  it('H. concurrent renew() and scheduleCancellation() on the same active Subscription: deterministic per the already-established "period change force-clears cancelAtPeriodEnd" policy', async () => {
    const organizationId = org();
    const price = await seedRecurringPrice({ organizationId });
    await subs.create(organizationId, price.productId, price.priceId, ctx);
    await subs.activate(organizationId, { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-07-01T00:00:00Z') }, ctx);

    const [renewResult, cancelResult] = await Promise.allSettled([subs.renew(organizationId, new Date('2026-06-15T00:00:00Z'), ctx), subs.scheduleCancellation(organizationId, ctx)]);
    expect(renewResult.status).toBe('fulfilled');
    expect(cancelResult.status).toBe('fulfilled');

    const row = await subs.getByOrganization(organizationId);
    expect(row.status).toBe('active');
    expect(row.currentPeriodEnd).toEqual(new Date('2026-08-01T00:00:00Z')); // the renewal always applies, whichever order
    // If renew committed AFTER scheduleCancellation, the period change force-clears the flag (DB trigger, 0013_subscription.sql).
    // If renew committed BEFORE scheduleCancellation, the later cancellation is simply recorded on the already-renewed row.
    // Both are well-defined by the EXISTING trigger policy — never a new business decision made here.
    if (row.cancelAtPeriodEnd) {
      expect(cancelResult.status === 'fulfilled' && (cancelResult as PromiseFulfilledResult<Awaited<ReturnType<typeof subs.scheduleCancellation>>>).value.changed).toBe(true);
    }
  });

  // ============================================================================================================== I. lock-order / deadlock (sections 25, 26)
  it('I. SubscriptionRepository.renew() (locks subscription alone) racing a full Payment settlement (locks invoice -> payment_request -> subscription, in that fixed order) for the SAME organization: no deadlock, both effects land', async () => {
    const organizationId = org();
    const price = await seedRecurringPrice({ organizationId });
    const first = await requestedRecurring({ organizationId, priceId: price.priceId });
    const anchor = new Date('2026-06-01T00:00:00Z');
    await succeed(first.open, first.request, first.paymentId, anchor);

    const second = await requestedRecurring({ organizationId, priceId: price.priceId });
    const results = await Promise.allSettled([subs.renew(organizationId, new Date('2026-06-10T00:00:00Z'), ctx), succeed(second.open, second.request, second.paymentId, new Date('2026-06-11T00:00:00Z'))]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true); // no deadlock, no lock-order inversion error

    const row = await subs.getByOrganization(organizationId);
    expect(row.revision).toBe(3); // create(0), activate(1), and BOTH concurrent renewals(2,3)
    expect(row.currentPeriodEnd).toEqual(addMonthUTC(anchor, 3));
  });

  // ============================================================================================================== J. committed-read isolation (sections 45, 46)
  it('J. a Subscription read (SubscriptionRepository.findForOrganization, Stage 12.5\'s own read path) sees only COMMITTED state, never a renewal mid-transaction', async () => {
    const organizationId = org();
    const price = await seedRecurringPrice({ organizationId });
    const first = await requestedRecurring({ organizationId, priceId: price.priceId });
    const anchor = new Date('2026-06-01T00:00:00Z');
    await succeed(first.open, first.request, first.paymentId, anchor);
    const before = await subs.findForOrganization(organizationId);
    expect(before).not.toBeNull();

    // Hold an uncommitted renewal-shaped change open on a SEPARATE connection (raw SQL: no repository method exposes
    // a way to pause mid-transaction). The deferred BI-19 trigger only checks at COMMIT, so the matching transition
    // row can be written any time before that.
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const { rows: locked } = await client.query<{ revision: number }>(`SELECT revision FROM subscription WHERE id = $1 FOR UPDATE`, [before!.id]);
      const newEnd = new Date(before!.currentPeriodEnd!.getTime() + 30 * day);
      const newGrace = new Date(newEnd.getTime() + 7 * day); // must move WITH currentPeriodEnd, or subscription_grace_after_period refuses the write
      await client.query(`UPDATE subscription SET "currentPeriodStart" = "currentPeriodEnd", "currentPeriodEnd" = $2, "graceUntil" = $3 WHERE id = $1`, [before!.id, newEnd, newGrace]);
      await client.query(
        `INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "actorId", "causeType", "correlationId")
         VALUES ('subscription', $1, 'active', 'active', $2, 'service', 'test-producer', 'request', 'corr-hold')`,
        [before!.id, locked[0]!.revision + 1],
      );

      // Read from a DIFFERENT pool connection (exactly what the HTTP entitlement endpoint and every other caller use):
      // MUST see the pre-transaction, committed state — never the uncommitted UPDATE above.
      const duringRead = await subs.findForOrganization(organizationId);
      expect(duringRead).toEqual(before);

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK'); // never leave an aborted transaction on a connection returned to the shared pool
      throw e;
    } finally {
      client.release();
    }

    const afterRead = await subs.findForOrganization(organizationId);
    expect(afterRead!.currentPeriodEnd).toEqual(new Date(before!.currentPeriodEnd!.getTime() + 30 * day)); // now visible, once committed
  });

  // ============================================================================================================== K. tenant isolation under concurrency (section 77)
  it('K. concurrent settlements for THREE different organizations: each Subscription reflects only its OWN settlement, no cross-tenant bleed', async () => {
    const orgs = [org(), org(), org()];
    const seeded = await Promise.all(orgs.map((organizationId) => requestedRecurring({ organizationId })));
    const settledAts = [new Date('2026-06-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z')];
    await Promise.all(seeded.map(({ open, request, paymentId }, i) => succeed(open, request, paymentId, settledAts[i]!)));

    for (let i = 0; i < orgs.length; i++) {
      const row = await subs.getByOrganization(orgs[i]!);
      expect(row.currentPeriodStart).toEqual(settledAts[i]);
      expect(row.currentPeriodEnd).toEqual(addMonthUTC(settledAts[i]!));
    }
  });
});
