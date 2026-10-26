import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity, type EventEnvelope } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { BILLING_OPERATIONS } from '../src/admission/caller-admission.policy.js';
import { billingMigrationsDir } from '../src/app.module.js';
import { CheckoutModule } from '../src/checkout/checkout.module.js';
import { CheckoutService } from '../src/checkout/checkout.service.js';
import type { BillingConfig } from '../src/config/billing-config.js';
import type { PaymentEventFacts } from '../src/domain/payment-event-decision.js';
import type { PaymentCreateBody } from '../src/domain/payment-request-mapping.js';
import { PaymentDispatcher } from '../src/payment-integration/payment-dispatcher.js';
import type { CancelPaymentOutcome, CreatePaymentOutcome, PaymentClient, PaymentSnapshot } from '../src/payment-integration/payment-client.js';
import { createTestApp, type TestApp } from './support/app.js';
import { anchorOccurrence } from './support/billing-calendar.js';
import { describeWithEnv } from './support/env.js';

type Row = Record<string, any>;

/** Payment, as the dispatcher sees it: a scripted outcome per payment request (default: transient, i.e. Payment did not answer). */
class FakePaymentClient implements PaymentClient {
  readonly outcomes = new Map<string, CreatePaymentOutcome>();
  readonly calls: PaymentCreateBody[] = [];
  async createPayment(body: PaymentCreateBody): Promise<CreatePaymentOutcome> {
    this.calls.push(body);
    return this.outcomes.get(body.paymentRequestId) ?? { kind: 'transient' };
  }
  async getPayment(): Promise<PaymentSnapshot | null> {
    return null;
  }
  async cancelPayment(): Promise<CancelPaymentOutcome> {
    return { kind: 'cancelled' };
  }
}

const COMPANY = randomUUID(); // the Platform's Company in S3d: the SIMULATION seller reference (D4), not a legal seller
const OTHER_COMPANY = randomUUID();
const PLATFORM = randomUUID();
const OTHER_PLATFORM = randomUUID();
const U1 = randomUUID();
const U2 = randomUUID();

/**
 * Core V2 S3f direct checkout (register BIL-10; FC-12; the Owner's D1 to D6 with D4 Option A), for DEVELOPMENT AND SIMULATION ONLY:
 * the real application on real PostgreSQL 16, Auth's `/auth/me` stubbed per bearer (live: asked on every request), Payment scripted
 * behind the real dispatcher, and Payment's verified `payment.succeeded` delivered through the real strict consumer.
 */
describeWithEnv('direct checkout (Core V2 S3f, simulation) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const payment = new FakePaymentClient();
  const producer = generateServiceToken();
  const identities = new Map<string, AuthIdentity>([
    ['buyer-1', { id: U1, adminTier: null, isActive: true, memberships: [] }],
    ['buyer-2', { id: U2, adminTier: null, isActive: true, memberships: [] }],
    ['owner-1', { id: randomUUID(), adminTier: 'owner', isActive: true, memberships: [] }],
    ['operator-1', { id: randomUUID(), adminTier: 'operator', isActive: true, memberships: [] }],
    ['inactive-1', { id: randomUUID(), adminTier: null, isActive: false, memberships: [] }],
  ]);
  const meCalls: string[] = [];
  const authClient: AuthClient = {
    getIdentity: async (bearer) => {
      meCalls.push(bearer);
      if (bearer === 'auth-down') throw new ServiceUnavailableException();
      return identities.get(bearer) ?? null;
    },
    hasPlatformAccess: async () => false,
  };
  const server = () => t.app.getHttpServer();

  // ── fixtures
  let seq = 0;
  // S3g (D-CAT-8): checkout sells the Owner's products (provenance `billing-owner`); a shape the Owner cannot create is a producer's
  const OWNER_SELLER: Record<string, string> = { [PLATFORM]: COMPANY, [OTHER_PLATFORM]: OTHER_COMPANY };
  const productOf = async (o: { platformId?: string; target?: string; status?: string; sellerType?: string; sellerId?: string; producer?: string } = {}) => {
    const [sellerType, sellerId, target, platformId] = [o.sellerType ?? 'company', o.sellerId ?? COMPANY, o.target ?? 'personal', o.platformId ?? PLATFORM];
    const ownerShaped = sellerType === 'company' && target === 'personal' && OWNER_SELLER[platformId] === sellerId;
    return (await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId") VALUES ($1, $2, $3, $4, 'Personal plan', $5, $6, $7) RETURNING id`,
      [o.producer ?? (ownerShaped ? 'billing-owner' : 'test-producer'), sellerType, sellerId, `plan-${++seq}`, o.status ?? 'active', target, platformId])).rows[0].id as string;
  };
  const priceOf = async (productId: string, o: { unit?: number; retired?: boolean; from?: string } = {}) =>
    (await admin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom", "retiredAt") VALUES ($1, $2, 'TND', $3, 'recurring', 'month', 1, $4, $5) RETURNING id`,
      [productId, `r-${++seq}`, o.unit ?? 9000, o.from ?? '2020-01-01T00:00:00Z', o.retired ? new Date() : null])).rows[0].id as string;
  const offering = async () => {
    const productId = await productOf();
    return { platformId: PLATFORM, productId, priceId: await priceOf(productId) };
  };

  // ── HTTP
  let k = 0;
  const key = () => `checkout-${++k}-${randomUUID().slice(0, 8)}`;
  const checkout = (body: unknown, bearer: string | null = 'buyer-1', idem: string | null = key(), lang?: string) => {
    let r = request(server()).post('/billing/checkout/direct');
    if (bearer) r = r.set('authorization', `Bearer ${bearer}`);
    if (idem) r = r.set('idempotency-key', idem);
    if (lang) r = r.set('accept-language', lang);
    return r.send(body as object);
  };
  const poll = (id: string, bearer = 'buyer-1') => request(server()).get(`/billing/payment-requests/${id}`).set('authorization', `Bearer ${bearer}`);
  const entitlement = (userId: string, productId: string) =>
    request(server()).get(`/billing/users/${userId}/platforms/${PLATFORM}/products/${productId}/entitlement`).set('authorization', `Bearer ${producer.token}`);
  const checkoutInvoices = async () => Number((await admin.query(`SELECT count(*) FROM invoice WHERE producer = 'billing-checkout'`)).rows[0].count);
  const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0] as Row;
  const dispatch = () => t.app.get(PaymentDispatcher).dispatchOnce(0, 100); // staleness 0: an earlier `sending` is re-claimed at once
  const succeeded = (inv: Row, req: { id: string }, paymentId: string, payerId: string): EventEnvelope => {
    const id = randomUUID();
    const facts: PaymentEventFacts = {
      name: 'payment.succeeded', source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId: req.id, sourceType: 'invoice', sourceId: inv.id,
      payer: { type: 'user', id: payerId }, seller: { type: 'company', id: COMPANY }, organizationId: null, amount: Number(inv.total), currency: inv.currency, revision: 1,
    };
    const { name, source, ...payload } = facts;
    return { id, name, payload: payload as Record<string, unknown>, headers: { eventId: id, occurredAt: new Date().toISOString(), source, version: 1 } };
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingcheckout');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    for (const [p, c] of [[PLATFORM, COMPANY], [OTHER_PLATFORM, OTHER_COMPANY]]) {
      await admin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [p, c, randomUUID()]);
    }
    t = await createTestApp({
      databaseUrl: db.url, authClient, paymentClient: payment,
      tokens: [{ caller: 'test-producer', digest: producer.digest }],
      env: { BILLING_SERVICE_POLICY: JSON.stringify({ callers: { 'test-producer': { operations: [...BILLING_OPERATIONS], allowedPlatforms: [PLATFORM, OTHER_PLATFORM] } } }) },
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the checkout (D1, D2, D3, D6)

  describe('an eligible member checks out', () => {
    it('201 {invoiceId, paymentRequestId, paymentId: null, status: created}: one issued invoice, derived entirely by Billing, and nothing granted', async () => {
      const o = await offering();
      const r = await checkout(o, 'buyer-1', key(), 'ar');
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(Object.keys(r.body).sort()).toEqual(['invoiceId', 'paymentId', 'paymentRequestId', 'status']);
      expect(r.body).toMatchObject({ paymentId: null, status: 'created' });
      const inv = await one(`SELECT * FROM invoice WHERE id = $1`, [r.body.invoiceId]);
      expect(inv).toMatchObject({ producer: 'billing-checkout', status: 'open', payerType: 'user', payerId: U1, sellerType: 'company', sellerId: COMPANY, organizationId: null, currency: 'TND', total: '9000', taxTreatment: 'not_determined' });
      expect(inv.issuerSnapshot).toEqual({ schemaVersion: 2, partyType: 'company', companyId: COMPANY, platformId: PLATFORM, legalIdentity: 'not_determined' }); // D1: no invented identity
      expect(inv.billToSnapshot).toEqual({ schemaVersion: 2, partyType: 'user', userId: U1, legalIdentity: 'not_determined' });
      expect(inv.presentation).toEqual({ schemaVersion: 1, template: 'system:1', locale: 'ar' }); // D6
      expect((await admin.query(`SELECT quantity, "priceId" FROM invoice_line WHERE "invoiceId" = $1`, [inv.id])).rows).toEqual([{ quantity: 1, priceId: o.priceId }]);
      expect(await one(`SELECT purpose, target, "beneficiaryUserId", "payerId" FROM invoice_entitlement WHERE "invoiceId" = $1`, [inv.id])).toEqual({ purpose: 'direct_purchase', target: 'personal', beneficiaryUserId: U1, payerId: U1 });
      expect(await one(`SELECT status, "paymentId", "createdByType", "createdById" FROM payment_request WHERE id = $1`, [r.body.paymentRequestId])).toEqual({ status: 'created', paymentId: null, createdByType: 'user', createdById: U1 });
      expect(Number((await one(`SELECT count(*) FROM subscription_purchase WHERE "beneficiaryUserId" = $1`, [U1])).count)).toBe(0);
      expect((await entitlement(U1, o.productId).expect(200)).body).toEqual({ valid: false, expiresAt: null }); // checkout is never settlement
    });

    it('the locale is negotiated from Accept-Language among en, fr and ar; the template is always system:1', async () => {
      for (const [lang, locale] of [['fr-TN,fr;q=0.9', 'fr'], ['en', 'en'], ['de', 'en'], [undefined, 'en']] as const) {
        const r = await checkout(await offering(), 'buyer-1', key(), lang);
        expect((await one(`SELECT presentation FROM invoice WHERE id = $1`, [r.body.invoiceId])).presentation, String(lang)).toEqual({ schemaVersion: 1, template: 'system:1', locale });
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── eligibility (B6) and forged input

  describe('who may check out, and what they may say', () => {
    it.each([['an Owner', 'owner-1'], ['an Operator', 'operator-1'], ['an inactive member', 'inactive-1']])('%s is 403 member_not_eligible; nothing created', async (_n, bearer) => {
      const before = await checkoutInvoices();
      expect([(await checkout(await offering(), bearer)).status, (await checkout(await offering(), bearer)).body.code]).toEqual([403, 'member_not_eligible']);
      expect(await checkoutInvoices()).toBe(before);
    });

    it('no bearer or a bearer Auth refuses is 401; a SERVICE token is 401 and never sent to Auth; Auth down is 503 — nothing created', async () => {
      const o = await offering();
      const before = await checkoutInvoices();
      expect((await checkout(o, null)).status).toBe(401);
      expect((await checkout(o, 'revoked')).status).toBe(401);
      meCalls.length = 0;
      expect((await checkout(o, producer.token)).status).toBe(401);
      expect(meCalls).toEqual([]);
      expect((await checkout(o, 'auth-down')).status).toBe(503);
      expect(await checkoutInvoices()).toBe(before);
    });

    it('eligibility is asked of Auth on every request (live, never cached)', async () => {
      meCalls.length = 0;
      await checkout(await offering());
      await checkout(await offering());
      expect(meCalls.filter((b) => b === 'buyer-1')).toHaveLength(2);
    });

    it.each([
      ['a payer', { payer: { type: 'user', id: U2 } }], ['a seller', { seller: { type: 'company', id: OTHER_COMPANY } }], ['an Organization', { organizationId: randomUUID() }],
      ['a beneficiary', { beneficiaryUserId: U2 }], ['an amount', { amount: 1 }], ['a quantity', { quantity: 2 }], ['a template', { template: 'evil:1' }],
      ['a snapshot', { issuerSnapshot: { schemaVersion: 1, name: 'Forged Ltd' } }], ['a user id', { userId: U2 }],
    ])('forging %s is 400 invalid_checkout_request; nothing created', async (_n, extra) => {
      const before = await checkoutInvoices();
      expect((await checkout({ ...(await offering()), ...extra })).body.code).toBe('invalid_checkout_request');
      expect(await checkoutInvoices()).toBe(before);
    });

    it('an Idempotency-Key is required', async () => {
      expect((await checkout(await offering(), 'buyer-1', null)).body.code).toBe('idempotency_key_required');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── product, seller reference, price

  describe('what may be bought (FC-12, D4 simulation seller reference)', () => {
    it('only an ACTIVE personal product of THIS Platform whose Company seller reference is the Platform\'s Company (else 409 product_not_available)', async () => {
      const cases = [
        await productOf({ platformId: OTHER_PLATFORM, sellerId: OTHER_COMPANY }), // another Platform's (asked through this one)
        await productOf({ target: 'organization' }),
        await productOf({ status: 'archived' }),
        await productOf({ sellerId: OTHER_COMPANY }), // a conflicting Company seller reference
        await productOf({ sellerId: 'nawara' }), // a free-text "company" that is not the verified reference
        await productOf({ sellerType: 'organization', sellerId: randomUUID() }), // an Organization seller
        await productOf({ producer: 'test-producer' }), // S3g (D-CAT-8): a PRODUCER's product of the same shape, not the Owner's
      ];
      for (const productId of [...cases, randomUUID()]) {
        expect((await checkout({ platformId: PLATFORM, productId, priceId: await priceOf(productId).catch(() => randomUUID()) })).body.code).toBe('product_not_available');
      }
    });

    it('a Platform without its S3d configuration is 409 platform_not_configured', async () => {
      expect((await checkout({ platformId: randomUUID(), productId: randomUUID(), priceId: randomUUID() })).body.code).toBe('platform_not_configured');
    });

    it('the price must be an effective, unretired recurring price OF that product (else 422 price_not_available)', async () => {
      const o = await offering();
      const other = await offering();
      for (const priceId of [other.priceId, await priceOf(o.productId, { retired: true }), await priceOf(o.productId, { from: '2099-01-01T00:00:00Z' }), randomUUID()]) {
        expect((await checkout({ ...o, priceId })).body.code).toBe('price_not_available');
      }
    });

    it('several personal products of one Platform are each purchasable (no universal plan)', async () => {
      const a = await offering();
      const b = await offering();
      expect([(await checkout(a, 'buyer-2')).status, (await checkout(b, 'buyer-2')).status]).toEqual([201, 201]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── idempotency and concurrency (D5)

  describe('retries, duplicates and concurrency', () => {
    it('the same key and request replays the ORIGINAL result; the same key with another request is 409; nothing is duplicated', async () => {
      const o = await offering();
      const idem = key();
      const first = await checkout(o, 'buyer-1', idem);
      const replay = await checkout(o, 'buyer-1', idem);
      expect([replay.status, replay.headers['idempotent-replayed'], replay.body]).toEqual([201, 'true', first.body]);
      expect((await checkout({ ...o, priceId: await priceOf(o.productId) }, 'buyer-1', idem)).body.code).toBe('idempotency_key_conflict');
      expect(Number((await one(`SELECT count(*) FROM invoice_line l JOIN invoice i ON i.id = l."invoiceId" WHERE i.producer = 'billing-checkout' AND l."productId" = $1`, [o.productId])).count)).toBe(1);
    });

    it('a new key for the same product and price while the request is unfinished returns that request (200); another price is 409 checkout_uncertain', async () => {
      const o = await offering();
      const first = await checkout(o);
      const again = await checkout(o);
      expect([again.status, again.body.invoiceId, again.body.paymentRequestId]).toEqual([200, first.body.invoiceId, first.body.paymentRequestId]);
      expect((await checkout({ ...o, priceId: await priceOf(o.productId) })).body.code).toBe('checkout_uncertain');
    });

    it('a key is per buyer, and a buyer never reaches another buyer\'s checkout or request', async () => {
      const o = await offering();
      const idem = key();
      const mine = await checkout(o, 'buyer-1', idem);
      const theirs = await checkout(o, 'buyer-2', idem); // the same key, another buyer: a separate checkout
      expect([theirs.status, theirs.body.invoiceId === mine.body.invoiceId]).toEqual([201, false]);
      expect((await poll(mine.body.paymentRequestId, 'buyer-2')).status).toBe(404);
      expect((await poll(mine.body.paymentRequestId, 'buyer-1')).status).toBe(200);
    });

    it('two simultaneous checkouts with different keys (same product and price): one 201, one 200 with the same request', async () => {
      const o = await offering();
      const rs = await Promise.all([checkout(o), checkout(o)]);
      expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 201]);
      expect(rs[0]!.body.paymentRequestId).toBe(rs[1]!.body.paymentRequestId);
      expect(Number((await one(`SELECT count(*) FROM invoice_line l JOIN invoice i ON i.id = l."invoiceId" WHERE i.producer = 'billing-checkout' AND l."productId" = $1`, [o.productId])).count)).toBe(1);
    });

    it('8 simultaneous uses of ONE key make one checkout; simultaneous different prices make one checkout and refuse the other', async () => {
      const o = await offering();
      const idem = key();
      const rs = await Promise.all(Array.from({ length: 8 }, () => checkout(o, 'buyer-2', idem)));
      expect(new Set(rs.map((r) => r.body.invoiceId)).size).toBe(1);
      expect(rs.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(7);
      const p = await offering();
      const p2 = await priceOf(p.productId);
      const mixed = await Promise.all([checkout(p, 'buyer-2'), checkout({ ...p, priceId: p2 }, 'buyer-2')]);
      expect(mixed.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── asynchronous dispatch and recovery (D5)

  describe('asynchronous Payment dispatch', () => {
    it('unknown Payment outcome: paymentId stays null (never invented); the dispatcher retries; polling shows the identifier once Payment returns one', async () => {
      const o = await offering();
      const r = await checkout(o, 'buyer-2');
      await dispatch(); // Payment did not answer (transient)
      expect((await poll(r.body.paymentRequestId, 'buyer-2')).body).toMatchObject({ paymentId: null });
      const paymentId = randomUUID();
      const inv = await one(`SELECT * FROM invoice WHERE id = $1`, [r.body.invoiceId]);
      payment.outcomes.set(r.body.paymentRequestId, { kind: 'accepted', snapshot: {
        paymentId, paymentRequestId: r.body.paymentRequestId, status: 'pending', amount: Number(inv.total), currency: 'TND', sourceType: 'invoice', sourceId: inv.id,
        payer: { type: 'user', id: U2 }, seller: { type: 'company', id: COMPANY }, organizationId: null, closedAt: null,
      } as PaymentSnapshot });
      await dispatch();
      expect((await poll(r.body.paymentRequestId, 'buyer-2')).body).toMatchObject({ status: 'requested', paymentId });
      const sent = payment.calls.find((c) => c.paymentRequestId === r.body.paymentRequestId)!;
      expect(sent).toMatchObject({ sourceType: 'invoice', sourceId: inv.id, payer: { type: 'user', id: U2 }, seller: { type: 'company', id: COMPANY }, amount: 9000, currency: 'TND' });
      expect((await checkout(o, 'buyer-2')).body).toMatchObject({ paymentRequestId: r.body.paymentRequestId, paymentId, status: 'requested' }); // reused, now with its id
    });

    it('a rejected dispatch ends the request; a new checkout of that product then creates a new obligation', async () => {
      const o = await offering();
      const r = await checkout(o);
      payment.outcomes.set(r.body.paymentRequestId, { kind: 'rejected', code: 'invalid_payment_request' });
      await dispatch();
      expect((await poll(r.body.paymentRequestId)).body.status).toBe('rejected');
      const next = await checkout(o);
      expect([next.status, next.body.invoiceId === r.body.invoiceId]).toEqual([201, false]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the simulation, end to end

  it('SIMULATION: checkout → invoice → payment request → dispatcher → verified payment.succeeded → purchase ledger → personal entitlement read', async () => {
    const o = await offering();
    const c = await checkout(o, 'buyer-1');
    const paymentId = randomUUID();
    const inv = await one(`SELECT * FROM invoice WHERE id = $1`, [c.body.invoiceId]);
    payment.outcomes.set(c.body.paymentRequestId, { kind: 'accepted', snapshot: {
      paymentId, paymentRequestId: c.body.paymentRequestId, status: 'pending', amount: 9000, currency: 'TND', sourceType: 'invoice', sourceId: inv.id,
      payer: { type: 'user', id: U1 }, seller: { type: 'company', id: COMPANY }, organizationId: null, closedAt: null,
    } as PaymentSnapshot });
    await dispatch();
    expect((await poll(c.body.paymentRequestId)).body).toMatchObject({ status: 'requested', paymentId });
    expect((await entitlement(U1, o.productId).expect(200)).body).toEqual({ valid: false, expiresAt: null }); // a requested payment grants nothing

    const event = succeeded(inv, { id: c.body.paymentRequestId }, paymentId, U1);
    await t.bus.deliver(event); // Payment's verified success, through the real strict consumer (S1 provenance)
    const settledAt = new Date(event.headers.occurredAt as string);
    expect(await one(`SELECT status FROM invoice WHERE id = $1`, [inv.id])).toEqual({ status: 'paid' });
    expect((await admin.query(`SELECT purpose, "beneficiaryUserId", "productId", "priceId", "invoiceId" FROM subscription_purchase WHERE "invoiceId" = $1`, [inv.id])).rows)
      .toEqual([{ purpose: 'direct_purchase', beneficiaryUserId: U1, productId: o.productId, priceId: o.priceId, invoiceId: inv.id }]);
    expect((await entitlement(U1, o.productId).expect(200)).body).toEqual({ valid: true, expiresAt: anchorOccurrence(settledAt, 1).toISOString() });
    expect((await entitlement(U2, o.productId).expect(200)).body).toEqual({ valid: false, expiresAt: null }); // never another buyer

    await t.bus.deliver(event, 'verified_duplicate'); // a redelivery records nothing more
    expect(Number((await one(`SELECT count(*) FROM subscription_purchase WHERE "invoiceId" = $1`, [inv.id])).count)).toBe(1);
    // after the purchase, the same product may be bought again (a renewal): nothing is unfinished any more
    expect((await checkout(o, 'buyer-1')).status).toBe(201);
  });

  it('S3g (D-CAT-7): retiring the price and archiving the product after a settled purchase stop NEW sales only; the purchase, invoice and entitlement are untouched', async () => {
    const o = await offering();
    const yearly = await priceOf(o.productId, { unit: 90000 });
    const c = await checkout(o, 'buyer-2');
    const paymentId = randomUUID();
    const inv = await one(`SELECT * FROM invoice WHERE id = $1`, [c.body.invoiceId]);
    payment.outcomes.set(c.body.paymentRequestId, { kind: 'accepted', snapshot: {
      paymentId, paymentRequestId: c.body.paymentRequestId, status: 'pending', amount: 9000, currency: 'TND', sourceType: 'invoice', sourceId: inv.id,
      payer: { type: 'user', id: U2 }, seller: { type: 'company', id: COMPANY }, organizationId: null, closedAt: null,
    } as PaymentSnapshot });
    await dispatch();
    await t.bus.deliver(succeeded(inv, { id: c.body.paymentRequestId }, paymentId, U2));
    expect(await one(`SELECT status FROM invoice WHERE id = $1`, [inv.id])).toEqual({ status: 'paid' });
    const before = {
      invoice: await one(`SELECT status, total, currency, "sellerId", revision FROM invoice WHERE id = $1`, [inv.id]),
      lines: (await admin.query(`SELECT * FROM invoice_line WHERE "invoiceId" = $1`, [inv.id])).rows,
      purchases: (await admin.query(`SELECT * FROM subscription_purchase WHERE "invoiceId" = $1`, [inv.id])).rows,
      entitlement: (await entitlement(U2, o.productId).expect(200)).body,
    };
    expect(before.entitlement.valid).toBe(true);

    await admin.query(`UPDATE price SET "retiredAt" = now() WHERE id = $1`, [o.priceId]); // what the Owner's retire writes
    expect((await checkout(o, 'buyer-2')).body.code).toBe('price_not_available'); // no new sale or renewal on the retired price
    expect((await checkout({ ...o, priceId: yearly }, 'buyer-2')).status).toBe(201); // another price of the product is still sellable
    await admin.query(`UPDATE product SET status = 'archived' WHERE id = $1`, [o.productId]); // what the Owner's archive writes
    expect((await checkout({ ...o, priceId: yearly }, 'buyer-1')).body.code).toBe('product_not_available'); // no new sale of any of its prices

    expect(await one(`SELECT status, total, currency, "sellerId", revision FROM invoice WHERE id = $1`, [inv.id])).toEqual(before.invoice);
    expect((await admin.query(`SELECT * FROM invoice_line WHERE "invoiceId" = $1`, [inv.id])).rows).toEqual(before.lines);
    expect((await admin.query(`SELECT * FROM subscription_purchase WHERE "invoiceId" = $1`, [inv.id])).rows).toEqual(before.purchases);
    expect((await entitlement(U2, o.productId).expect(200)).body).toEqual(before.entitlement); // the paid entitlement is kept, never revoked
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── production and the database guard

  describe('production refusal and the reserved producer', () => {
    it('production mounts no checkout route, and the service refuses even if reached', async () => {
      const prod = { isProduction: true } as BillingConfig;
      expect(CheckoutModule.register(prod)).toEqual({ module: CheckoutModule });
      const svc = new CheckoutService(null as never, null as never, null as never, prod);
      await expect(svc.checkout(U1, 'k-12345678', { platformId: PLATFORM, productId: PLATFORM, priceId: PLATFORM }, 'en', null as never)).rejects.toMatchObject({ status: 404 });
      expect(CheckoutModule.register({ isProduction: false } as BillingConfig).controllers).toHaveLength(1);
    });

    it('the database refuses any other shape under the reserved producer, whatever path writes it (checked at commit)', async () => {
      const o = await offering();
      const attempt = async (over: { organizationId?: string | null; issuer?: Row; sellerId?: string }) => {
        const cl = await admin.connect();
        try {
          await cl.query('BEGIN');
          const inv = (await cl.query(`INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId", "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot")
                         VALUES ('billing-checkout', gen_random_uuid(), repeat('a', 64), 'company', $1, 'user', $2, $3, 'direct_checkout', 's', 'TND', 9000, 9000, $4, $5) RETURNING id`,
            [over.sellerId ?? COMPANY, U2, over.organizationId ?? null, JSON.stringify(over.issuer ?? { schemaVersion: 2, partyType: 'company', companyId: COMPANY, platformId: PLATFORM, legalIdentity: 'not_determined' }),
              JSON.stringify({ schemaVersion: 2, partyType: 'user', userId: U2, legalIdentity: 'not_determined' })])).rows[0].id;
          await cl.query(`INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "causeType") VALUES ('invoice', $1, NULL, 'draft', 0, 'system', 'request')`, [inv]);
          return await cl.query('COMMIT').then(() => 'committed', (e: { constraint?: string }) => e.constraint ?? 'refused');
        } catch (e) {
          await cl.query('ROLLBACK').catch(() => undefined);
          return (e as { constraint?: string }).constraint ?? 'refused';
        } finally {
          cl.release();
        }
      };
      expect(await attempt({})).toBe('checkout_invoice_shape'); // a bare draft: no line, not issued, no routing, no payment request
      expect(await attempt({ organizationId: randomUUID() })).toBe('checkout_invoice_shape');
      expect(await attempt({ issuer: { schemaVersion: 2, partyType: 'company', companyId: COMPANY, platformId: PLATFORM, legalIdentity: 'not_determined', legalName: 'Invented SARL' } })).toBe('checkout_invoice_shape');
      expect(await attempt({ sellerId: OTHER_COMPANY })).toBe('checkout_invoice_shape');
      expect(o).toBeTruthy();
    });
  });
});
