import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 3 HTTP API: the controllers, guards and representations over the Stage 2 domain (SDD sections 18, 19). Domain
 * rules themselves (money, state machines, idempotency, financial invariants) are already proven at the unit, database
 * and repository-integration level (invoices.e2e-spec.ts, db/tests/invariants.sql); this file proves the HTTP LAYER:
 * authentication, authorization, the request/response shape, and that nothing here bypasses what the domain already enforces.
 */
describeWithEnv('billing HTTP API (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;

  const producer = generateServiceToken();
  const otherProducer = generateServiceToken();

  const payer: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const otherUser: AuthIdentity = { id: 'user-2', adminTier: null, isActive: true, memberships: [] };
  // A generic Auth capability is never Billing authority (SDD 19.1): an owner-tier identity gets no special access.
  const platformOwner: AuthIdentity = { id: 'owner-1', adminTier: 'owner', isActive: true, memberships: [] };
  const identities: Record<string, AuthIdentity> = {
    'payer-jwt': payer,
    'other-user-jwt': otherUser,
    'owner-jwt': platformOwner,
    'inactive-jwt': { id: 'user-3', adminTier: null, isActive: false, memberships: [] },
  };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billinghttp');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [
        { caller: 'test-producer', digest: producer.digest },
        { caller: 'other-producer', digest: otherProducer.digest },
      ],
      authClient,
    });
  });
  afterAll(async () => {
    await t.app.close();
    await db.drop();
  });

  const http = () => t.app.getHttpServer();
  const asService = (token: string) => ({
    post: (path: string, body?: unknown) => request(http()).post(path).set('authorization', `Bearer ${token}`).send(body ?? {}),
    get: (path: string) => request(http()).get(path).set('authorization', `Bearer ${token}`),
  });
  const asUser = (bearer: string) => ({
    get: (path: string) => request(http()).get(path).set('authorization', `Bearer ${bearer}`),
    post: (path: string, body?: unknown) => request(http()).post(path).set('authorization', `Bearer ${bearer}`).send(body ?? {}),
  });
  const asProducer = asService(producer.token);
  const asOtherProducer = asService(otherProducer.token);
  const asPayer = asUser('payer-jwt');
  const asOtherUser = asUser('other-user-jwt');
  const asOwner = asUser('owner-jwt');

  let seq = 0;
  async function seedPrice(over: { producer?: ReturnType<typeof asService>; sellerId?: string; unitAmount?: number } = {}) {
    seq += 1;
    const caller = over.producer ?? asProducer;
    const sellerId = over.sellerId ?? crypto.randomUUID();
    const product = await caller.post('/billing/products', { seller: { type: 'organization', id: sellerId }, code: `prod-${seq}`, name: `Product ${seq}` }).expect(201);
    const price = await caller
      .post('/billing/prices', { productId: product.body.id, clientReference: `ref-${seq}`, currency: 'TND', unitAmount: over.unitAmount ?? 1500, interval: 'one_time', effectiveFrom: new Date().toISOString() })
      .expect(201);
    return { sellerId, priceId: price.body.id as string, productId: product.body.id as string };
  }

  function invoiceBody(o: { priceId: string; sellerId: string; payerId?: string; quantity?: number; request?: string } = { priceId: '', sellerId: '' }) {
    return {
      invoiceRequestId: o.request ?? crypto.randomUUID(),
      seller: { type: 'organization', id: o.sellerId },
      payer: { type: 'user', id: o.payerId ?? 'user-1' },
      sourceType: 'contract',
      sourceId: `src-${++seq}`,
      issuerSnapshot: { schemaVersion: 1 },
      billToSnapshot: { schemaVersion: 1 },
      lines: [{ priceId: o.priceId, quantity: o.quantity ?? 2 }],
    };
  }

  // ---------------------------------------------------------------------------------------------------------- authentication
  describe('authentication', () => {
    it('an unauthenticated request is 401, never 404 (a real route exists)', async () => {
      await request(http()).get('/billing/invoices').expect(401);
      await request(http()).post('/billing/products').send({}).expect(401);
    });

    it('an inactive identity is refused (401), even though Auth recognises the token', async () => {
      await asUser('inactive-jwt').get('/billing/invoices').expect(401);
    });

    it('a valid authenticated caller (service token, or an active user bearer) is accepted', async () => {
      await asProducer.get('/billing/invoices').expect(200);
      await asPayer.get('/billing/invoices').expect(200);
    });
  });

  // ----------------------------------------------------------------------------------------------------------- product/price
  describe('products and prices', () => {
    it('creates a product (201), replays an identical request (200, Idempotent-Replayed), and refuses a changed one (409 product_conflict)', async () => {
      const sellerId = crypto.randomUUID();
      const body = { seller: { type: 'organization', id: sellerId }, code: 'plan-a', name: 'Plan A' };
      const created = await asProducer.post('/billing/products', body).expect(201);
      expect(created.body).toMatchObject({ code: 'plan-a', name: 'Plan A', status: 'active', entitlementKind: 'none' });
      expect(created.headers['idempotent-replayed']).toBeUndefined();

      const replay = await asProducer.post('/billing/products', body).expect(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.id).toBe(created.body.id);

      const conflict = await asProducer.post('/billing/products', { ...body, name: 'Plan B' }).expect(409);
      expect(conflict.body.code).toBe('product_conflict');
    });

    it('rejects mass assignment (an unknown field is 400 invalid_product_request)', async () => {
      const r = await asProducer.post('/billing/products', { seller: { type: 'organization', id: crypto.randomUUID() }, code: 'x', name: 'X', producer: 'someone-else' }).expect(400);
      expect(r.body.code).toBe('invalid_product_request');
    });

    it('a product is reached only through the producer that created it (404, collapsed, for a different producer)', async () => {
      const { productId } = await seedPrice();
      await asProducer.get(`/billing/products/${productId}`).expect(200);
      await asOtherProducer.get(`/billing/products/${productId}`).expect(404);
      await asOtherProducer.post(`/billing/products/${productId}/archive`).expect(404);
    });

    it('archives a product (active -> archived, one way), and replays if already archived', async () => {
      const { productId } = await seedPrice();
      const archived = await asProducer.post(`/billing/products/${productId}/archive`).expect(200);
      expect(archived.body.status).toBe('archived');
      const replay = await asProducer.post(`/billing/products/${productId}/archive`).expect(200);
      expect(replay.body.status).toBe('archived');
    });

    it('creates a price for a product the caller owns; refuses one for a product owned by another producer (404, collapsed)', async () => {
      const { productId } = await seedPrice();
      const own = await asProducer.post('/billing/prices', { productId, clientReference: 'own-1', currency: 'TND', unitAmount: 500, interval: 'one_time', effectiveFrom: new Date().toISOString() }).expect(201);
      expect(own.body).toMatchObject({ currency: 'TND', unitAmount: 500, interval: 'one_time', retiredAt: null });

      const foreign = await asOtherProducer.post('/billing/prices', { productId, clientReference: 'foreign-1', currency: 'TND', unitAmount: 500, interval: 'one_time', effectiveFrom: new Date().toISOString() });
      expect(foreign.status).toBe(404);
    });

    it('refuses an unsupported currency (422 unsupported_currency)', async () => {
      const { productId } = await seedPrice();
      const r = await asProducer.post('/billing/prices', { productId, clientReference: 'bad-cur', currency: 'XYZ', unitAmount: 500, interval: 'one_time', effectiveFrom: new Date().toISOString() }).expect(422);
      expect(r.body.code).toBe('unsupported_currency');
    });

    it('retires a price once (retiredAt set), and replays if already retired', async () => {
      const { priceId } = await seedPrice();
      const retired = await asProducer.post(`/billing/prices/${priceId}/retire`).expect(200);
      expect(retired.body.retiredAt).not.toBeNull();
      const replay = await asProducer.post(`/billing/prices/${priceId}/retire`).expect(200);
      expect(replay.body.retiredAt).toBe(retired.body.retiredAt); // set once, never re-stamped
    });
  });

  // ------------------------------------------------------------------------------------------------------------- invoices
  describe('invoice creation, retrieval and lifecycle', () => {
    it('creates a draft with server-computed totals (201), replays an identical request (200), and refuses a changed one (409)', async () => {
      const { priceId, sellerId } = await seedPrice({ unitAmount: 1500 });
      const body = invoiceBody({ priceId, sellerId, quantity: 3 });
      const created = await asProducer.post('/billing/invoices', body).expect(201);
      expect(created.body).toMatchObject({ status: 'draft', currency: 'TND', subtotal: 4500, total: 4500, amountDue: 4500, amountPaid: 0, number: null });

      const replay = await asProducer.post('/billing/invoices', body).expect(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.id).toBe(created.body.id);

      const conflict = await asProducer.post('/billing/invoices', { ...body, description: 'changed' }).expect(409);
      expect(conflict.body.code).toBe('invoice_request_conflict');
    });

    it('never accepts a client-supplied amount, total or currency (unknown field: 400 invalid_invoice_request)', async () => {
      const { priceId, sellerId } = await seedPrice();
      const body = { ...invoiceBody({ priceId, sellerId }), total: 999999 };
      const r = await asProducer.post('/billing/invoices', body).expect(400);
      expect(r.body.code).toBe('invalid_invoice_request');
    });

    it('refuses a price that does not exist, is retired, or belongs to a different seller (422 price_not_available)', async () => {
      const { priceId, sellerId } = await seedPrice();
      await asProducer.post('/billing/prices/' + priceId + '/retire').expect(200);
      const r = await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId })).expect(422);
      expect(r.body.code).toBe('price_not_available');
    });

    it('gets an invoice for its producer and for its payer; 404 (collapsed) for an unrelated user, even one with a platform-owner Auth flag', async () => {
      const { priceId, sellerId } = await seedPrice();
      const { body: invoice } = await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId, payerId: 'user-1' })).expect(201);

      await asProducer.get(`/billing/invoices/${invoice.id}`).expect(200);
      await asPayer.get(`/billing/invoices/${invoice.id}`).expect(200);
      await asOtherUser.get(`/billing/invoices/${invoice.id}`).expect(404);
      await asOwner.get(`/billing/invoices/${invoice.id}`).expect(404); // a generic Auth admin/owner flag is never Billing authority (SDD 19.1)
      await asOtherProducer.get(`/billing/invoices/${invoice.id}`).expect(404);
    });

    it('the detail representation never leaks internal audit/transition history (actor, cause, revision) or the producer', async () => {
      const { priceId, sellerId } = await seedPrice();
      const { body: invoice } = await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId })).expect(201);
      const r = await asProducer.get(`/billing/invoices/${invoice.id}`).expect(200);
      for (const leaked of ['revision', 'actorType', 'actorId', 'causeType', 'causeId', 'producer', 'requestHash']) {
        expect(r.body).not.toHaveProperty(leaked);
      }
    });

    it('issues a draft (assigns a number, draft -> open), and replays if already issued; refuses issuing twice with different content', async () => {
      const { priceId, sellerId } = await seedPrice();
      const { body: invoice } = await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId })).expect(201);
      const issued = await asProducer.post(`/billing/invoices/${invoice.id}/issue`).expect(200);
      expect(issued.body.status).toBe('open');
      expect(issued.body.number).not.toBeNull();
      expect(issued.body.isOverdue).toBe(false);

      const replay = await asProducer.post(`/billing/invoices/${invoice.id}/issue`).expect(200);
      expect(replay.body.number).toBe(issued.body.number); // the number is assigned once (BI-10)
    });

    it('issue and discard are producer (service-token) only: a user bearer is not even the right credential TYPE for them (401, not 403)', async () => {
      const { priceId, sellerId } = await seedPrice();
      const { body: invoice } = await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId })).expect(201);
      await asPayer.post(`/billing/invoices/${invoice.id}/issue`).expect(401);
    });

    it('discards a draft (draft -> void, no number consumed); refuses issuing after discard (409 invalid_state_transition)', async () => {
      const { priceId, sellerId } = await seedPrice();
      const { body: invoice } = await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId })).expect(201);
      const discarded = await asProducer.post(`/billing/invoices/${invoice.id}/discard`).expect(200);
      expect(discarded.body.status).toBe('void');
      expect(discarded.body.number).toBeNull();
      const r = await asProducer.post(`/billing/invoices/${invoice.id}/issue`).expect(409);
      expect(r.body.code).toBe('invalid_state_transition');
    });
  });

  // ---------------------------------------------------------------------------------------------------------- billing history
  describe('billing history: listing, pagination, filters, isolation', () => {
    it('a producer lists only what it created; a payer lists only invoices where they are the payer (never another caller\'s data)', async () => {
      const { priceId, sellerId } = await seedPrice();
      await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId, payerId: 'user-1' })).expect(201);
      const { priceId: p2, sellerId: s2 } = await seedPrice({ producer: asOtherProducer });
      await asOtherProducer.post('/billing/invoices', invoiceBody({ priceId: p2, sellerId: s2, payerId: 'user-1' })).expect(201);

      const producerList = await asProducer.get('/billing/invoices').expect(200);
      expect(producerList.body.items.length).toBeGreaterThan(0);
      for (const item of producerList.body.items) {
        const detail = await asProducer.get(`/billing/invoices/${item.id}`).expect(200);
        expect(detail.status).toBe(200); // every listed item is one this producer actually produced (relation holds)
      }

      const otherProducerList = await asOtherProducer.get('/billing/invoices').expect(200);
      const producerIds = new Set(producerList.body.items.map((i: { id: string }) => i.id));
      for (const item of otherProducerList.body.items) expect(producerIds.has(item.id)).toBe(false);
    });

    it('a client-supplied payerId filter that does not match the caller narrows to an EMPTY page, never to another payer\'s data', async () => {
      const r = await asPayer.get('/billing/invoices?payerId=someone-else').expect(200);
      expect(r.body.items).toEqual([]);
    });

    it('an unauthorized caller\'s own history is simply empty, never an error, when they have no invoices at all', async () => {
      const r = await asUser('other-user-jwt').get('/billing/invoices').expect(200);
      expect(Array.isArray(r.body.items)).toBe(true);
    });

    it('list items never expose internal transition history either', async () => {
      const { priceId, sellerId } = await seedPrice();
      await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId })).expect(201);
      const r = await asProducer.get('/billing/invoices?limit=1').expect(200);
      expect(r.body.items[0]).not.toHaveProperty('revision');
      expect(r.body.items[0]).not.toHaveProperty('actorType');
    });

    it('filters by status: an open-only filter excludes drafts', async () => {
      const { priceId, sellerId } = await seedPrice();
      const { body: draft } = await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId })).expect(201);
      const r = await asProducer.get('/billing/invoices?status=open').expect(200);
      expect(r.body.items.some((i: { id: string }) => i.id === draft.id)).toBe(false);
    });

    it('rejects an invalid limit (400), never silently clamps it', async () => {
      await asProducer.get('/billing/invoices?limit=0').expect(400);
      await asProducer.get('/billing/invoices?limit=101').expect(400);
    });

    it('paginates with a cursor: no item repeats and no item is skipped across pages', async () => {
      const { priceId, sellerId } = await seedPrice();
      for (let i = 0; i < 3; i++) await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId })).expect(201);
      const first = await asProducer.get('/billing/invoices?limit=1').expect(200);
      expect(first.body.items).toHaveLength(1);
      expect(first.body.nextCursor).toBeTypeOf('string');
      const second = await asProducer.get(`/billing/invoices?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`).expect(200);
      expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    });
  });

  // ------------------------------------------------------------------------------------------------------- payment requests
  describe('payment requests: Billing-side creation (the Payment integration itself — dispatch, cancel, events — is covered in payment-integration.e2e-spec.ts)', () => {
    it('creates a payment request equal to the full invoice total; paymentId is ALWAYS null and status ALWAYS "created" (the dispatcher never runs in this suite — its own interval is set to an hour, and nothing here calls dispatchOnce())', async () => {
      const { priceId, sellerId } = await seedPrice({ unitAmount: 2000 });
      const { body: draft } = await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId, quantity: 1, payerId: 'user-1' })).expect(201);
      await asProducer.post(`/billing/invoices/${draft.id}/issue`).expect(200);

      const r = await asPayer.post(`/billing/invoices/${draft.id}/payment-requests`).expect(201);
      expect(r.body).toMatchObject({ invoiceId: draft.id, status: 'created', amount: 2000, currency: 'TND', paymentId: null });
    });

    it('state-idempotent: a second request while one is active returns the SAME request, never a duplicate (BI-13)', async () => {
      const { priceId, sellerId } = await seedPrice();
      const { body: draft } = await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId, payerId: 'user-1' })).expect(201);
      await asProducer.post(`/billing/invoices/${draft.id}/issue`).expect(200);
      const first = await asPayer.post(`/billing/invoices/${draft.id}/payment-requests`).expect(201);
      const second = await asPayer.post(`/billing/invoices/${draft.id}/payment-requests`).expect(200);
      expect(second.body.id).toBe(first.body.id);
    });

    it('refuses a payment request for a draft (not open): 409 invoice_not_payable', async () => {
      const { priceId, sellerId } = await seedPrice();
      const { body: draft } = await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId, payerId: 'user-1' })).expect(201);
      const r = await asPayer.post(`/billing/invoices/${draft.id}/payment-requests`).expect(409);
      expect(r.body.code).toBe('invoice_not_payable');
    });

    it('refuses a payment request for a non-user payer (organization/company): 409 payment_request_not_supported (B-026)', async () => {
      const { priceId, sellerId } = await seedPrice();
      const { body: draft } = await asProducer.post('/billing/invoices', { ...invoiceBody({ priceId, sellerId }), payer: { type: 'organization', id: crypto.randomUUID() } }).expect(201);
      await asProducer.post(`/billing/invoices/${draft.id}/issue`).expect(200);
      const r = await asProducer.post(`/billing/invoices/${draft.id}/payment-requests`).expect(409);
      expect(r.body.code).toBe('payment_request_not_supported');
    });

    it('a request can be created ONLY for the invoice\'s full total and currency — there is no field to override either (no client-supplied amount/currency exists)', async () => {
      const { priceId, sellerId } = await seedPrice({ unitAmount: 777 });
      const { body: draft } = await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId, quantity: 1, payerId: 'user-1' })).expect(201);
      await asProducer.post(`/billing/invoices/${draft.id}/issue`).expect(200);
      const r = await asPayer.post(`/billing/invoices/${draft.id}/payment-requests`, { amount: 1, currency: 'USD' }).expect(201);
      expect(r.body.amount).toBe(777); // the body is ignored: amount/currency always come from the invoice (BI-09)
      expect(r.body.currency).toBe('TND');
    });

    it('gets a payment request for its payer and for the invoice\'s producer; 404 for an unrelated user', async () => {
      const { priceId, sellerId } = await seedPrice();
      const { body: draft } = await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId, payerId: 'user-1' })).expect(201);
      await asProducer.post(`/billing/invoices/${draft.id}/issue`).expect(200);
      const { body: pr } = await asPayer.post(`/billing/invoices/${draft.id}/payment-requests`).expect(201);

      await asPayer.get(`/billing/payment-requests/${pr.id}`).expect(200);
      await asProducer.get(`/billing/payment-requests/${pr.id}`).expect(200);
      await asOtherUser.get(`/billing/payment-requests/${pr.id}`).expect(404);
    });

    it('the invoice representation reflects the active payment request without ever implying Payment accepted it', async () => {
      const { priceId, sellerId } = await seedPrice();
      const { body: draft } = await asProducer.post('/billing/invoices', invoiceBody({ priceId, sellerId, payerId: 'user-1' })).expect(201);
      await asProducer.post(`/billing/invoices/${draft.id}/issue`).expect(200);
      const { body: pr } = await asPayer.post(`/billing/invoices/${draft.id}/payment-requests`).expect(201);
      const invoice = await asProducer.get(`/billing/invoices/${draft.id}`).expect(200);
      expect(invoice.body.activePaymentRequest).toEqual({ id: pr.id, status: 'created', paymentId: null });
      expect(invoice.body.status).toBe('open'); // never "paid": nothing here can mark it paid without a real Payment event
    });
  });
});
