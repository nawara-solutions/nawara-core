import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { BILLING_OPERATIONS } from '../src/admission/caller-admission.policy.js';
import { billingMigrationsDir } from '../src/app.module.js';
import { PersonalSubscriptionRepository } from '../src/subscriptions/personal-subscription.repository.js';
import { createTestApp, type TestApp } from './support/app.js';
import { anchorOccurrence } from './support/billing-calendar.js';
import { describeWithEnv } from './support/env.js';
import { personalPrice, settle, subscriptionPrice, SUBSCRIPTION_PLATFORM } from './support/settlement.js';

const OTHER_PLATFORM = '88888888-8888-4888-8888-888888888888';
const day = 86_400_000;

/**
 * Core V2 S3c (ADR-0044 B4, B5, B6; S0 §1.1, K-3 Option D, DB-9, DB-10, DB-12; register BIL-11): Personal Subscriptions owned by the
 * named user, per user + Platform + product, valid only through an append-only ledger of purchases each backed by Payment's verified
 * settlement; K-3 Option D re-lay; the B6 entitlement read. Real PostgreSQL, the real settlement path.
 */
describeWithEnv('personal subscriptions (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let personal: PersonalSubscriptionRepository;
  const producer = generateServiceToken();
  const outsider = generateServiceToken();

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingpersonal');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [{ caller: 'test-producer', digest: producer.digest }, { caller: 'outsider', digest: outsider.digest }],
      env: {
        BILLING_SERVICE_POLICY: JSON.stringify({
          callers: {
            'test-producer': { operations: [...BILLING_OPERATIONS], allowedPlatforms: [SUBSCRIPTION_PLATFORM, OTHER_PLATFORM] },
            outsider: { operations: [...BILLING_OPERATIONS], allowedPlatforms: [OTHER_PLATFORM] },
          },
        }),
      },
    });
    personal = t.app.get(PersonalSubscriptionRepository);
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  const user = () => `user-${crypto.randomUUID()}`;
  const buy = (userId: string, priceId: string, at: Date, o: { platformId?: string; organizationId?: string | null } = {}) =>
    settle(t.app, { organizationId: o.organizationId ?? null, priceId, at, payer: { type: 'user', id: userId }, platformId: o.platformId });
  const ledger = (userId: string) =>
    admin.query(`SELECT sp.* FROM subscription_purchase sp WHERE sp."beneficiaryUserId" = $1 ORDER BY sp."ledgerSeq"`, [userId]).then((r) => r.rows);
  const subscriptionOf = async (userId: string, productId: string) =>
    (await admin.query(`SELECT * FROM personal_subscription WHERE "userId" = $1 AND "productId" = $2`, [userId, productId])).rows[0] as { id: string; platformId: string } | undefined;
  const spans = async (userId: string, productId: string) => personal.spans((await subscriptionOf(userId, productId))!.id);
  const read = (userId: string, platformId: string, productId: string, token = producer.token) =>
    request(t.app.getHttpServer()).get(`/billing/users/${encodeURIComponent(userId)}/platforms/${platformId}/products/${productId}/entitlement`).set('authorization', `Bearer ${token}`);

  // ─────────────────────────────────────────────────────────────────────────────────────────────── purchase and renewal (B4)

  describe('purchase and renewal', () => {
    it('a verified direct purchase activates the BUYER\'s Personal Subscription on the product\'s own Platform, with its evidence', async () => {
      const u = user();
      const { productId, priceId } = await personalPrice(admin);
      const at = new Date(Date.now() - day);
      const r = await buy(u, priceId, at);
      expect(r.application).toMatchObject({ outcome: 'applied', subscription: 'purchased' });
      expect(await subscriptionOf(u, productId)).toMatchObject({ platformId: SUBSCRIPTION_PLATFORM });
      const [p] = await ledger(u);
      expect(p).toMatchObject({ invoiceId: r.invoiceId, purpose: 'direct_purchase', beneficiaryUserId: u, productId, priceId, settledAt: at, originalStart: at, originalEnd: anchorOccurrence(at, 1) });
      const receipt = (await admin.query(`SELECT "eventName", outcome FROM payment_event_receipt WHERE id = $1`, [p.receiptId])).rows[0];
      expect(receipt).toEqual({ eventName: 'payment.succeeded', outcome: 'applied' });
      const res = await read(u, SUBSCRIPTION_PLATFORM, productId).expect(200);
      expect(res.body).toEqual({ valid: true, expiresAt: anchorOccurrence(at, 1).toISOString() });
    });

    it('a renewal while valid continues from the current end (no lost time, the anchor kept); after a lapse it starts at its settlement', async () => {
      const u = user();
      const { productId, priceId } = await personalPrice(admin);
      const a = new Date('2031-01-31T09:30:00Z');
      await buy(u, priceId, a);
      await buy(u, priceId, new Date('2031-02-10T09:30:00Z')); // early: continues at Feb 28 (clamped) and keeps the Jan 31 anchor
      await buy(u, priceId, new Date('2031-06-15T09:30:00Z')); // after the lapse (Mar 31): a new chain from Jun 15
      expect((await spans(u, productId)).map((s) => [s.effectiveStart.toISOString().slice(0, 10), s.effectiveEnd.toISOString().slice(0, 10)])).toEqual([
        ['2031-01-31', '2031-02-28'], ['2031-02-28', '2031-03-31'], ['2031-06-15', '2031-07-15'],
      ]);
      expect((await ledger(u)).map((p) => p.originalStart.toISOString().slice(0, 10))).toEqual(['2031-01-31', '2031-02-28', '2031-06-15']);
    });

    it('subscriptions coexist per user + Platform + product: another product, another user and another Platform are independent', async () => {
      const u = user();
      const v = user();
      const p1 = await personalPrice(admin);
      const p2 = await personalPrice(admin); // a second personal product of the same Platform (no universal plan)
      const p3 = await personalPrice(admin, { platformId: OTHER_PLATFORM });
      const at = new Date(Date.now() - day);
      await buy(u, p1.priceId, at);
      await buy(u, p3.priceId, at, { platformId: OTHER_PLATFORM });
      expect((await read(u, SUBSCRIPTION_PLATFORM, p1.productId)).body.valid).toBe(true);
      expect((await read(u, SUBSCRIPTION_PLATFORM, p2.productId)).body).toEqual({ valid: false, expiresAt: null });
      expect((await read(v, SUBSCRIPTION_PLATFORM, p1.productId)).body).toEqual({ valid: false, expiresAt: null });
      expect((await read(u, OTHER_PLATFORM, p3.productId)).body.valid).toBe(true);
      expect((await admin.query(`SELECT count(*)::int AS n FROM personal_subscription WHERE "userId" = $1`, [u])).rows[0].n).toBe(2);
    });

    it('an Organization subscription invoice never creates a Personal Subscription, and a personal purchase never touches an Organization\'s', async () => {
      const org = crypto.randomUUID();
      const orgPrice = await subscriptionPrice(admin);
      const r = await settle(t.app, { organizationId: org, priceId: orgPrice.priceId, at: new Date(Date.now() - day) });
      expect(r.application.subscription).toBe('settled');
      expect((await admin.query(`SELECT count(*)::int AS n FROM personal_subscription WHERE "productId" = $1`, [orgPrice.productId])).rows[0].n).toBe(0);
      const u = user();
      const p = await personalPrice(admin);
      const r2 = await buy(u, p.priceId, new Date(Date.now() - day), { organizationId: org });
      expect(r2.application.subscription).toBe('purchased');
      expect((await admin.query(`SELECT "productId" FROM subscription WHERE "organizationId" = $1`, [org])).rows).toEqual([{ productId: orgPrice.productId }]);
    });

    it('an ordinary (non_entitlement) paid invoice is inert: no Personal Subscription, no purchase', async () => {
      const u = user();
      const productId = (await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name) VALUES ('test-producer', 'company', 'nawara-test-seller', $1, 'Ordinary') RETURNING id`, [`o-${crypto.randomUUID().slice(0, 8)}`])).rows[0].id;
      const priceId = (await admin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, 'o', 'TND', 500, 'recurring', 'month', 1) RETURNING id`, [productId])).rows[0].id;
      const r = await buy(u, priceId, new Date());
      expect(r.application.subscription).toBeNull();
      expect(await ledger(u)).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────── evidence, replay, concurrency, rollback

  describe('settlement evidence', () => {
    it('a purchase replayed for the SAME invoice (or receipt) appends nothing; the entitlement is unchanged', async () => {
      const u = user();
      const { productId, priceId } = await personalPrice(admin);
      const r = await buy(u, priceId, new Date(Date.now() - day));
      const [p] = await ledger(u);
      const before = (await read(u, SUBSCRIPTION_PLATFORM, productId)).body;
      const again = await t.app.get(DbService).tx((q) => personal.recordPurchase(q, {
        userId: u, productId, priceId, invoiceId: r.invoiceId, paymentRequestId: p.paymentRequestId, receiptId: p.receiptId, settledAt: new Date(),
      }));
      expect(again.recorded).toBe(false);
      expect(await ledger(u)).toHaveLength(1);
      expect((await read(u, SUBSCRIPTION_PLATFORM, productId)).body).toEqual(before);
    });

    it('concurrent purchases of one user\'s product are laid one after the other: contiguous periods, none lost, none overlapping', async () => {
      const u = user();
      const { productId, priceId } = await personalPrice(admin);
      const at = new Date('2032-03-01T00:00:00Z');
      await Promise.all(Array.from({ length: 6 }, () => buy(u, priceId, at)));
      const s = await spans(u, productId);
      expect(s).toHaveLength(6);
      for (let i = 1; i < s.length; i++) expect(s[i]!.effectiveStart).toEqual(s[i - 1]!.effectiveEnd);
      expect(s[5]!.effectiveEnd).toEqual(new Date('2032-09-01T00:00:00Z'));
    });

    it('rollback: a purchase that cannot be recorded takes the whole settlement with it (the invoice stays open, nothing is granted)', async () => {
      const u = user();
      const { productId, priceId } = await personalPrice(admin);
      await admin.query(`CREATE OR REPLACE FUNCTION s3c_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'purchase refused (test)'; END $$;
                         CREATE TRIGGER s3c_refuse BEFORE INSERT ON subscription_purchase FOR EACH ROW WHEN (NEW."beneficiaryUserId" = '${u}') EXECUTE FUNCTION s3c_refuse()`);
      try {
        await expect(buy(u, priceId, new Date())).rejects.toThrow('purchase refused (test)');
      } finally {
        await admin.query('DROP TRIGGER IF EXISTS s3c_refuse ON subscription_purchase');
      }
      expect(await ledger(u)).toEqual([]);
      expect((await read(u, SUBSCRIPTION_PLATFORM, productId)).body).toEqual({ valid: false, expiresAt: null });
      const statuses = (await admin.query(`SELECT i.status FROM invoice i WHERE i."payerId" = $1`, [u])).rows.map((r) => r.status);
      expect(statuses).toEqual(['open']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── K-3 Option D (B5)

  describe('K-3 Option D re-lay', () => {
    async function chain(n: number, first = new Date('2033-01-10T00:00:00Z')) {
      const u = user();
      const { productId, priceId } = await personalPrice(admin);
      for (let i = 0; i < n; i++) await buy(u, priceId, new Date(first.getTime() + i * day));
      return { u, productId, purchases: await ledger(u) };
    }
    const reverse = (purchaseId: string, cause: 'refund_completion' | 'final_lost_chargeback' = 'refund_completion') =>
      t.app.get(DbService).tx((q) => personal.reversePurchase(q, purchaseId, cause));
    const ymd = (s: Array<{ effectiveStart: Date; effectiveEnd: Date }>) => s.map((x) => `${x.effectiveStart.toISOString().slice(0, 10)}..${x.effectiveEnd.toISOString().slice(0, 10)}`);

    it('reversing a middle purchase removes its span and re-lays the later ones with their full duration and no gap', async () => {
      const { u, productId, purchases } = await chain(3); // Jan 10..Feb 10, Feb 10..Mar 10, Mar 10..Apr 10
      expect(ymd(await spans(u, productId))).toEqual(['2033-01-10..2033-02-10', '2033-02-10..2033-03-10', '2033-03-10..2033-04-10']);
      expect(await reverse(purchases[1].id)).toEqual({ reversed: true });
      expect(ymd(await spans(u, productId))).toEqual(['2033-01-10..2033-02-10', '2033-02-10..2033-03-10']); // the third moved into the gap
      expect((await spans(u, productId)).map((s) => s.purchaseId)).toEqual([purchases[0].id, purchases[2].id]);
    });

    it('at most one reversal per purchase: a second cause changes nothing', async () => {
      const { u, productId, purchases } = await chain(2);
      await reverse(purchases[0].id, 'refund_completion');
      const after = ymd(await spans(u, productId));
      expect(await reverse(purchases[0].id, 'final_lost_chargeback')).toEqual({ reversed: false });
      expect(ymd(await spans(u, productId))).toEqual(after);
      expect((await admin.query(`SELECT cause FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [purchases[0].id])).rows).toEqual([{ cause: 'refund_completion' }]);
    });

    it('a re-laid period never starts before its own settlement, and a later period that already stood apart keeps its place', async () => {
      const u = user();
      const { productId, priceId } = await personalPrice(admin);
      await buy(u, priceId, new Date('2034-01-01T00:00:00Z')); // A: Jan 1..Feb 1
      await buy(u, priceId, new Date('2034-01-20T00:00:00Z')); // B: bought during A, laid Feb 1..Mar 1
      await buy(u, priceId, new Date('2034-05-10T00:00:00Z')); // C: after a lapse, May 10..Jun 10
      const [a] = await ledger(u);
      await reverse(a.id, 'final_lost_chargeback');
      expect(ymd(await spans(u, productId))).toEqual(['2034-01-20..2034-02-20', '2034-05-10..2034-06-10']);
    });

    it('property: for random ledgers and reversals, kept periods never overlap, keep their order and full duration, and never start before their settlement', async () => {
      let seed = 42;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      for (let run = 0; run < 8; run++) {
        const u = user();
        const { productId, priceId } = await personalPrice(admin, { intervalUnit: run % 2 ? 'month' : 'day', intervalCount: run % 2 ? 1 : 10 });
        let at = new Date('2035-01-01T00:00:00Z').getTime();
        const n = 3 + Math.floor(rand() * 5);
        for (let i = 0; i < n; i++) {
          at += Math.floor(rand() * 40) * day;
          await buy(u, priceId, new Date(at));
        }
        const purchases = await ledger(u);
        for (const p of purchases) if (rand() < 0.35) await reverse(p.id);
        const reversed = new Set((await admin.query(`SELECT "purchaseId" FROM subscription_purchase_reversal`)).rows.map((r) => r.purchaseId as string));
        const kept = purchases.filter((p) => !reversed.has(p.id));
        const s = await spans(u, productId);
        expect(s.map((x) => x.purchaseId)).toEqual(kept.map((p) => p.id)); // ledger order, reversed ones removed
        for (const [i, x] of s.entries()) {
          const p = kept[i]!;
          expect(x.effectiveStart.getTime()).toBeGreaterThanOrEqual(new Date(p.settledAt).getTime()); // never before it was paid
          expect(x.effectiveEnd.getTime()).toBeGreaterThan(x.effectiveStart.getTime());
          if (i > 0) {
            const prev = s[i - 1]!;
            expect(x.effectiveStart.getTime()).toBeGreaterThanOrEqual(prev.effectiveEnd.getTime()); // no overlap
            // no gap where a gap is not owed: a period paid during the previous one starts exactly at its end
            if (new Date(p.settledAt).getTime() <= prev.effectiveEnd.getTime()) expect(x.effectiveStart).toEqual(prev.effectiveEnd);
            else expect(x.effectiveStart).toEqual(new Date(p.settledAt));
          }
        }
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────── the database on its own

  describe('the database enforces the ledger on its own (DB-9, DB-10, DB-12)', () => {
    async function refused(text: string, params: unknown[]): Promise<string> {
      try {
        await admin.query(text, params);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error(`accepted: ${text}`);
    }
    const insert = (cols: Record<string, unknown>) => {
      const keys = Object.keys(cols);
      return refused(`INSERT INTO subscription_purchase (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(cols));
    };

    it('DB-9 / DB-10: only its own routing record\'s beneficiary and product, with verified evidence, once per invoice and receipt', async () => {
      const u = user();
      const { productId, priceId } = await personalPrice(admin);
      await buy(u, priceId, new Date(Date.now() - day));
      const [p] = await ledger(u);
      const base = {
        personalSubscriptionId: p.personalSubscriptionId, invoiceId: p.invoiceId, purpose: 'direct_purchase', beneficiaryUserId: u, productId, priceId,
        paymentRequestId: p.paymentRequestId, receiptId: p.receiptId, settledAt: new Date(), originalStart: new Date(), originalEnd: new Date(Date.now() + day), transactionId: '1',
      };
      expect(await insert(base)).toMatch(/subscription_purchase_invoice_unique|subscription_purchase_receipt_unique/); // DB-10
      expect(await insert({ ...base, purpose: 'organization_subscription' })).toMatch(/subscription_purchase_purpose/); // DB-9 same-row
      expect(await insert({ ...base, purpose: 'assisted_settlement' })).toMatch(/subscription_purchase_purpose/); // S5a: not yet
      // another buyer's settled invoice claimed for this user (who also owns that product): the invoice is routed to its own buyer
      const other = user();
      const v = await personalPrice(admin);
      await buy(u, v.priceId, new Date(Date.now() - day));
      const r = await buy(other, v.priceId, new Date(Date.now() - day));
      const [q] = await ledger(other);
      const victimSub = (await subscriptionOf(u, v.productId))!.id;
      expect(await insert({ ...base, personalSubscriptionId: victimSub, productId: v.productId, priceId: v.priceId, invoiceId: r.invoiceId, paymentRequestId: q.paymentRequestId, receiptId: q.receiptId }))
        .toMatch(/subscription_purchase_invoice_unique|subscription_purchase_routing_fk/);
      expect((await ledger(u)).map((x) => x.invoiceId)).not.toContain(r.invoiceId);
    });

    it('the original span is laid by the database (a caller value is replaced); purchases and reversals are append-only', async () => {
      const u = user();
      const { productId, priceId } = await personalPrice(admin);
      const at = new Date('2036-04-01T00:00:00Z');
      await buy(u, priceId, at);
      const [p] = await ledger(u);
      expect([p.originalStart, p.originalEnd]).toEqual([at, new Date('2036-05-01T00:00:00Z')]); // the repository sends placeholders
      expect(await refused(`UPDATE subscription_purchase SET "originalEnd" = "originalEnd" + interval '1 year' WHERE id = $1`, [p.id])).toMatch(/append-only/);
      expect(await refused(`DELETE FROM subscription_purchase WHERE id = $1`, [p.id])).toMatch(/append-only/);
      await t.app.get(DbService).tx((q) => personal.reversePurchase(q, p.id, 'refund_completion'));
      expect(await refused(`DELETE FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [p.id])).toMatch(/append-only/);
      expect(await refused(`UPDATE personal_subscription SET "userId" = 'someone-else' WHERE "productId" = $1`, [productId])).toMatch(/append-only/);
    });

    it('a Personal Subscription only for a personal product of its own Platform; DB-12: one purchase per assistance request (none yet)', async () => {
      const orgPrice = await subscriptionPrice(admin);
      expect(await refused(`INSERT INTO personal_subscription ("userId", "platformId", "productId") VALUES ('u', $1, $2)`, [SUBSCRIPTION_PLATFORM, orgPrice.productId])).toMatch(/personal_subscription_product_fk/);
      const p = await personalPrice(admin);
      expect(await refused(`INSERT INTO personal_subscription ("userId", "platformId", "productId") VALUES ('u', $1, $2)`, [OTHER_PLATFORM, p.productId])).toMatch(/personal_subscription_product_fk/);
      const idx = (await admin.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'subscription_purchase_assistance_unique'`)).rows[0].indexdef as string;
      expect(idx).toMatch(/UNIQUE INDEX .* \("assistanceRequestId"\) WHERE \("assistanceRequestId" IS NOT NULL\)/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────── the B6 read: authorization

  describe('the entitlement read (B6)', () => {
    it('service token only, the caller\'s own Platform, a personal product of that Platform; the shape is exactly {valid, expiresAt}', async () => {
      const u = user();
      const { productId, priceId } = await personalPrice(admin);
      await buy(u, priceId, new Date(Date.now() - day));
      await request(t.app.getHttpServer()).get(`/billing/users/${u}/platforms/${SUBSCRIPTION_PLATFORM}/products/${productId}/entitlement`).expect(401);
      expect((await read(u, SUBSCRIPTION_PLATFORM, productId, outsider.token)).body.code).toBe('platform_not_permitted');
      expect((await read(u, OTHER_PLATFORM, productId)).status).toBe(404); // not a product of that Platform
      const orgPrice = await subscriptionPrice(admin);
      expect((await read(u, SUBSCRIPTION_PLATFORM, orgPrice.productId)).status).toBe(404); // not a personal product
      const res = await read(u, SUBSCRIPTION_PLATFORM, productId).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'valid']);
      expect(res.headers['cache-control'] ?? '').not.toMatch(/public/);
    });

    it('no grace: the moment the last kept period ends the answer is not entitled', async () => {
      const u = user();
      const { productId, priceId } = await personalPrice(admin, { intervalUnit: 'day', intervalCount: 1 });
      await buy(u, priceId, new Date(Date.now() - day - 60_000)); // ended a minute ago
      expect((await read(u, SUBSCRIPTION_PLATFORM, productId)).body).toEqual({ valid: false, expiresAt: null });
    });
  });
});
