import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DbService, OutboxService, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import type { Caller, TransitionContext } from '../src/domain/actors.js';
import { normaliseCreateInvoiceInput, type NormalisedCreateInvoiceInput } from '../src/domain/invoice-input.js';
import type { PaymentEventFacts } from '../src/domain/payment-event-decision.js';
import { InvoiceRepository } from '../src/invoices/invoice.repository.js';
import { PaymentRequestRepository } from '../src/invoices/payment-request.repository.js';
import { recordTransition } from '../src/invoices/transitions.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000b2';
const PRODUCER = 'test-producer';
const producer: Caller = { kind: 'service', service: PRODUCER };
const payer = (id = 'user-1'): Caller => ({ kind: 'user', userId: id });
const ctx: TransitionContext = { actor: { type: 'service', id: PRODUCER }, cause: { type: 'request', id: 'req-1' }, correlationId: 'corr-1' };

describeWithEnv('invoice persistence: domain rules against a real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let invoices: InvoiceRepository;
  let requests: PaymentRequestRepository;
  let dbs: DbService;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billinginv');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 20 });
    await admin.query(`INSERT INTO currency (code, exponent) VALUES ('EUR', 2)`);
    t = await createTestApp({ databaseUrl: db.url });
    invoices = t.app.get(InvoiceRepository);
    requests = t.app.get(PaymentRequestRepository);
    dbs = t.app.get(DbService);
  });
  afterAll(async () => {
    await t.app.close();
    await admin.end();
    await db.drop();
  });
  afterEach(() => vi.restoreAllMocks());

  // ------------------------------------------------------------------------------------------------------------------ helpers
  let seq = 0;
  async function seedPrice(o: { unit?: number; currency?: string; seller?: string; retired?: boolean; future?: boolean; archived?: boolean } = {}): Promise<string> {
    seq += 1;
    const product = await admin.query(
      `INSERT INTO product (producer, "sellerType", "sellerId", code, name, status) VALUES ('test-producer', 'organization', $1, $2, $3, 'active') RETURNING id`,
      [o.seller ?? ORG, `prod-${seq}-${Math.random().toString(36).slice(2, 8)}`, `Product ${seq}`],
    );
    const price = await admin.query(
      `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "effectiveFrom")
       VALUES ($1, $2, $3, $4, 'one_time', ${o.future ? `now() + interval '1 day'` : 'now()'}) RETURNING id`,
      [product.rows[0].id, `ref-${seq}`, o.currency ?? 'TND', o.unit ?? 1500],
    );
    if (o.retired) await admin.query(`UPDATE price SET "retiredAt" = now() WHERE id = $1`, [price.rows[0].id]);
    if (o.archived) await admin.query(`UPDATE product SET status = 'archived' WHERE id = $1`, [product.rows[0].id]);
    return price.rows[0].id;
  }

  async function draftInput(o: { priceId?: string; quantity?: number; payerId?: string; payerType?: string; dueAt?: string; request?: string } = {}): Promise<NormalisedCreateInvoiceInput> {
    const priceId = o.priceId ?? (await seedPrice());
    return normaliseCreateInvoiceInput({
      invoiceRequestId: o.request ?? crypto.randomUUID(),
      seller: { type: 'organization', id: ORG },
      payer: { type: o.payerType ?? 'user', id: o.payerId ?? 'user-1' },
      sourceType: 'contract',
      sourceId: `src-${++seq}`,
      dueAt: o.dueAt,
      issuerSnapshot: { schemaVersion: 1 },
      billToSnapshot: { schemaVersion: 1 },
      lines: [{ priceId, quantity: o.quantity ?? 3 }],
    });
  }

  const create = (input: NormalisedCreateInvoiceInput, supported = ['TND']) => invoices.createDraft(PRODUCER, input, supported, ctx);
  const openInvoice = async (o: Parameters<typeof draftInput>[0] = {}) => {
    const { invoice } = await create(await draftInput(o));
    return (await invoices.issue(invoice.id, producer, { template: 'system:1', locale: 'fr' }, ctx)).invoice;
  };
  const rows = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await admin.query(sql, params)).rows;
  const events = async (invoiceId: string) => rows(`SELECT * FROM outbox WHERE payload->>'invoiceId' = $1`, [invoiceId]);
  const history = async (entityId: string) => rows(`SELECT "fromStatus", "toStatus", revision, "actorType", "actorId", "causeType", "correlationId" FROM billing_transition WHERE "entityId" = $1 ORDER BY revision`, [entityId]);
  const rejects = (p: Promise<unknown>, status: number, code: string) => expect(p).rejects.toMatchObject({ status, response: { code } });

  /** What Stage 4's dispatcher does, so the event tests can start from a `requested` request. */
  async function dispatch(requestId: string, paymentId = crypto.randomUUID()): Promise<string> {
    await dbs.tx(async (q) => {
      for (const [from, to, extra] of [['created', 'sending', ''], ['sending', 'requested', `, "paymentId" = '${paymentId}'`]] as const) {
        const { rows: r } = await q.query(`UPDATE payment_request SET status = '${to}'${extra} WHERE id = $1 RETURNING revision`, [requestId]);
        await recordTransition(q, { entityType: 'payment_request', entityId: requestId, from, to, revision: r[0].revision, ctx });
      }
    });
    return paymentId;
  }

  const eventFor = (invoice: { id: string; total: string; currency: string }, request: { id: string }, paymentId: string, name: PaymentEventFacts['name'] = 'payment.succeeded', over: Partial<PaymentEventFacts> = {}): PaymentEventFacts => ({
    name, source: 'payment-service', paymentId, paymentRequestId: request.id, sourceType: 'invoice', sourceId: invoice.id,
    payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: ORG }, organizationId: ORG,
    amount: Number(invoice.total), currency: invoice.currency, revision: 1, ...over,
  });
  const paymentCtx: TransitionContext = { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: 'evt' }, correlationId: 'corr-evt' };

  // ------------------------------------------------------------------------------------------- creation and the snapshot
  describe('draft creation', () => {
    it('computes every amount server-side from the catalog price and copies what was sold onto the line (BI-05, BI-06)', async () => {
      const price = await seedPrice({ unit: 1500 });
      const { invoice, changed } = await create(await draftInput({ priceId: price, quantity: 3 }));
      expect(changed).toBe(true);
      expect(invoice).toMatchObject({ status: 'draft', currency: 'TND', subtotal: '4500', taxTotal: '0', total: '4500', taxTreatment: 'not_determined', number: null, revision: 0, presentation: null, producer: PRODUCER, isOverdue: false });
      expect(invoice.lines).toHaveLength(1);
      expect(invoice.lines[0]).toMatchObject({ lineNumber: 1, quantity: 3, unitAmount: '1500', lineTotal: '4500', taxAmount: '0', entitlementKind: 'none', interval: 'one_time', currency: 'TND' });
      // the snapshot survives the catalog: nothing on the line reads the price after creation
      const line = await rows(`SELECT "productCode", description FROM invoice_line WHERE "invoiceId" = $1`, [invoice.id]);
      expect(line[0].productCode).toMatch(/^prod-/);
      expect(line[0].description).toMatch(/^Product /);
    });

    it('a draft has a history row, no number and NO event (a draft is never announced)', async () => {
      const { invoice } = await create(await draftInput());
      expect(await history(invoice.id)).toEqual([{ fromStatus: null, toStatus: 'draft', revision: 0, actorType: 'service', actorId: PRODUCER, causeType: 'request', correlationId: 'corr-1' }]);
      expect(await events(invoice.id)).toHaveLength(0);
    });

    it('stores an explicit due date and derives overdue from the DATABASE clock, never from a stored status (BI-19)', async () => {
      const draft = (await create(await draftInput({ dueAt: '2020-01-01T00:00:00Z' }))).invoice;
      expect(draft.isOverdue).toBe(false); // a draft cannot be overdue
      const open = (await invoices.issue(draft.id, producer, { template: 'system:1', locale: 'fr' }, ctx)).invoice;
      expect(open.status).toBe('open');
      expect(open.isOverdue).toBe(true);
      const noDue = await openInvoice();
      expect(noDue.dueAt).toBeNull();
      expect(noDue.isOverdue).toBe(false);
    });

    it.each([
      ['an unknown price', async () => crypto.randomUUID()],
      ['a retired price', () => seedPrice({ retired: true })],
      ['a price that is not yet effective', () => seedPrice({ future: true })],
      ['a price of an archived product', () => seedPrice({ archived: true })],
      ['ANOTHER seller\'s price (never leaks which)', () => seedPrice({ seller: OTHER_ORG })],
    ])('%s is 422 price_not_available and writes nothing', async (_n, make) => {
      const before = (await rows(`SELECT count(*)::int AS n FROM invoice`))[0].n;
      await rejects(create(await draftInput({ priceId: await make() })), 422, 'price_not_available');
      expect((await rows(`SELECT count(*)::int AS n FROM invoice`))[0].n).toBe(before);
    });

    it('mixed currencies are refused; a currency that is not in the configured list is 422 unsupported_currency', async () => {
      const tnd = await seedPrice();
      const eur = await seedPrice({ currency: 'EUR' });
      const input = await draftInput({ priceId: tnd });
      input.lines.push({ priceId: eur, quantity: 1, description: null, sourceType: null, sourceId: null });
      await rejects(create(input), 422, 'price_not_available');
      await rejects(create(await draftInput({ priceId: eur })), 422, 'unsupported_currency');
      expect((await create(await draftInput({ priceId: eur }), ['TND', 'EUR'])).invoice.currency).toBe('EUR'); // supported once configured, and seeded in `currency`
    });

    it('an amount above what Payment and a JSON number can carry is refused, not stored (BI-01)', async () => {
      const price = await seedPrice({ unit: 9_007_199_254_740_991 });
      await expect(create(await draftInput({ priceId: price, quantity: 2 }))).rejects.toThrow();
    });
  });

  // ------------------------------------------------------------------------------------------------------------ idempotency
  describe('idempotent creation by the natural key (producer, invoiceRequestId)', () => {
    it('an identical replay returns the original, writes nothing, and is insensitive to key order', async () => {
      const input = await draftInput();
      const first = await create(input);
      const second = await create({ ...input, lines: input.lines.map((l) => ({ ...l })) });
      expect(second.changed).toBe(false);
      expect(second.invoice.id).toBe(first.invoice.id);
      expect((await rows(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityId" = $1`, [first.invoice.id]))[0].n).toBe(1);
    });

    it('a changed replay is 409 invoice_request_conflict and changes nothing', async () => {
      const input = await draftInput({ quantity: 2 });
      const first = await create(input);
      await rejects(create({ ...input, lines: [{ ...input.lines[0]!, quantity: 5 }] }), 409, 'invoice_request_conflict');
      await rejects(create({ ...input, payer: { type: 'user', id: 'user-9' } }), 409, 'invoice_request_conflict');
      expect((await invoices.findForCaller(first.invoice.id, producer)).total).toBe('3000');
    });

    it('the key is per producer: another producer may reuse the same invoiceRequestId', async () => {
      const input = await draftInput();
      const mine = await create(input);
      const theirs = await invoices.createDraft('other-producer', input, ['TND'], ctx);
      expect(theirs.changed).toBe(true);
      expect(theirs.invoice.id).not.toBe(mine.invoice.id);
    });

    it('8 concurrent identical requests create ONE invoice; every caller gets it and exactly one wrote', async () => {
      const input = await draftInput();
      const results = await Promise.all(Array.from({ length: 8 }, () => create(input)));
      expect(new Set(results.map((r) => r.invoice.id)).size).toBe(1);
      expect(results.filter((r) => r.changed)).toHaveLength(1);
      expect((await rows(`SELECT count(*)::int AS n FROM invoice WHERE "invoiceRequestId" = $1`, [input.invoiceRequestId]))[0].n).toBe(1);
      expect((await rows(`SELECT count(*)::int AS n FROM invoice_line WHERE "invoiceId" = $1`, [results[0]!.invoice.id]))[0].n).toBe(1);
    });

    it('concurrent requests with the SAME id but DIFFERENT content: exactly one wins, the rest are conflicts', async () => {
      const base = await draftInput({ quantity: 1 });
      const settled = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => create({ ...base, lines: [{ ...base.lines[0]!, quantity: i + 1 }] })));
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      for (const s of settled.filter((x) => x.status === 'rejected')) expect((s as PromiseRejectedResult).reason).toMatchObject({ status: 409, response: { code: 'invoice_request_conflict' } });
    });
  });

  // ---------------------------------------------------------------------------------------------------------- lifecycle
  describe('issue, discard and the lifecycle', () => {
    it('issue assigns the number, sets the presentation snapshot, moves to open, records history and enqueues invoice.created — together', async () => {
      const { invoice: draft } = await create(await draftInput({ quantity: 2 }));
      const { invoice, changed } = await invoices.issue(draft.id, producer, { template: 'system:1', locale: 'fr-TN' }, ctx);
      expect(changed).toBe(true);
      expect(invoice).toMatchObject({ status: 'open', revision: 1, number: expect.stringMatching(/^[1-9][0-9]*$/), presentation: { schemaVersion: 1, template: 'system:1', locale: 'fr-TN' } });
      expect(invoice.issuedAt).toBeInstanceOf(Date);
      expect((await history(draft.id)).map((h) => `${h.fromStatus}>${h.toStatus}@${h.revision}`)).toEqual(['null>draft@0', 'draft>open@1']);

      const ev = await events(draft.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].name).toBe('invoice.created');
      expect(ev[0].payload).toMatchObject({
        aggregateType: 'invoice', invoiceId: draft.id, invoiceNumber: invoice.number, total: 3000, subtotal: 3000, taxTotal: 0, currency: 'TND', status: 'open', revision: 1,
        organizationId: ORG, payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: ORG }, actor: { type: 'service', id: PRODUCER },
      });
      expect(ev[0].payload.lines).toHaveLength(1);
      // opaque ids and plain facts only: no party snapshot, no description text (B-032)
      expect(JSON.stringify(ev[0].payload)).not.toMatch(/issuerSnapshot|billToSnapshot|description/);
    });

    it('issue is state-idempotent: a repeat replays, writes nothing and enqueues no second event', async () => {
      const draft = (await create(await draftInput())).invoice;
      const first = await invoices.issue(draft.id, producer, { template: 'system:1', locale: 'fr' }, ctx);
      const again = await invoices.issue(draft.id, producer, { template: 'system:1', locale: 'ar' }, ctx);
      expect(again.changed).toBe(false);
      expect(again.invoice.number).toBe(first.invoice.number);
      expect(again.invoice.presentation).toEqual(first.invoice.presentation); // a repeat can never rewrite the snapshot (BI-20)
      expect(await events(draft.id)).toHaveLength(1);
    });

    it('8 concurrent issues of one draft: ONE transition, one number, one event', async () => {
      const draft = (await create(await draftInput())).invoice;
      const results = await Promise.all(Array.from({ length: 8 }, () => invoices.issue(draft.id, producer, { template: 'system:1', locale: 'fr' }, ctx)));
      expect(results.filter((r) => r.changed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.invoice.number)).size).toBe(1);
      expect(await events(draft.id)).toHaveLength(1);
      expect((await history(draft.id)).map((h) => h.toStatus)).toEqual(['draft', 'open']);
    });

    it('numbers are unique and never repeat under concurrent issues for one seller; each seller counts independently', async () => {
      const seller = crypto.randomUUID();
      const make = async () => {
        const price = await seedPrice({ seller });
        const input = normaliseCreateInvoiceInput({
          invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: seller }, payer: { type: 'user', id: 'user-1' }, sourceType: 'contract', sourceId: 's',
          issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: price, quantity: 1 }],
        });
        return (await create(input)).invoice.id;
      };
      const ids = await Promise.all(Array.from({ length: 10 }, make));
      const issued = await Promise.all(ids.map((id) => invoices.issue(id, producer, { template: 'system:1', locale: 'fr' }, ctx)));
      const numbers = issued.map((r) => Number(r.invoice.number)).sort((a, b) => a - b);
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // no duplicate under load; gapless here only because nothing rolled back (gaplessness is NOT assumed)
      const first = await openInvoice(); // a different seller (ORG): its own counter
      expect(Number(first.number)).toBeGreaterThanOrEqual(1);
    });

    it('a failed issue returns its number and leaves the invoice a draft: atomicity with the outbox (BI-19, transactional outbox)', async () => {
      const seller = crypto.randomUUID();
      const price = await seedPrice({ seller });
      const mk = async () =>
        (await create(normaliseCreateInvoiceInput({
          invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: seller }, payer: { type: 'user', id: 'user-1' }, sourceType: 'contract', sourceId: 's',
          issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: price, quantity: 1 }],
        }))).invoice.id;
      const a = await mk();
      const b = await mk();
      const spy = vi.spyOn(t.app.get(OutboxService), 'enqueue').mockRejectedValueOnce(new Error('broker-side failure injected'));
      await expect(invoices.issue(a, producer, { template: 'system:1', locale: 'fr' }, ctx)).rejects.toThrow('injected');
      const after = await invoices.findForCaller(a, producer);
      expect(after).toMatchObject({ status: 'draft', number: null, revision: 0, presentation: null });
      expect((await history(a)).map((h) => h.toStatus)).toEqual(['draft']); // no history row for a change that rolled back
      expect(await events(a)).toHaveLength(0);
      spy.mockRestore();
      expect((await invoices.issue(b, producer, { template: 'system:1', locale: 'fr' }, ctx)).invoice.number).toBe('1'); // the rolled-back number was returned
    });

    it('discard moves a draft to void with no number, no event and a history row; a repeat is a no-op; an issued invoice cannot be discarded', async () => {
      const draft = (await create(await draftInput())).invoice;
      const r = await invoices.discard(draft.id, producer, ctx);
      expect(r.invoice).toMatchObject({ status: 'void', number: null, voidReasonCode: 'discarded', revision: 1 });
      expect(r.invoice.voidedAt).toBeInstanceOf(Date);
      expect((await invoices.discard(draft.id, producer, ctx)).changed).toBe(false);
      expect((await history(draft.id)).map((h) => h.toStatus)).toEqual(['draft', 'void']);
      expect(await events(draft.id)).toHaveLength(0);
      await rejects(invoices.issue(draft.id, producer, { template: 'system:1', locale: 'fr' }, ctx), 409, 'invalid_state_transition');
      const open = await openInvoice();
      await rejects(invoices.discard(open.id, producer, ctx), 409, 'invalid_state_transition'); // open -> void is not decided (B-015)
    });

    it('a rejected presentation snapshot (outside the closed vocabulary) is refused before anything changes', async () => {
      const draft = (await create(await draftInput())).invoice;
      await rejects(invoices.issue(draft.id, producer, { template: '<script>', locale: 'fr' }, ctx), 400, 'invalid_invoice_request');
      expect((await invoices.findForCaller(draft.id, producer)).status).toBe('draft');
    });
  });

  // ------------------------------------------------------------------------------------- ownership and organization isolation
  describe('ownership: relation is derived from the invoice itself (SDD 19)', () => {
    it('only the producer that created an invoice may issue or discard it; anyone else sees it as not found', async () => {
      const draft = (await create(await draftInput())).invoice;
      await rejects(invoices.issue(draft.id, { kind: 'service', service: 'other-producer' }, { template: 'system:1', locale: 'fr' }, ctx), 404, 'not_found');
      await rejects(invoices.discard(draft.id, payer('user-2'), ctx), 404, 'not_found');
      await rejects(invoices.issue(draft.id, payer('user-1'), { template: 'system:1', locale: 'fr' }, ctx), 403, 'operation_not_permitted'); // the payer reads and pays, never issues
      expect((await invoices.findForCaller(draft.id, producer)).status).toBe('draft');
    });

    it('the payer reads their own invoice; another user, another service and a caller with an organization id only get 404 (no existence leak)', async () => {
      const open = await openInvoice({ payerId: 'user-1' });
      expect((await invoices.findForCaller(open.id, payer('user-1'))).id).toBe(open.id);
      await rejects(invoices.findForCaller(open.id, payer('user-2')), 404, 'not_found');
      await rejects(invoices.findForCaller(open.id, { kind: 'service', service: 'other-producer' }), 404, 'not_found');
      await rejects(invoices.findForCaller(crypto.randomUUID(), producer), 404, 'not_found'); // unknown looks identical to forbidden
    });

    it('an organization is the SELLER, not a capability: being the seller organization gives no read of the invoice (B-026/B-027)', async () => {
      const open = await openInvoice();
      await rejects(invoices.findForCaller(open.id, { kind: 'user', userId: ORG }), 404, 'not_found');
    });
  });

  // ------------------------------------------------------------------------------------------------- payment-request mapping
  describe('payment request (BI-08, BI-09, BI-13)', () => {
    it('is created for an open invoice with exactly its total and currency, with a history row, and is state-idempotent', async () => {
      const open = await openInvoice({ quantity: 4 });
      const first = await requests.createForInvoice(open.id, payer('user-1'), ctx);
      expect(first.created).toBe(true);
      expect(first.request).toMatchObject({ invoiceId: open.id, amount: open.total, currency: 'TND', status: 'created', paymentId: null, mappingVersion: 1, expiresAt: null, createdByType: 'user', createdById: 'user-1' });
      expect((await history(first.request.id)).map((h) => h.toStatus)).toEqual(['created']);
      const again = await requests.createForInvoice(open.id, producer, ctx);
      expect(again).toMatchObject({ created: false });
      expect(again.request.id).toBe(first.request.id);
    });

    it('8 concurrent creations give ONE active request and every caller receives it', async () => {
      const open = await openInvoice();
      const results = await Promise.all(Array.from({ length: 8 }, () => requests.createForInvoice(open.id, producer, ctx)));
      expect(new Set(results.map((r) => r.request.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect((await rows(`SELECT count(*)::int AS n FROM payment_request WHERE "invoiceId" = $1`, [open.id]))[0].n).toBe(1);
    });

    it('a draft or void invoice is 409 invoice_not_payable; a non-user payer is 409 payment_request_not_supported; strangers get 404', async () => {
      const draft = (await create(await draftInput())).invoice;
      await rejects(requests.createForInvoice(draft.id, producer, ctx), 409, 'invoice_not_payable');
      const orgPayer = await openInvoice({ payerType: 'organization', payerId: crypto.randomUUID() });
      await rejects(requests.createForInvoice(orgPayer.id, producer, ctx), 409, 'payment_request_not_supported');
      const open = await openInvoice();
      await rejects(requests.createForInvoice(open.id, payer('user-2'), ctx), 404, 'not_found');
      await rejects(requests.findForCaller((await requests.createForInvoice(open.id, producer, ctx)).request.id, payer('user-2')), 404, 'not_found');
    });

    it('a NEW request is possible only after the previous one ended (failed), and still exactly one is active', async () => {
      const open = await openInvoice();
      const first = (await requests.createForInvoice(open.id, producer, ctx)).request;
      const paymentId = await dispatch(first.id);
      await requests.applyPaymentEvent(crypto.randomUUID(), eventFor(open, first, paymentId, 'payment.failed'), paymentCtx);
      const second = await requests.createForInvoice(open.id, producer, ctx);
      expect(second.created).toBe(true);
      expect(second.request.id).not.toBe(first.id);
    });
  });

  // -------------------------------------------------------------------------------------------------- payment event handling
  describe('payment events (SDD 21.4): duplicates, unknown, early, out of order, conflicting', () => {
    async function requested() {
      const open = await openInvoice();
      const request = (await requests.createForInvoice(open.id, producer, ctx)).request;
      const paymentId = await dispatch(request.id);
      return { open, request, paymentId };
    }
    const receipts = (requestId: string) => rows(`SELECT outcome, "detailCode", "paymentId" FROM payment_event_receipt WHERE "paymentRequestId" = $1 ORDER BY "receivedAt"`, [requestId]);

    it('payment.succeeded settles the request and the invoice in ONE transaction, with history and a receipt', async () => {
      const { open, request, paymentId } = await requested();
      const r = await requests.applyPaymentEvent(crypto.randomUUID(), eventFor(open, request, paymentId), paymentCtx);
      expect(r).toMatchObject({ outcome: 'applied', firstDelivery: true });
      expect((await invoices.findForCaller(open.id, producer))).toMatchObject({ status: 'paid', revision: 2 });
      expect((await invoices.findForCaller(open.id, producer)).paidAt).toBeInstanceOf(Date);
      expect((await requests.findForCaller(request.id, producer)).status).toBe('paid');
      expect((await history(open.id)).map((h) => h.toStatus)).toEqual(['draft', 'open', 'paid']);
      expect((await history(request.id)).map((h) => h.toStatus)).toEqual(['created', 'sending', 'requested', 'paid']);
      expect(await receipts(request.id)).toEqual([{ outcome: 'applied', detailCode: null, paymentId }]);
    });

    it('a redelivery of the SAME event id changes nothing and reports the first outcome', async () => {
      const { open, request, paymentId } = await requested();
      const id = crypto.randomUUID();
      await requests.applyPaymentEvent(id, eventFor(open, request, paymentId), paymentCtx);
      const again = await requests.applyPaymentEvent(id, eventFor(open, request, paymentId), paymentCtx);
      expect(again).toMatchObject({ outcome: 'applied', firstDelivery: false });
      expect(await receipts(request.id)).toHaveLength(1);
      expect((await history(open.id)).filter((h) => h.toStatus === 'paid')).toHaveLength(1);
    });

    it('a DIFFERENT event id for the same terminal outcome is ignored as already applied', async () => {
      const { open, request, paymentId } = await requested();
      await requests.applyPaymentEvent(crypto.randomUUID(), eventFor(open, request, paymentId), paymentCtx);
      const second = await requests.applyPaymentEvent(crypto.randomUUID(), eventFor(open, request, paymentId), paymentCtx);
      expect(second).toMatchObject({ outcome: 'ignored', detail: 'already_applied', firstDelivery: true });
      expect((await invoices.findForCaller(open.id, producer)).revision).toBe(2);
    });

    it('an event for a request Billing never had is ignored and recorded, and creates nothing', async () => {
      const open = await openInvoice();
      const ghost = { id: crypto.randomUUID() };
      const r = await requests.applyPaymentEvent(crypto.randomUUID(), eventFor(open, ghost, crypto.randomUUID()), paymentCtx);
      expect(r).toMatchObject({ outcome: 'ignored', detail: 'unknown_payment_request' });
      expect((await rows(`SELECT count(*)::int AS n FROM payment_request WHERE id = $1`, [ghost.id]))[0].n).toBe(0);
      expect(await receipts(ghost.id)).toHaveLength(1);
      expect((await invoices.findForCaller(open.id, producer)).status).toBe('open');
    });

    it('an EARLY event (request has no paymentId yet) is deferred: nothing is applied and the paymentId is NEVER bound from the event', async () => {
      const open = await openInvoice();
      const request = (await requests.createForInvoice(open.id, producer, ctx)).request;
      const smuggled = crypto.randomUUID();
      const r = await requests.applyPaymentEvent(crypto.randomUUID(), eventFor(open, request, smuggled), paymentCtx);
      expect(r).toMatchObject({ outcome: 'deferred', detail: 'payment_id_not_recorded' });
      const after = await requests.findForCaller(request.id, producer);
      expect(after).toMatchObject({ status: 'created', paymentId: null });
      expect((await invoices.findForCaller(open.id, producer)).status).toBe('open');
      expect(await receipts(request.id)).toEqual([{ outcome: 'deferred', detailCode: 'payment_id_not_recorded', paymentId: null }]);
    });

    it.each([
      ['a different paymentId', (p: PaymentEventFacts) => ({ ...p, paymentId: crypto.randomUUID() }), 'payment_id_mismatch'],
      ['a different amount', (p: PaymentEventFacts) => ({ ...p, amount: Number(p.amount) + 1 }), 'amount_mismatch'],
      ['a different currency', (p: PaymentEventFacts) => ({ ...p, currency: 'EUR' }), 'amount_mismatch'],
      ['a float amount', (p: PaymentEventFacts) => ({ ...p, amount: 4500.5 }), 'invalid_amount'],
      ['a different payer', (p: PaymentEventFacts) => ({ ...p, payer: { type: 'user', id: 'user-x' } }), 'snapshot_mismatch'],
      ['a different source', (p: PaymentEventFacts) => ({ ...p, sourceId: crypto.randomUUID() }), 'snapshot_mismatch'],
      ['a message from another source', (p: PaymentEventFacts) => ({ ...p, source: 'evil-service' }), 'wrong_source'],
    ])('an event with %s is a recorded conflict and changes no state', async (_n, mutate, detail) => {
      const { open, request, paymentId } = await requested();
      const r = await requests.applyPaymentEvent(crypto.randomUUID(), mutate(eventFor(open, request, paymentId)), paymentCtx);
      expect(r).toMatchObject({ outcome: 'conflict', detail });
      expect((await requests.findForCaller(request.id, producer)).status).toBe('requested');
      expect((await invoices.findForCaller(open.id, producer)).status).toBe('open');
    });

    it('payment.failed closes the request but leaves the invoice open; a LATE success afterwards is a conflict, never a transition', async () => {
      const { open, request, paymentId } = await requested();
      await requests.applyPaymentEvent(crypto.randomUUID(), eventFor(open, request, paymentId, 'payment.failed'), paymentCtx);
      expect((await requests.findForCaller(request.id, producer)).status).toBe('failed');
      expect((await invoices.findForCaller(open.id, producer)).status).toBe('open');
      const late = await requests.applyPaymentEvent(crypto.randomUUID(), eventFor(open, request, paymentId, 'payment.succeeded'), paymentCtx);
      expect(late).toMatchObject({ outcome: 'conflict', detail: 'request_already_terminal' });
      expect((await invoices.findForCaller(open.id, producer)).status).toBe('open');
    });

    it('success for an invoice that is no longer open is a conflict (the request stays requested), never a double settle', async () => {
      const { open, request, paymentId } = await requested();
      // the state is forced with the triggers OFF only to construct the situation; the assertion is about the decision
      const c = await admin.connect();
      try {
        await c.query(`SET session_replication_role = replica`);
        await c.query(`UPDATE invoice SET status = 'void', "voidedAt" = now() WHERE id = $1`, [open.id]);
        await c.query(`RESET session_replication_role`);
      } finally {
        c.release();
      }
      const r = await requests.applyPaymentEvent(crypto.randomUUID(), eventFor(open, request, paymentId), paymentCtx);
      expect(r).toMatchObject({ outcome: 'conflict', detail: 'invoice_not_open' });
      expect((await requests.findForCaller(request.id, producer)).status).toBe('requested');
    });

    it('6 concurrent deliveries of ONE event apply it exactly once', async () => {
      const { open, request, paymentId } = await requested();
      const id = crypto.randomUUID();
      const results = await Promise.all(Array.from({ length: 6 }, () => requests.applyPaymentEvent(id, eventFor(open, request, paymentId), paymentCtx)));
      expect(results.filter((r) => r.firstDelivery)).toHaveLength(1);
      expect(new Set(results.map((r) => r.outcome))).toEqual(new Set(['applied']));
      expect(await receipts(request.id)).toHaveLength(1);
      expect((await history(open.id)).filter((h) => h.toStatus === 'paid')).toHaveLength(1);
    });

    it('a success and a failure racing for one request settle it once: one applied, the other a conflict, and the invoice is paid at most once', async () => {
      const { open, request, paymentId } = await requested();
      const [a, b] = await Promise.all([
        requests.applyPaymentEvent(crypto.randomUUID(), eventFor(open, request, paymentId, 'payment.succeeded'), paymentCtx),
        requests.applyPaymentEvent(crypto.randomUUID(), eventFor(open, request, paymentId, 'payment.failed'), paymentCtx),
      ]);
      expect([a.outcome, b.outcome].sort()).toEqual(['applied', 'conflict']);
      const finalRequest = await requests.findForCaller(request.id, producer);
      const finalInvoice = await invoices.findForCaller(open.id, producer);
      expect(finalRequest.status === 'paid').toBe(finalInvoice.status === 'paid'); // the two never disagree (BI-14)
    });

    it('two racing events for two requests of different invoices do not block or corrupt each other', async () => {
      const [x, y] = await Promise.all([requested(), requested()]);
      const out = await Promise.all([x, y].map((s) => requests.applyPaymentEvent(crypto.randomUUID(), eventFor(s.open, s.request, s.paymentId), paymentCtx)));
      expect(out.map((o) => o.outcome)).toEqual(['applied', 'applied']);
    });
  });
});
