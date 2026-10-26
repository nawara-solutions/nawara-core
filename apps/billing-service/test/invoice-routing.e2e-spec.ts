import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService, generateServiceToken, HierarchyUnavailableError, kitMigrationsDir, runMigrations, type OrganizationReferenceResolver } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { BILLING_OPERATIONS } from '../src/admission/caller-admission.policy.js';
import { billingMigrationsDir } from '../src/app.module.js';
import type { TransitionContext } from '../src/domain/actors.js';
import { recordTransition } from '../src/domain/transitions.js';
import { PaymentRequestRepository } from '../src/invoices/payment-request.repository.js';
import { SubscriptionRepository } from '../src/subscriptions/subscription.repository.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { configurePlatform, paymentPurposeOf } from './support/settlement.js';

const P1 = '11111111-0000-4000-8000-0000000000a1';
const P2 = '22222222-0000-4000-8000-0000000000a2';
const P3 = '33333333-0000-4000-8000-0000000000a3';
const ORG_A = 'aaaaaaaa-0000-4000-8000-00000000000a'; // an Organization of P1
const ORG_B = 'bbbbbbbb-0000-4000-8000-00000000000b'; // an Organization of P2
const ORG_DOWN = 'dddddddd-0000-4000-8000-00000000000d'; // the authority cannot answer for it
const USER = '1a1a1a1a-0000-4000-8000-000000000001';
const OTHER_USER = '2b2b2b2b-0000-4000-8000-000000000002';

/**
 * Core V2 S3a (ADR-0044 B1, B2 as amended by the Owner's Option C; S0 DB-1 to DB-4, DB-7; register BIL-02 fields, BIL-08): product
 * subscription targets and the immutable `invoice_entitlement` routing record, through the HTTP API and directly against the schema
 * (real PostgreSQL), plus the cross-beneficiary guard on the settlement path.
 */
describeWithEnv('invoice target routing (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Client;
  const producer = generateServiceToken();
  const otherProducer = generateServiceToken();
  const platforms: Record<string, string> = { [ORG_A]: P1, [ORG_B]: P2 };
  const reference: OrganizationReferenceResolver = {
    resolve: async (organizationId) => {
      if (organizationId === ORG_DOWN) throw new HierarchyUnavailableError();
      const platformId = platforms[organizationId];
      return platformId ? { organizationId, platformId, companyId: 'cccccccc-0000-4000-8000-00000000000c' } : null;
    },
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingrouting');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    platforms[ORG_DOWN] = P1;
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [{ caller: 'test-producer', digest: producer.digest }, { caller: 'other-producer', digest: otherProducer.digest }],
      organizationReference: reference,
      env: {
        BILLING_SERVICE_POLICY: JSON.stringify({
          callers: {
            'test-producer': { operations: [...BILLING_OPERATIONS], allowedPlatforms: [P1, P2] },
            'other-producer': { operations: [...BILLING_OPERATIONS], allowedPlatforms: [P3] },
          },
        }),
      },
    });
    admin = new pg.Client({ connectionString: db.url });
    await admin.connect();
    for (const p of [P1, P2, P3]) await configurePlatform(admin, p); // Core V2 S3d: a subscription product's Platform is configured
  });
  afterAll(async () => {
    await admin?.end();
    await t?.app.close();
    await db?.drop();
  });

  const as = (token: string) => ({
    post: (path: string, body?: unknown) => request(t.app.getHttpServer()).post(path).set('authorization', `Bearer ${token}`).send(body ?? {}),
    get: (path: string) => request(t.app.getHttpServer()).get(path).set('authorization', `Bearer ${token}`),
  });
  const svc = as(producer.token);
  const other = as(otherProducer.token);
  let seq = 0;

  async function product(o: { target?: string; platformId?: string | null; caller?: ReturnType<typeof as>; entitlementKind?: string; seller?: string } = {}) {
    seq += 1;
    const body: Record<string, unknown> = { seller: { type: 'company', id: o.seller ?? 'nawara' }, code: `prod-${seq}`, name: `Product ${seq}` };
    if (o.target) body.subscriptionTarget = o.target;
    if (o.platformId !== undefined) body.platformId = o.platformId;
    else if (o.target && o.target !== 'none') body.platformId = P1;
    if (o.entitlementKind) body.entitlementKind = o.entitlementKind;
    return (o.caller ?? svc).post('/billing/products', body);
  }
  async function price(productId: string, recurring: boolean, caller = svc) {
    const body = recurring
      ? { productId, clientReference: `ref-${++seq}`, currency: 'TND', unitAmount: 5000, interval: 'recurring', intervalUnit: 'month', intervalCount: 1, effectiveFrom: new Date().toISOString() }
      : { productId, clientReference: `ref-${++seq}`, currency: 'TND', unitAmount: 1500, interval: 'one_time', effectiveFrom: new Date().toISOString() };
    return caller.post('/billing/prices', body);
  }
  async function priceFor(o: Parameters<typeof product>[0] & { recurring?: boolean } = {}): Promise<{ productId: string; priceId: string }> {
    const p = await product(o);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const pr = await price(p.body.id, o.recurring ?? (o.target !== undefined && o.target !== 'none'), o.caller ?? svc);
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    return { productId: p.body.id as string, priceId: pr.body.id as string };
  }
  function invoiceBody(o: { priceIds: string[]; payer?: { type: string; id: string }; organizationId?: string | null; seller?: string }) {
    return {
      invoiceRequestId: crypto.randomUUID(), seller: { type: 'company', id: o.seller ?? 'nawara' }, payer: o.payer ?? { type: 'user', id: USER },
      ...(o.organizationId ? { organizationId: o.organizationId } : {}),
      sourceType: 'contract', sourceId: `src-${++seq}`, issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 },
      lines: o.priceIds.map((priceId) => ({ priceId, quantity: 1 })),
    };
  }
  async function draft(o: Parameters<typeof invoiceBody>[0]): Promise<string> {
    const r = await svc.post('/billing/invoices', invoiceBody(o));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }
  const issue = (id: string, caller = svc) => caller.post(`/billing/invoices/${id}/issue`, {});
  const routingRow = async (id: string) => (await admin.query('SELECT * FROM invoice_entitlement WHERE "invoiceId" = $1', [id])).rows[0];
  const statusOf = async (id: string) => (await admin.query('SELECT status FROM invoice WHERE id = $1', [id])).rows[0].status as string;

  // ───────────────────────────────────────────────────────────────────────────────────────────── products (B1, BIL-02)

  describe('product subscription targets', () => {
    it('a subscription product declares its target and Platform; an ordinary one is `none`; both are in the representation', async () => {
      const org = await product({ target: 'organization' });
      expect(org.status).toBe(201);
      expect(org.body).toMatchObject({ subscriptionTarget: 'organization', platformId: P1 });
      expect((await product({ target: 'personal' })).body).toMatchObject({ subscriptionTarget: 'personal', platformId: P1 });
      expect((await product()).body).toMatchObject({ subscriptionTarget: 'none', platformId: null });
      expect((await product({ entitlementKind: 'organization_license' })).body).toMatchObject({ entitlementKind: 'organization_license', subscriptionTarget: 'none' });
    });

    it('refuses a subscription product without a Platform (400) or with a Platform outside the producer\'s (403 platform_not_permitted)', async () => {
      expect(await product({ target: 'organization', platformId: null }).then((r) => [r.status, r.body.code])).toEqual([400, 'invalid_product_request']);
      expect(await product({ target: 'personal', platformId: P3 }).then((r) => [r.status, r.body.code])).toEqual([403, 'platform_not_permitted']);
      expect(await product({ platformId: P3 }).then((r) => [r.status, r.body.code])).toEqual([403, 'platform_not_permitted']);
    });

    it('target and Platform are part of the product\'s identity: a replay with another target or Platform is 409 product_conflict', async () => {
      const first = await product({ target: 'organization' });
      const code = first.body.code as string;
      const again = (o: Record<string, unknown>) => svc.post('/billing/products', { seller: { type: 'company', id: 'nawara' }, code, name: first.body.name, ...o });
      expect((await again({ subscriptionTarget: 'organization', platformId: P1 })).status).toBe(200);
      expect((await again({ subscriptionTarget: 'personal', platformId: P1 })).body.code).toBe('product_conflict');
      expect((await again({ subscriptionTarget: 'organization', platformId: P2 })).body.code).toBe('product_conflict');
      expect((await again({})).body.code).toBe('product_conflict');
    });

    it('a subscription product has recurring prices only (422 through the API; the schema refuses it too)', async () => {
      const p = await product({ target: 'personal' });
      expect(await price(p.body.id, false).then((r) => [r.status, r.body.code])).toEqual([422, 'subscription_price_not_recurring']);
      await expect(admin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval") VALUES ($1, 'direct', 'TND', 10, 'one_time')`, [p.body.id]))
        .rejects.toThrow(/recurring prices only/);
      expect((await price(p.body.id, true)).status).toBe(201);
    });

    it('target and Platform never change once created (immutable, so also after a first sale), and the schema refuses contradictions', async () => {
      const p = await product({ target: 'organization' });
      await expect(admin.query(`UPDATE product SET "subscriptionTarget" = 'personal' WHERE id = $1`, [p.body.id])).rejects.toThrow(/immutable/);
      await expect(admin.query(`UPDATE product SET "platformId" = $2 WHERE id = $1`, [p.body.id, P2])).rejects.toThrow(/immutable/);
      await expect(admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget") VALUES ('test-producer', 'company', 'n', 'no-platform', 'N', 'personal')`))
        .rejects.toThrow(/product_subscription_has_platform/);
      await expect(admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId") VALUES ('test-producer', 'company', 'n', 'bad-target', 'N', 'company', $1)`, [P1]))
        .rejects.toThrow(/product_subscription_target_valid/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────── routing at issue (B2, BIL-08)

  describe('routing at issue', () => {
    it('organization_subscription: a user pays the Organization\'s subscription; the record names that Organization and product', async () => {
      const { productId, priceId } = await priceFor({ target: 'organization' });
      const id = await draft({ priceIds: [priceId], organizationId: ORG_A });
      const r = await issue(id);
      expect(r.status).toBe(200);
      expect(r.body.routing).toEqual({ purpose: 'organization_subscription', target: 'organization' });
      expect(await routingRow(id)).toMatchObject({ purpose: 'organization_subscription', target: 'organization', payerType: 'user', payerId: USER, beneficiaryUserId: null, organizationId: ORG_A, productId });
      expect((await svc.get(`/billing/invoices/${id}`)).body.routing).toEqual({ purpose: 'organization_subscription', target: 'organization' });
    });

    it('direct_purchase: a user buys a personal product; the payer IS the beneficiary; an Organization on the invoice is not recorded', async () => {
      const { productId, priceId } = await priceFor({ target: 'personal' });
      const id = await draft({ priceIds: [priceId], payer: { type: 'user', id: OTHER_USER }, organizationId: ORG_A });
      expect((await issue(id)).body.routing).toEqual({ purpose: 'direct_purchase', target: 'personal' });
      expect(await routingRow(id)).toMatchObject({ purpose: 'direct_purchase', payerId: OTHER_USER, beneficiaryUserId: OTHER_USER, organizationId: null, productId });
    });

    it('non_entitlement: no subscription line at all (one-time or ordinary recurring products), a user or Company payer; entitlementKind never routes', async () => {
      const oneTime = await priceFor();
      const legacy = await priceFor({ entitlementKind: 'organization_license', recurring: true }); // an ordinary product, however it is labelled
      // Core V2 S4a (P-1): a user or a Company, never an Organization (refused below)
      for (const [priceIds, payer] of [[[oneTime.priceId], { type: 'company', id: 'acme' }], [[legacy.priceId, oneTime.priceId], { type: 'user', id: USER }]] as const) {
        const id = await draft({ priceIds: [...priceIds], payer, organizationId: payer.type === 'company' ? null : ORG_A });
        expect((await issue(id)).body.routing).toEqual({ purpose: 'non_entitlement', target: 'none' });
        expect(await routingRow(id)).toMatchObject({ purpose: 'non_entitlement', target: 'none', beneficiaryUserId: null, organizationId: null, productId: null });
      }
    });

    it('a draft has no routing yet; a discarded draft never gets one', async () => {
      const { priceId } = await priceFor();
      const id = await draft({ priceIds: [priceId] });
      expect((await svc.get(`/billing/invoices/${id}`)).body.routing).toBeNull();
      expect((await svc.post(`/billing/invoices/${id}/discard`, {})).status).toBe(200);
      expect(await routingRow(id)).toBeUndefined();
    });

    it.each([
      ['an Organization paying an Organization subscription (B7)', 'organization', { type: 'organization', id: ORG_A }, null, 'organization_payer'],
      ['an Organization subscription naming no Organization', 'organization', { type: 'user', id: USER }, null, 'organization_missing'],
      ['an Organization paying a personal product (assisted settlement: S5a)', 'personal', { type: 'organization', id: ORG_A }, null, 'assisted_settlement_unavailable'],
      ['a company paying a personal product', 'personal', { type: 'company', id: 'acme' }, null, 'payer_not_user'],
      ['an Organization paying an ordinary invoice (Core V2 S4a P-1: B2 narrowed; B7, DB-15)', 'none', { type: 'organization', id: ORG_A }, null, 'organization_payer'],
    ] as const)('refuses %s: 422 invoice_routing_invalid, the invoice stays a draft, nothing is recorded', async (_label, target, payer, organizationId, reason) => {
      const { priceId } = await priceFor({ target });
      const id = await draft({ priceIds: [priceId], payer, organizationId });
      const r = await issue(id);
      expect([r.status, r.body.code]).toEqual([422, 'invoice_routing_invalid']);
      expect(r.body.message).toContain(reason);
      expect(await statusOf(id)).toBe('draft');
      expect(await routingRow(id)).toBeUndefined();
    });

    it('refuses more than one subscription line (B2): subscription prices recur, so the existing one-recurring-line rule refuses it at creation', async () => {
      const a = await priceFor({ target: 'organization' });
      const b = await priceFor({ target: 'personal' });
      const r = await svc.post('/billing/invoices', invoiceBody({ priceIds: [a.priceId, b.priceId], organizationId: ORG_A }));
      expect([r.status, r.body.code]).toEqual([422, 'ambiguous_subscription_obligation']);
      // at issue, the routing decision refuses it too (domain/invoice-routing.spec.ts: multiple_subscription_lines)
    });

    it('no cross-Platform routing: an Organization of another Platform, or a product Platform outside the issuing caller\'s, is refused', async () => {
      const { priceId } = await priceFor({ target: 'organization' }); // P1
      const id = await draft({ priceIds: [priceId], organizationId: ORG_B }); // ORG_B is on P2 (in the caller's scope, not the product's)
      const r = await issue(id);
      expect([r.status, r.body.code]).toEqual([422, 'invoice_routing_invalid']);
      expect(r.body.message).toContain('organization_platform_mismatch');
      // a product of P3 (another producer's Platform), invoiced by a caller whose Platforms are P1 and P2
      const foreign = await priceFor({ target: 'personal', platformId: P3, caller: other });
      const id2 = await draft({ priceIds: [foreign.priceId] });
      const r2 = await issue(id2);
      expect([r2.status, r2.body.code]).toEqual([422, 'invoice_routing_invalid']);
      expect(r2.body.message).toContain('platform_out_of_scope');
      expect([await routingRow(id), await routingRow(id2)]).toEqual([undefined, undefined]);
    });

    it('the Organization authority unavailable: 503, the invoice stays a draft (fail closed)', async () => {
      const { priceId } = await priceFor({ target: 'organization' });
      const id = await draft({ priceIds: [priceId], organizationId: ORG_A });
      await admin.query(`SET session_replication_role = replica`); // re-point the draft at ORG_DOWN (the runtime never rewrites it)
      try {
        await admin.query(`UPDATE invoice SET "organizationId" = $2 WHERE id = $1`, [id, ORG_DOWN]);
      } finally {
        await admin.query(`SET session_replication_role = origin`);
      }
      const r = await issue(id);
      expect([r.status, r.body.code]).toEqual([503, 'hierarchy_unavailable']);
      expect(await statusOf(id)).toBe('draft');
      expect(await routingRow(id)).toBeUndefined();
    });

    it('idempotent: issuing again answers the same routing; concurrent issues write ONE record and one number', async () => {
      const { priceId } = await priceFor({ target: 'organization' });
      const id = await draft({ priceIds: [priceId], organizationId: ORG_A });
      const results = await Promise.all(Array.from({ length: 8 }, () => issue(id)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.number)).size).toBe(1);
      expect(new Set(results.map((r) => JSON.stringify(r.body.routing))).size).toBe(1);
      expect((await admin.query('SELECT count(*)::int AS n FROM invoice_entitlement WHERE "invoiceId" = $1', [id])).rows[0].n).toBe(1);
      expect((await issue(id)).body.routing).toEqual({ purpose: 'organization_subscription', target: 'organization' });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────── the schema on its own (DB-1 to DB-4)

  describe('the database enforces the routing on its own', () => {
    async function issuedOrdinary(): Promise<string> {
      const { priceId } = await priceFor();
      const id = await draft({ priceIds: [priceId] });
      expect((await issue(id)).status).toBe(200);
      return id;
    }
    async function draftWith(o: Parameters<typeof priceFor>[0] & { payer?: { type: string; id: string }; organizationId?: string | null } = {}) {
      const { productId, priceId } = await priceFor(o);
      return { id: await draft({ priceIds: [priceId], payer: o.payer, organizationId: o.organizationId }), productId };
    }
    const insert = (id: string, cols: Record<string, unknown>) => {
      const row = { invoiceId: id, ...cols };
      const keys = Object.keys(row);
      return admin.query(`INSERT INTO invoice_entitlement (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
    };

    it('DB-1: never updated, deleted or truncated', async () => {
      const id = await issuedOrdinary();
      await expect(admin.query(`UPDATE invoice_entitlement SET target = 'personal' WHERE "invoiceId" = $1`, [id])).rejects.toThrow(/append-only/);
      await expect(admin.query(`DELETE FROM invoice_entitlement WHERE "invoiceId" = $1`, [id])).rejects.toThrow(/append-only/);
      await expect(admin.query(`TRUNCATE invoice_entitlement`)).rejects.toThrow(/append-only|cannot truncate/);
    });

    it('DB-2: an invoice cannot leave draft for open without its record (at commit), and a record is never added after issue (no backfill)', async () => {
      const { id } = await draftWith();
      await admin.query('BEGIN');
      try {
        await admin.query(`UPDATE invoice SET status = 'open', presentation = '{"template":"system:1","locale":"fr","schemaVersion":1}'::jsonb WHERE id = $1`, [id]);
        await expect(admin.query('COMMIT')).rejects.toThrow(/without a routing record/);
      } finally {
        await admin.query('ROLLBACK').catch(() => undefined);
      }
      expect(await statusOf(id)).toBe('draft');
      const issued = await issuedOrdinary();
      await admin.query(`SET session_replication_role = replica`);
      await admin.query(`DELETE FROM invoice_entitlement WHERE "invoiceId" = $1`, [issued]); // simulate an invoice issued before S3a
      await admin.query(`SET session_replication_role = origin`);
      await expect(insert(issued, { purpose: 'non_entitlement', target: 'none', payerType: 'user', payerId: USER })).rejects.toThrow(/only when its invoice leaves draft/);
    });

    it('DB-3: only the valid purpose / target / payer / beneficiary / reference combinations; the payer is the invoice\'s', async () => {
      const personal = await draftWith({ target: 'personal' });
      const org = await draftWith({ target: 'organization', organizationId: ORG_A });
      for (const [id, cols] of [
        [personal.id, { purpose: 'direct_purchase', target: 'personal', payerType: 'user', payerId: USER, beneficiaryUserId: OTHER_USER, productId: personal.productId }], // beneficiary ≠ payer
        [personal.id, { purpose: 'direct_purchase', target: 'personal', payerType: 'user', payerId: OTHER_USER, beneficiaryUserId: OTHER_USER, productId: personal.productId }], // not the invoice's payer
        [personal.id, { purpose: 'assisted_settlement', target: 'personal', payerType: 'user', payerId: USER, beneficiaryUserId: USER, productId: personal.productId }], // not available
        [personal.id, { purpose: 'recovery_settlement', target: 'none', payerType: 'user', payerId: USER }],
        [org.id, { purpose: 'organization_subscription', target: 'organization', payerType: 'user', payerId: USER, productId: org.productId }], // no Organization
        [org.id, { purpose: 'non_entitlement', target: 'none', payerType: 'user', payerId: USER, productId: org.productId }], // a product on non_entitlement
        [org.id, { purpose: 'non_entitlement', target: 'organization', payerType: 'user', payerId: USER }],
      ] as const) {
        await expect(insert(id, cols), JSON.stringify(cols)).rejects.toThrow(/invoice_entitlement_combination|invoice_entitlement_invoice_fk/);
      }
    });

    it('DB-4: the record\'s target is its product\'s own target', async () => {
      const personal = await draftWith({ target: 'personal' });
      await expect(insert(personal.id, { purpose: 'organization_subscription', target: 'organization', payerType: 'user', payerId: USER, organizationId: ORG_A, productId: personal.productId }))
        .rejects.toThrow(/invoice_entitlement_product_fk/);
    });
  });

  // ──────────────────────────────────────────────────────────── the cross-beneficiary guard on settlement (Owner refinement 8)

  describe('settlement never reaches a Subscription it was not routed to', () => {
    const ctx: TransitionContext = { actor: { type: 'service', id: 'test-producer' }, cause: { type: 'request', id: 'r' }, correlationId: 'corr-routing' };
    const paymentCtx: TransitionContext = { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: 'e' }, correlationId: 'corr-routing' };
    async function settle(invoiceId: string) {
      const requests = t.app.get(PaymentRequestRepository);
      const open = (await svc.get(`/billing/invoices/${invoiceId}`)).body;
      const { request: pr } = await requests.createForInvoice(invoiceId, { kind: 'service', service: 'test-producer' }, ctx);
      const paymentId = crypto.randomUUID();
      await t.app.get(DbService).tx(async (q) => {
        for (const [from, to, extra] of [['created', 'sending', ''], ['sending', 'requested', `, "paymentId" = '${paymentId}'`]] as const) {
          const { rows } = await q.query(`UPDATE payment_request SET status = '${to}'${extra} WHERE id = $1 RETURNING revision`, [pr.id]);
          await recordTransition(q, { entityType: 'payment_request', entityId: pr.id, from, to, revision: rows[0].revision, ctx });
        }
      });
      return requests.applyPaymentEvent(crypto.randomUUID(), {
        name: 'payment.succeeded', source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId: pr.id, sourceType: 'invoice', sourceId: invoiceId,
        payer: open.payer, seller: open.seller, organizationId: open.organizationId, amount: Number(open.total), currency: open.currency, revision: 1,
        ...(await paymentPurposeOf(t.app.get(DbService), invoiceId)), // S4a: as Payment echoes them
      }, paymentCtx, new Date());
    }
    const subscriptionOf = (organizationId: string) => t.app.get(SubscriptionRepository).findForOrganization(organizationId);

    it('a routed organization_subscription invoice activates THAT Organization\'s Subscription', async () => {
      const org = crypto.randomUUID();
      platforms[org] = P1;
      const { priceId } = await priceFor({ target: 'organization' });
      const id = await draft({ priceIds: [priceId], organizationId: org });
      expect((await issue(id)).status).toBe(200);
      expect(await settle(id)).toMatchObject({ outcome: 'applied', subscription: 'settled' });
      expect((await subscriptionOf(org))?.status).toBe('active');
    });

    it('a personal purchase or an ordinary recurring invoice carrying an Organization never touches that Organization\'s Subscription', async () => {
      const org = crypto.randomUUID();
      platforms[org] = P1;
      const personal = await priceFor({ target: 'personal' });
      const id = await draft({ priceIds: [personal.priceId], organizationId: org });
      expect((await issue(id)).body.routing.purpose).toBe('direct_purchase');
      // S3c: a direct purchase goes to its BUYER's Personal Subscription ledger, never to the Organization on the invoice
      expect(await settle(id)).toMatchObject({ outcome: 'applied', subscription: 'purchased' });
      const ordinary = await priceFor({ recurring: true }); // a recurring product with target none (formerly: "organization + one recurring line")
      const id2 = await draft({ priceIds: [ordinary.priceId], organizationId: org });
      expect((await issue(id2)).body.routing.purpose).toBe('non_entitlement');
      expect(await settle(id2)).toMatchObject({ outcome: 'applied', subscription: null });
      expect(await subscriptionOf(org)).toBeNull();
    });

    it('an invoice issued before S3a (no routing record) is never routed after the fact: no Subscription change, flagged for review', async () => {
      const org = crypto.randomUUID();
      platforms[org] = P1;
      const { priceId } = await priceFor({ target: 'organization' });
      const id = await draft({ priceIds: [priceId], organizationId: org });
      expect((await issue(id)).status).toBe(200);
      // its payment request was made before S4a too (mapping version 1, no purpose sent): created first, then both are made historical
      const { request } = await t.app.get(PaymentRequestRepository).createForInvoice(id, { kind: 'service', service: 'test-producer' }, ctx);
      await admin.query(`SET session_replication_role = replica`);
      await admin.query(`DELETE FROM invoice_entitlement WHERE "invoiceId" = $1`, [id]); // as an invoice issued before 0019 would be
      await admin.query(`UPDATE payment_request SET "mappingVersion" = 1 WHERE id = $1`, [request.id]);
      await admin.query(`SET session_replication_role = origin`);
      expect(await settle(id)).toMatchObject({ outcome: 'applied', subscription: 'unrouted' });
      expect(await subscriptionOf(org)).toBeNull();
    });

    it('Core V2 S4a (P-2): an invoice issued before S3a (no routing record) cannot start a NEW payment request: 422 invoice_routing_invalid', async () => {
      const { priceId } = await priceFor();
      const id = await draft({ priceIds: [priceId] });
      expect((await issue(id)).status).toBe(200);
      await admin.query(`SET session_replication_role = replica`);
      await admin.query(`DELETE FROM invoice_entitlement WHERE "invoiceId" = $1`, [id]);
      await admin.query(`SET session_replication_role = origin`);
      await expect(t.app.get(PaymentRequestRepository).createForInvoice(id, { kind: 'service', service: 'test-producer' }, ctx))
        .rejects.toMatchObject({ status: 422 });
      expect(Number((await admin.query(`SELECT count(*) FROM payment_request WHERE "invoiceId" = $1`, [id])).rows[0].count)).toBe(0);
    });
  });
});
