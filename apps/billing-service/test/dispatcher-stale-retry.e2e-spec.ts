import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import type { Caller, TransitionContext } from '../src/domain/actors.js';
import { normaliseCreateInvoiceInput } from '../src/domain/invoice-input.js';
import type { PaymentCreateBody } from '../src/domain/payment-request-mapping.js';
import { InvoiceRepository } from '../src/invoices/invoice.repository.js';
import { PaymentRequestRepository } from '../src/invoices/payment-request.repository.js';
import type { CancelPaymentOutcome, CreatePaymentOutcome, PaymentClient, PaymentSnapshot } from '../src/payment-integration/payment-client.js';
import { PaymentDispatcher } from '../src/payment-integration/payment-dispatcher.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

/**
 * Audit finding L-12: a stale `sending` request that is re-claimed must get a fresh `sendingSince`, so `staleSendingMs` is the interval
 * between two attempts at it. Without that, the re-claimed row is still stale on the very next pass, is re-claimed again, and requests that
 * always fail transiently keep the head of `ORDER BY createdAt LIMIT batch` for ever, starving the requests behind them.
 * This suite has its OWN database, so no other test's rows can be in the way of the head-of-queue assertions.
 */
const ORG = '00000000-0000-4000-8000-0000000000c4';
const PRODUCER = 'test-producer';
const producer: Caller = { kind: 'service', service: PRODUCER };
const ctx: TransitionContext = { actor: { type: 'service', id: PRODUCER }, cause: { type: 'request', id: 'req-l12' }, correlationId: 'corr-l12' };
const STALE_MS = 60_000;

/** Scripted by request id; an unconfigured request gets `transient`, like the real client for something it cannot send. */
class ScriptedPayment implements PaymentClient {
  calls: string[] = [];
  private readonly outcomes = new Map<string, CreatePaymentOutcome>();
  when(requestId: string, outcome: CreatePaymentOutcome): void {
    this.outcomes.set(requestId, outcome);
  }
  async createPayment(body: PaymentCreateBody): Promise<CreatePaymentOutcome> {
    this.calls.push(body.paymentRequestId);
    return this.outcomes.get(body.paymentRequestId) ?? { kind: 'transient' };
  }
  async getPayment(): Promise<PaymentSnapshot | null> {
    return null;
  }
  async cancelPayment(): Promise<CancelPaymentOutcome> {
    return { kind: 'cancelled' };
  }
  callsFor(id: string): number {
    return this.calls.filter((c) => c === id).length;
  }
}

describeWithEnv('dispatcher stale-retry interval (audit L-12, real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let invoices: InvoiceRepository;
  let requests: PaymentRequestRepository;
  let dispatcher: PaymentDispatcher;
  const payment = new ScriptedPayment();

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingstale');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    t = await createTestApp({ databaseUrl: db.url, paymentClient: payment });
    invoices = t.app.get(InvoiceRepository);
    requests = t.app.get(PaymentRequestRepository);
    dispatcher = t.app.get(PaymentDispatcher);
  });
  afterAll(async () => {
    await t.app.close();
    await admin.end();
    await db.drop();
  });

  let seq = 0;
  /** A fresh `created` payment request on its own open invoice. */
  async function newRequest(): Promise<{ id: string; invoice: { id: string; total: string; currency: string } }> {
    seq += 1;
    const product = await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status) VALUES ($1, 'organization', $2, $3, $4, 'active') RETURNING id`, [PRODUCER, ORG, `p-${seq}`, `Product ${seq}`]);
    const price = await admin.query(
      `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "effectiveFrom") VALUES ($1, $2, 'TND', 1500, 'one_time', now()) RETURNING id`,
      [product.rows[0].id, `ref-${seq}`],
    );
    const input = normaliseCreateInvoiceInput({
      invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: ORG }, payer: { type: 'user', id: 'user-1' }, sourceType: 'contract', sourceId: `src-${seq}`,
      issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: price.rows[0].id, quantity: 1 }],
    });
    const { invoice: draft } = await invoices.createDraft(PRODUCER, input, ['TND'], ctx);
    const invoice = (await invoices.issue(draft.id, producer, { template: 'system:1', locale: 'fr' }, ctx)).invoice;
    const { request } = await requests.createForInvoice(invoice.id, producer, ctx);
    return { id: request.id, invoice };
  }
  const row = async (id: string) => (await admin.query(`SELECT status, "sendAttempts", "sendingSince", now() - "sendingSince" AS age FROM payment_request WHERE id = $1`, [id])).rows[0];
  /** Makes the row's last send look `seconds` old, as if that much time had passed (`sendingSince` is server-controlled; the test stands in for the clock). */
  const ageBy = (ids: string[], seconds: number) => admin.query(`UPDATE payment_request SET "sendingSince" = now() - make_interval(secs => $2) WHERE id = ANY($1::uuid[])`, [ids, seconds]);
  const claimedIds = async (limit: number, staleMs = STALE_MS) => (await requests.claimForDispatch(limit, staleMs, ctx)).map((c) => c.request.id);
  const ageSeconds = async (id: string) => Number((await admin.query(`SELECT extract(epoch from now() - "sendingSince") AS s FROM payment_request WHERE id = $1`, [id])).rows[0].s);

  it('re-claiming a stale `sending` request stamps a fresh sendingSince (it is no longer stale), while a first claim behaves as before', async () => {
    const r = await newRequest();
    expect(await claimedIds(50)).toContain(r.id); // created -> sending
    const first = await row(r.id);
    expect(first).toMatchObject({ status: 'sending', sendAttempts: 1 });
    expect(await ageSeconds(r.id)).toBeLessThan(5);

    await ageBy([r.id], 600); // stale by ten minutes
    const reclaim = await requests.claimForDispatch(50, STALE_MS, ctx);
    expect(reclaim.find((c) => c.request.id === r.id)?.wasStale).toBe(true);
    expect(await ageSeconds(r.id)).toBeLessThan(5); // refreshed: before the fix this stayed at ~600 s
    expect(await row(r.id)).toMatchObject({ status: 'sending', sendAttempts: 2 }); // status and the attempt counter behave exactly as before
  });

  it('a request that was just retried is NOT claimed again on the next pass, and is eligible once the interval has passed', async () => {
    const r = await newRequest();
    await claimedIds(50);
    await ageBy([r.id], 600);
    expect(await claimedIds(50)).toContain(r.id); // the stale retry
    expect(await claimedIds(50)).not.toContain(r.id); // straight away: not stale any more (before the fix it was claimed on every pass)
    expect(await claimedIds(50)).not.toContain(r.id);

    await ageBy([r.id], STALE_MS / 1000 + 1); // the interval has elapsed
    expect(await claimedIds(50)).toContain(r.id);
    expect((await row(r.id)).sendAttempts).toBe(3);
  });

  it('requests that always fail transiently no longer pin the head of the batch: the healthy ones behind them are dispatched (batch 3, 3 poisoned + 3 healthy)', async () => {
    const poisoned = [await newRequest(), await newRequest(), await newRequest()];
    const healthy = [await newRequest(), await newRequest(), await newRequest()];
    // the poisoned ones are OLDER, so they head `ORDER BY createdAt`; an unconfigured request answers `transient` every time
    for (const h of healthy) payment.when(h.id, { kind: 'accepted', snapshot: { paymentId: crypto.randomUUID(), paymentRequestId: h.id, status: 'pending', amount: Number(h.invoice.total), currency: h.invoice.currency, sourceType: 'invoice', sourceId: h.invoice.id, payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: ORG }, organizationId: ORG, closedAt: null } });
    const before = (id: string) => payment.callsFor(id);

    await dispatcher.dispatchOnce(STALE_MS, 3); // pass 1: the three poisoned ones (the head), all transient
    for (const p of poisoned) expect(before(p.id)).toBe(1);
    for (const h of healthy) expect(before(h.id)).toBe(0);

    await ageBy(poisoned.map((p) => p.id), 600); // the stale interval passes: they are due a retry
    await dispatcher.dispatchOnce(STALE_MS, 3); // pass 2: the stale retry of the poisoned three, still failing
    for (const p of poisoned) expect(before(p.id)).toBe(2);
    for (const h of healthy) expect(before(h.id)).toBe(0);

    await dispatcher.dispatchOnce(STALE_MS, 3); // pass 3, NO time has passed: the poisoned ones are not stale again, so the head is free
    for (const p of poisoned) expect(before(p.id)).toBe(2); // not retried again straight away (before the fix: 3)
    for (const h of healthy) expect(before(h.id)).toBe(1); // reached at last (before the fix: 0, for ever)
    for (const h of healthy) expect((await row(h.id)).status).toBe('requested');
  });

  it('a transient failure still leaves the request `sending` (the existing failure semantics), and a thrown error for one claim does not block the others in the pass', async () => {
    const a = await newRequest();
    const b = await newRequest();
    const original = payment.createPayment.bind(payment);
    payment.createPayment = async (body) => {
      if (body.paymentRequestId === a.id) throw new Error('connection reset (simulated)');
      return original(body);
    };
    payment.when(b.id, { kind: 'accepted', snapshot: { paymentId: crypto.randomUUID(), paymentRequestId: b.id, status: 'pending', amount: Number(b.invoice.total), currency: b.invoice.currency, sourceType: 'invoice', sourceId: b.invoice.id, payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: ORG }, organizationId: ORG, closedAt: null } });
    try {
      await dispatcher.dispatchOnce(STALE_MS, 50);
    } finally {
      payment.createPayment = original;
    }
    expect((await row(a.id)).status).toBe('sending'); // left as it was, to be retried when stale
    expect((await row(b.id)).status).toBe('requested'); // the other claim in the same pass was unaffected
  });

  it('two dispatchers claiming at the same moment never claim the same request (FOR UPDATE SKIP LOCKED is unchanged)', async () => {
    const created = [await newRequest(), await newRequest(), await newRequest(), await newRequest()].map((r) => r.id);
    const [x, y] = await Promise.all([claimedIds(2), claimedIds(2)]);
    expect(x.filter((id) => y.includes(id))).toEqual([]);
    expect(new Set([...x, ...y].filter((id) => created.includes(id))).size).toBe(x.length + y.length); // no request twice, none lost
  });

  it('Stage 15.8: while one instance sends a batch to a slow Payment, another instance never re-claims its unsent requests: each is sent ONCE (two instances, 20 iterations)', async () => {
    // Scaled: stale window 1 s, Payment 300 ms per call, batch 6 → the batch takes 1.8 s, longer than the stale window. Before Stage 15.8
    // every row of the batch kept its claim-time `sendingSince`, so the second instance re-claimed and re-sent the rows still waiting.
    const STALE = 1000;
    const BATCH = 6;
    const calls = new Map<string, number>();
    const slow: PaymentClient = {
      createPayment: async (body: PaymentCreateBody) => {
        calls.set(body.paymentRequestId, (calls.get(body.paymentRequestId) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 300));
        return { kind: 'accepted', snapshot: { paymentId: crypto.randomUUID(), paymentRequestId: body.paymentRequestId, status: 'pending', amount: body.amount, currency: body.currency, sourceType: 'invoice', sourceId: body.sourceId, payer: body.payer, seller: body.seller, organizationId: body.organizationId ?? null, closedAt: null } };
      },
      getPayment: async () => null,
      cancelPayment: async () => ({ kind: 'cancelled' }),
    };
    const cfg = { dispatch: { intervalMs: 1000, batchSize: BATCH, staleSendingMs: STALE } } as never;
    const a = new PaymentDispatcher(requests, slow, cfg);
    const b = new PaymentDispatcher(requests, slow, cfg);
    await new PaymentDispatcher(requests, slow, cfg).dispatchOnce(0, 1000); // the earlier tests' leftovers out of the way
    for (let i = 0; i < 20; i++) {
      const ids: string[] = [];
      for (let k = 0; k < BATCH; k++) ids.push((await newRequest()).id);
      calls.clear();
      const first = a.dispatchOnce(STALE, BATCH);
      let done = false;
      void first.then(() => (done = true));
      while (!done) {
        await new Promise((r) => setTimeout(r, 100));
        await b.dispatchOnce(STALE, BATCH); // the other instance keeps looking for stale work meanwhile
      }
      for (const id of ids) expect(calls.get(id)).toBe(1); // before Stage 15.8: 2 for the rows sent after the stale window
      for (const id of ids) expect((await row(id)).status).toBe('requested');
    }
  }, 180_000);
});
