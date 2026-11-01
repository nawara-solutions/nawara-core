import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { BILLING_OPERATIONS } from '../src/admission/caller-admission.policy.js';
import { billingMigrationsDir } from '../src/app.module.js';
import { decodeCursor, encodeCursor } from '../src/common/pagination.js';
import type { BillingConfig } from '../src/config/billing-config.js';
import { MemberPersonalSubscriptionsModule } from '../src/subscriptions/member-personal-subscriptions.module.js';
import { MemberPersonalSubscriptionsService } from '../src/subscriptions/member-personal-subscriptions.service.js';
import { PersonalSubscriptionRepository } from '../src/subscriptions/personal-subscription.repository.js';
import { createTestApp, type TestApp } from './support/app.js';
import { anchorOccurrence } from './support/billing-calendar.js';
import { describeWithEnv } from './support/env.js';
import { expectHttpMemberReadMatchesB6, expectMemberReadMatchesB6, memberReadAt } from './support/member-read.js';
import { configurePlatform, personalPrice, settle, subscriptionPrice, SUBSCRIPTION_PLATFORM } from './support/settlement.js';

const OTHER_PLATFORM = '77777777-7777-4777-8777-777777777777';
const UNCONFIGURED_PLATFORM = '66666666-6666-4666-8666-666666666666';
const day = 86_400_000;
const PATH = (platformId: string) => `/billing/me/platforms/${platformId}/personal-subscriptions`;

/**
 * Core V2 BIL-12 (register BIL-12; the Owner's D-B1 to D-B7, 2026-11-01): the member's own Personal Subscriptions on one Platform, for
 * DEVELOPMENT AND SIMULATION ONLY. The real application on real PostgreSQL, Auth's `/auth/me` stubbed per bearer (asked on every
 * request), purchases laid only through the real settlement path, reversals through the ledger's one writer. Every answer is checked
 * against B6 at the same instant (`support/member-read.ts`). The S6 flows (refunds, chargebacks, disputes, fraud holds), assisted purchases
 * and late settlements check the same parity in their own suites.
 */
describeWithEnv('the member\'s own personal subscriptions (BIL-12, simulation) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let personal: PersonalSubscriptionRepository;
  const producer = generateServiceToken();
  const members = new Map<string, string>(); // bearer -> user id
  const identities = new Map<string, AuthIdentity>();
  const meCalls: string[] = [];
  const authClient: AuthClient = {
    getIdentity: async (bearer) => {
      meCalls.push(bearer);
      if (bearer === 'auth-down') throw new ServiceUnavailableException();
      return identities.get(bearer) ?? null;
    },
    hasPlatformAccess: async () => false,
  };
  const member = (name: string) => {
    const id = randomUUID();
    members.set(name, id);
    identities.set(name, { id, adminTier: null, isActive: true, memberships: [] }); // no membership anywhere (D-B4)
    return id;
  };
  const read = (bearer: string | null, platformId = SUBSCRIPTION_PLATFORM, query = '') => {
    const r = request(t.app.getHttpServer()).get(`${PATH(platformId)}${query}`);
    return bearer === null ? r : r.set('authorization', `Bearer ${bearer}`);
  };
  const buy = (userId: string, priceId: string, at: Date, platformId?: string) =>
    settle(t.app, { organizationId: null, priceId, at, payer: { type: 'user', id: userId }, platformId });
  const subscriptionId = async (userId: string, productId: string) =>
    (await admin.query(`SELECT id FROM personal_subscription WHERE "userId" = $1 AND "productId" = $2`, [userId, productId])).rows[0].id as string;
  const page = (userId: string, platformId: string, at: Date, limit = 100, cursor: { createdAt: Date; id: string } | null = null) =>
    t.app.get(MemberPersonalSubscriptionsService).page(userId, platformId, limit, cursor, at);

  /**
   * Every table's full contents, hashed: a read must leave all of them, the audit tables included, exactly as they were. The outbox is
   * hashed on its immutable event content only (`id`, `name`, `payload`, `correlationId`, `eventVersion`, `occurredAt`), so an event
   * added, deleted or changed is caught, while the relay publishing the earlier purchase's events meanwhile (`publishedAt`, `attempts`,
   * `lastError`, `availableAt`, its delivery fields) is not mistaken for a write by the read.
   */
  const OUTBOX_EVENT_CONTENT = `SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x::text), '')) AS h
    FROM (SELECT id, name, payload, "correlationId", "eventVersion", "occurredAt" FROM outbox) x`;
  const fingerprint = async () => {
    const { rows } = await admin.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`);
    const out: Record<string, string> = {};
    for (const { t: table } of rows) {
      const sql = table === 'outbox' ? OUTBOX_EVENT_CONTENT : `SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x::text), '')) AS h FROM "${table}" x`;
      out[table] = (await admin.query(sql)).rows[0].h;
    }
    return out;
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingmemberread');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    identities.set('owner-1', { id: randomUUID(), adminTier: 'owner', isActive: true, memberships: [] });
    identities.set('operator-1', { id: randomUUID(), adminTier: 'operator', isActive: true, memberships: [] });
    identities.set('inactive-1', { id: randomUUID(), adminTier: null, isActive: false, memberships: [] });
    identities.set('inactive-owner', { id: randomUUID(), adminTier: 'owner', isActive: false, memberships: [] });
    t = await createTestApp({
      databaseUrl: db.url, authClient,
      tokens: [{ caller: 'test-producer', digest: producer.digest }],
      env: { BILLING_SERVICE_POLICY: JSON.stringify({ callers: { 'test-producer': { operations: [...BILLING_OPERATIONS], allowedPlatforms: [SUBSCRIPTION_PLATFORM, OTHER_PLATFORM] } } }) },
    });
    personal = t.app.get(PersonalSubscriptionRepository);
    await configurePlatform(admin, SUBSCRIPTION_PLATFORM);
    await configurePlatform(admin, OTHER_PLATFORM);
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });
  beforeEach(() => { meCalls.length = 0; });

  // ─────────────────────────────────────────────────────────────────────────────────────────── the caller (D-B4)

  describe('the caller: the member\'s own bearer, verified live (D-B4)', () => {
    it('no, a malformed, an unknown or a revoked bearer is 401; a service token is 401 and never reaches Auth', async () => {
      expect((await read(null)).status).toBe(401);
      expect((await request(t.app.getHttpServer()).get(PATH(SUBSCRIPTION_PLATFORM)).set('authorization', 'Basic abc')).status).toBe(401);
      expect((await request(t.app.getHttpServer()).get(PATH(SUBSCRIPTION_PLATFORM)).set('authorization', 'Bearer ')).status).toBe(401);
      expect((await request(t.app.getHttpServer()).get(PATH(SUBSCRIPTION_PLATFORM)).set('authorization', 'Bearer a b')).status).toBe(401);
      expect(meCalls).toEqual([]); // nothing worth asking Auth about
      expect((await read('nobody')).status).toBe(401);
      member('revoked');
      expect((await read('revoked')).status).toBe(200);
      identities.delete('revoked'); // Auth revokes it: the very next request knows
      expect((await read('revoked')).status).toBe(401);
      meCalls.length = 0;
      expect((await read(producer.token)).status).toBe(401);
      expect(meCalls).toEqual([]); // a service credential is never forwarded to Auth
    });

    it('an inactive user, an Owner or an Operator is 403 member_not_eligible; no membership is needed to be a member', async () => {
      for (const bearer of ['inactive-1', 'owner-1', 'operator-1', 'inactive-owner']) {
        const r = await read(bearer);
        expect([r.status, r.body.code], bearer).toEqual([403, 'member_not_eligible']);
      }
      member('loner'); // no Organization, no Platform
      expect((await read('loner')).body).toEqual({ items: [], nextCursor: null });
    });

    it('Auth unavailable is 503 and nothing is read; Auth is asked on every request (no cached identity)', async () => {
      expect((await read('auth-down')).status).toBe(503);
      const u = member('live');
      const { priceId } = await personalPrice(admin);
      await buy(u, priceId, new Date(Date.now() - day));
      meCalls.length = 0;
      for (let i = 0; i < 3; i++) expect((await read('live')).status).toBe(200);
      expect(meCalls).toEqual(['live', 'live', 'live']);
    });

    it('the user is only Auth\'s answer: a query, a header or a cursor naming another user changes nothing', async () => {
      const mine = member('self');
      const other = member('other');
      const a = await personalPrice(admin);
      const b = await personalPrice(admin);
      await buy(mine, a.priceId, new Date(Date.now() - day));
      await buy(other, b.priceId, new Date(Date.now() - day));
      const own = [{ productId: a.productId, valid: true, expiresAt: expect.any(String) }];
      expect((await read('self', SUBSCRIPTION_PLATFORM, `?userId=${other}&beneficiaryUserId=${other}`)).body.items).toEqual(own);
      expect((await read('self').set('x-user-id', other).set('x-organization-id', randomUUID())).body.items).toEqual(own);
      const theirs = encodeCursor({ createdAt: new Date(Date.now() + day), id: await subscriptionId(other, b.productId) });
      expect((await read('self', SUBSCRIPTION_PLATFORM, `?cursor=${theirs}`)).body.items).toEqual(own); // positions within MY rows only
    });

    it('production mounts no route (DG-4); B6 is not part of this module and is unaffected', () => {
      expect(MemberPersonalSubscriptionsModule.register({ isProduction: true } as BillingConfig)).toEqual({ module: MemberPersonalSubscriptionsModule });
      const dev = MemberPersonalSubscriptionsModule.register({ isProduction: false } as BillingConfig);
      expect(dev.controllers?.map((c) => (c as { name: string }).name)).toEqual(['MemberPersonalSubscriptionsController']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────── isolation (D-B5)

  describe('isolation and what is listed (D-B5)', () => {
    it('only the caller\'s own subscriptions on the path\'s Platform: not another member\'s, not another Platform\'s', async () => {
      const u = member('iso-1');
      const v = member('iso-2');
      const here = await personalPrice(admin);
      const there = await personalPrice(admin, { platformId: OTHER_PLATFORM });
      await buy(u, here.priceId, new Date(Date.now() - day));
      await buy(v, here.priceId, new Date(Date.now() - day)); // the same product, another member
      await buy(u, there.priceId, new Date(Date.now() - day), OTHER_PLATFORM);
      expect((await expectHttpMemberReadMatchesB6(t.app, 'iso-1', u, SUBSCRIPTION_PLATFORM)).map((i) => i.productId)).toEqual([here.productId]);
      expect((await expectHttpMemberReadMatchesB6(t.app, 'iso-1', u, OTHER_PLATFORM)).map((i) => i.productId)).toEqual([there.productId]);
      expect((await expectHttpMemberReadMatchesB6(t.app, 'iso-2', v, SUBSCRIPTION_PLATFORM)).map((i) => i.productId)).toEqual([here.productId]);
      expect((await read('iso-2', OTHER_PLATFORM)).body).toEqual({ items: [], nextCursor: null });
    });

    it('an unknown or an unconfigured Platform is the caller\'s empty result; a Platform id that is not a UUID is 400', async () => {
      member('iso-3');
      expect((await read('iso-3', UNCONFIGURED_PLATFORM)).body).toEqual({ items: [], nextCursor: null });
      expect((await read('iso-3', randomUUID())).body).toEqual({ items: [], nextCursor: null });
      expect((await read('iso-3', 'not-a-uuid')).status).toBe(400);
    });

    it('Organization Subscriptions and non-personal products are never listed', async () => {
      const u = member('iso-4');
      const org = randomUUID();
      const orgPrice = await subscriptionPrice(admin);
      const paid = await settle(t.app, { organizationId: org, priceId: orgPrice.priceId, at: new Date(Date.now() - day), payer: { type: 'user', id: u } });
      expect((await admin.query(`SELECT status FROM invoice WHERE id = $1`, [paid.invoiceId])).rows).toEqual([{ status: 'paid' }]); // paid by this very user
      expect((await read('iso-4')).body).toEqual({ items: [], nextCursor: null });
      expect((await admin.query(`SELECT count(*)::int AS n FROM personal_subscription WHERE "userId" = $1`, [u])).rows[0].n).toBe(0);
    });

    it('the shape is exactly {items: [{productId, valid, expiresAt}], nextCursor}, never cached; nothing financial leaves', async () => {
      const u = member('shape');
      const { productId, priceId } = await personalPrice(admin);
      await buy(u, priceId, new Date(Date.now() - day));
      const r = await read('shape').expect(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(Object.keys(r.body).sort()).toEqual(['items', 'nextCursor']);
      expect(r.body.items.map((i: object) => Object.keys(i).sort())).toEqual([['expiresAt', 'productId', 'valid']]);
      expect(r.body.items[0]).toMatchObject({ productId, valid: true });
      expect(JSON.stringify(r.body)).not.toMatch(/amount|price|purchase|invoice|payment|hold|reason|organization/i);
    });
  });

  // ────────────────────────────────────────────────────────────────────── validity, exactly as B6 (D-B3, part G)

  describe('validity is B6\'s, at one instant (D-B3)', () => {
    it('active, stacked and expired subscriptions, each equal to B6; an expired one is valid: false, expiresAt: null', async () => {
      const u = member('states');
      const active = await personalPrice(admin);
      const stacked = await personalPrice(admin);
      const expired = await personalPrice(admin, { intervalUnit: 'day', intervalCount: 1 });
      const anchor = new Date(Date.now() - day);
      await buy(u, active.priceId, anchor);
      await buy(u, stacked.priceId, anchor);
      await buy(u, stacked.priceId, new Date(anchor.getTime() + 1000)); // bought again while running: stacks at the end, anchor kept
      await buy(u, expired.priceId, new Date(Date.now() - 3 * day));
      const at = new Date();
      const items = await expectMemberReadMatchesB6(t.app, u, SUBSCRIPTION_PLATFORM, at);
      const of = (productId: string) => items.find((i) => i.productId === productId);
      expect(of(active.productId)).toEqual({ productId: active.productId, valid: true, expiresAt: anchorOccurrence(anchor, 1).toISOString() });
      expect(of(stacked.productId)).toEqual({ productId: stacked.productId, valid: true, expiresAt: anchorOccurrence(anchor, 2).toISOString() });
      expect(of(expired.productId)).toEqual({ productId: expired.productId, valid: false, expiresAt: null });
      await expectHttpMemberReadMatchesB6(t.app, 'states', u, SUBSCRIPTION_PLATFORM);
    });

    it('the monthly calendar and no grace: valid until the last millisecond, then valid: false at the exclusive end (Jan 31 -> Feb 28 -> Mar 31)', async () => {
      const u = member('calendar');
      const { productId, priceId } = await personalPrice(admin);
      const anchor = new Date('2031-01-31T10:00:00.000Z');
      await buy(u, priceId, anchor);
      const feb28 = new Date('2031-02-28T10:00:00.000Z');
      for (const at of [new Date('2031-02-15T00:00:00Z'), new Date(feb28.getTime() - 1)]) {
        expect(await expectMemberReadMatchesB6(t.app, u, SUBSCRIPTION_PLATFORM, at)).toEqual([{ productId, valid: true, expiresAt: feb28.toISOString() }]);
      }
      expect(await expectMemberReadMatchesB6(t.app, u, SUBSCRIPTION_PLATFORM, feb28)).toEqual([{ productId, valid: false, expiresAt: null }]); // no grace
      await buy(u, priceId, new Date('2031-02-20T00:00:00Z')); // a renewal inside the run: continues at Feb 28, the anchor's day recovered
      expect(await expectMemberReadMatchesB6(t.app, u, SUBSCRIPTION_PLATFORM, feb28)).toEqual([{ productId, valid: true, expiresAt: '2031-03-31T10:00:00.000Z' }]);
      expect(await expectMemberReadMatchesB6(t.app, u, SUBSCRIPTION_PLATFORM, new Date('2031-03-31T10:00:00.000Z'))).toEqual([{ productId, valid: false, expiresAt: null }]);
    });

    it('reversed purchases (a completed refund, a direct final-lost chargeback) are re-laid as B6 re-lays them; a fully reversed subscription stays listed, invalid', async () => {
      const u = member('reversed');
      const refunded = await personalPrice(admin);
      const chargedBack = await personalPrice(admin);
      const anchor = new Date(Date.now() - day);
      await buy(u, refunded.priceId, anchor);
      await buy(u, chargedBack.priceId, anchor);
      await buy(u, chargedBack.priceId, new Date(anchor.getTime() + 1000));
      const purchases = async (productId: string) => (await admin.query(
        `SELECT sp.id FROM subscription_purchase sp JOIN personal_subscription ps ON ps.id = sp."personalSubscriptionId" WHERE ps."userId" = $1 AND ps."productId" = $2 ORDER BY sp."ledgerSeq"`,
        [u, productId])).rows.map((r) => r.id as string);
      const reverse = (purchaseId: string, cause: 'refund_completion' | 'final_lost_chargeback') => t.app.get(DbService).tx((q) => personal.reversePurchase(q, purchaseId, cause));
      expect(await reverse((await purchases(refunded.productId))[0]!, 'refund_completion')).toEqual({ reversed: true });
      expect(await reverse((await purchases(chargedBack.productId))[0]!, 'final_lost_chargeback')).toEqual({ reversed: true });
      const items = await expectMemberReadMatchesB6(t.app, u, SUBSCRIPTION_PLATFORM);
      expect(items.find((i) => i.productId === refunded.productId)).toEqual({ productId: refunded.productId, valid: false, expiresAt: null });
      expect(items.find((i) => i.productId === chargedBack.productId)).toMatchObject({ valid: true }); // the second purchase moved up (K-3 Option D)
      await expectHttpMemberReadMatchesB6(t.app, 'reversed', u, SUBSCRIPTION_PLATFORM);
    });

    it('an archived product\'s subscription is still listed, with B6\'s answer', async () => {
      const u = member('archived');
      const { productId, priceId } = await personalPrice(admin);
      await buy(u, priceId, new Date(Date.now() - day));
      await admin.query(`UPDATE product SET status = 'archived' WHERE id = $1`, [productId]);
      expect(await expectHttpMemberReadMatchesB6(t.app, 'archived', u, SUBSCRIPTION_PLATFORM)).toEqual([{ productId, valid: true, expiresAt: expect.any(String) }]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────── pages (D-B6)

  describe('pages: Billing\'s strict unsigned cursor, newest first (D-B6)', () => {
    it('several pages cover every subscription exactly once, newest first by creation time then id; the last page has no cursor', async () => {
      const u = member('pages');
      for (let i = 0; i < 5; i++) await buy(u, (await personalPrice(admin)).priceId, new Date(Date.now() - day));
      const expected = (await admin.query(
        `SELECT "productId" FROM personal_subscription WHERE "userId" = $1 ORDER BY date_trunc('milliseconds', "createdAt") DESC, id DESC`, [u])).rows.map((r) => r.productId as string);
      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const r: request.Response = await read('pages', SUBSCRIPTION_PLATFORM, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
        sizes.push(r.body.items.length);
        seen.push(...r.body.items.map((i: { productId: string }) => i.productId));
        cursor = r.body.nextCursor;
      } while (cursor);
      expect(sizes).toEqual([2, 2, 1]);
      expect(seen).toEqual(expected);
      expect((await memberReadAt(t.app, u, SUBSCRIPTION_PLATFORM, new Date())).map((i) => i.productId)).toEqual(expected);
    });

    it('subscriptions created within one millisecond are neither skipped nor repeated across a page boundary', async () => {
      const u = member('same-ms');
      const products: string[] = [];
      for (let i = 0; i < 4; i++) products.push((await personalPrice(admin)).productId);
      // four subscriptions in ONE statement: one transaction timestamp, so the same createdAt; the id orders them
      await admin.query(`INSERT INTO personal_subscription ("userId", "platformId", "productId") SELECT $1, $2, unnest($3::uuid[])`, [u, SUBSCRIPTION_PLATFORM, products]);
      const seen: string[] = [];
      let cursor: { createdAt: Date; id: string } | null = null;
      for (;;) {
        const p = await page(u, SUBSCRIPTION_PLATFORM, new Date(), 1, cursor);
        seen.push(...p.items.map((i) => i.productId));
        if (!p.nextCursor) break;
        cursor = decodeCursor(p.nextCursor);
      }
      expect([...seen].sort()).toEqual([...products].sort());
      expect(new Set(seen).size).toBe(4);
      expect(await expectMemberReadMatchesB6(t.app, u, SUBSCRIPTION_PLATFORM)).toHaveLength(4); // never purchased: valid false, as B6
    });

    it('limit defaults to 20 and is at most 100; anything else, and any cursor Billing did not issue, is 400', async () => {
      const u = member('limits');
      for (let i = 0; i < 21; i++) await buy(u, (await personalPrice(admin)).priceId, new Date(Date.now() - day));
      const first = await read('limits').expect(200);
      expect(first.body.items).toHaveLength(20);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      expect((await read('limits', SUBSCRIPTION_PLATFORM, `?cursor=${first.body.nextCursor}`)).body.items).toHaveLength(1);
      expect((await read('limits', SUBSCRIPTION_PLATFORM, '?limit=100')).body.items).toHaveLength(21);
      for (const limit of ['0', '101', 'abc', '1.5', '-1']) expect((await read('limits', SUBSCRIPTION_PLATFORM, `?limit=${limit}`)).status, limit).toBe(400);
      const forged = [
        'not a cursor!',
        Buffer.from('{}').toString('base64url'),
        Buffer.from(JSON.stringify({ t: new Date().toISOString(), i: 'not-a-uuid' })).toString('base64url'),
        Buffer.from(JSON.stringify({ t: '2026-11-01', i: randomUUID() })).toString('base64url'),
        Buffer.from('[1,2]').toString('base64url'),
        'x'.repeat(257),
      ];
      for (const c of forged) expect((await read('limits', SUBSCRIPTION_PLATFORM, `?cursor=${encodeURIComponent(c)}`)).status, c).toBe(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────── reads only

  it('the read changes nothing: every table (the audit tables included, the outbox\'s events included) is identical before and after', async () => {
    const u = member('read-only');
    const { priceId } = await personalPrice(admin);
    await buy(u, priceId, new Date(Date.now() - day));
    const before = await fingerprint();
    for (const bearer of ['read-only', 'owner-1', 'nobody', 'auth-down']) await read(bearer);
    await read('read-only', SUBSCRIPTION_PLATFORM, '?limit=1');
    const after = await fingerprint();
    expect(after).toEqual(before);

    // The fingerprint still sees every outbox event change; only the relay's delivery fields are left out. Events are immutable in the
    // database itself, so the forbidden changes are made as a superuser with the triggers bypassed, for this probe only.
    const asFixture = async (sql: string, params: unknown[]) => {
      const cl = await admin.connect();
      try {
        await cl.query('SET session_replication_role = replica');
        await cl.query(sql, params);
      } finally {
        await cl.query('SET session_replication_role = origin');
        cl.release();
      }
    };
    const probe = randomUUID();
    await admin.query(`INSERT INTO outbox (id, name, payload) VALUES ($1, 'test.fingerprint_probe', '{}')`, [probe]);
    const added = (await fingerprint()).outbox;
    expect(added).not.toBe(after.outbox); // an added event
    await asFixture(`UPDATE outbox SET payload = '{"changed": true}' WHERE id = $1`, [probe]);
    const changed = (await fingerprint()).outbox;
    expect(changed).not.toBe(added); // a modified event
    await asFixture(`UPDATE outbox SET "publishedAt" = now(), attempts = attempts + 1, "lastError" = 'x', "availableAt" = now() WHERE id = $1`, [probe]);
    expect((await fingerprint()).outbox).toBe(changed); // delivery fields only: what the relay writes
    await asFixture(`DELETE FROM outbox WHERE id = $1`, [probe]);
    expect((await fingerprint()).outbox).toBe(after.outbox); // a deleted event is seen too: back to the content before the probe
  });
});
