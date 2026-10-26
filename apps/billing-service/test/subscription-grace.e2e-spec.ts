import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { BILLING_OPERATIONS } from '../src/admission/caller-admission.policy.js';
import { billingMigrationsDir } from '../src/app.module.js';
import type { TransitionContext } from '../src/domain/actors.js';
import { deriveEntitlement } from '../src/domain/entitlement.js';
import { PersonalSubscriptionRepository } from '../src/subscriptions/personal-subscription.repository.js';
import { SubscriptionRepository } from '../src/subscriptions/subscription.repository.js';
import { createTestApp, TEST_PLATFORM, type TestApp } from './support/app.js';
import { anchorOccurrence } from './support/billing-calendar.js';
import { describeWithEnv } from './support/env.js';
import { configurePlatform, personalPrice, settle, subscriptionPrice, SUBSCRIPTION_PLATFORM } from './support/settlement.js';

const OTHER_PLATFORM = '77777777-7777-4777-8777-777777777777';
const ms = 1;
const hour = 3_600_000;
const day = 24 * hour;

/**
 * Core V2 S3e (ADR-0044 B13; S0 §3.9; register I-3, BIL-09): the fixed grace, through the REAL settlement path on real PostgreSQL 16.
 * Organization: exactly 24 hours after `currentPeriodEnd`, written with the period and frozen for it; Personal: none. Grace is a lifecycle
 * and entitlement boundary only: it never creates a payment, a settlement, a purchase or a renewal.
 */
describeWithEnv('fixed subscription grace (Core V2 S3e) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let subs: SubscriptionRepository;
  let personal: PersonalSubscriptionRepository;
  const producer = generateServiceToken();
  const ctx: TransitionContext = { actor: { type: 'service', id: 'test-producer' }, cause: { type: 'request', id: 'r-s3e' }, correlationId: 'c-s3e' };
  const org = () => crypto.randomUUID();
  const user = () => `user-${crypto.randomUUID()}`;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings3e');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    await configurePlatform(admin, OTHER_PLATFORM);
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [{ caller: 'test-producer', digest: producer.digest }],
      env: { BILLING_SERVICE_POLICY: JSON.stringify({ callers: { 'test-producer': { operations: [...BILLING_OPERATIONS], allowedPlatforms: [SUBSCRIPTION_PLATFORM, OTHER_PLATFORM, TEST_PLATFORM] } } }) },
    });
    subs = t.app.get(SubscriptionRepository);
    personal = t.app.get(PersonalSubscriptionRepository);
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  /** An Organization Subscription to a 30-day price (no calendar cadence), first settled at `at`: its period ends exactly 30 days later. */
  async function organizationSubscription(at: Date, unit: 'day' | 'month' = 'day') {
    const organizationId = org();
    const { productId, priceId } = await subscriptionPrice(admin, unit === 'day' ? { intervalUnit: 'day', intervalCount: 30 } : {});
    await subs.create(organizationId, productId, priceId, ctx);
    const first = await settle(t.app, { organizationId, priceId, at });
    return { organizationId, priceId, row: first.subscription! };
  }
  const renew = (o: { organizationId: string; priceId: string }, at: Date) => settle(t.app, { organizationId: o.organizationId, priceId: o.priceId, at });
  const graceOf = (end: Date) => new Date(end.getTime() + day);
  const facts = async () => (await admin.query(`SELECT
      (SELECT count(*)::int FROM invoice WHERE status = 'paid') AS "paidInvoices",
      (SELECT count(*)::int FROM payment_event_receipt) AS receipts,
      (SELECT count(*)::int FROM subscription_settlement) AS settlements,
      (SELECT count(*)::int FROM subscription_purchase) AS purchases,
      (SELECT count(*)::int FROM outbox WHERE name IN ('audit.subscription.renewed', 'audit.subscription.activated')) AS "renewalEvidence"`)).rows[0];

  // ─────────────────────────────────────────────────────────────────────────────────────────────── Organization: 24 hours

  describe('Organization: exactly 24 hours after the period end', () => {
    it('activation writes graceUntil = currentPeriodEnd + 24 h exactly (milliseconds kept, UTC instants), frozen for the period', async () => {
      const at = new Date('2027-03-01T10:15:30.123Z');
      const { row } = await organizationSubscription(at);
      expect(row.currentPeriodEnd).toEqual(new Date(at.getTime() + 30 * day));
      expect(row.graceUntil).toEqual(new Date(at.getTime() + 31 * day));
    });

    it.each([
      ['one millisecond before expiry', -ms, true],
      ['exactly at expiry', 0, true],
      ['one millisecond before the 24-hour deadline', day - ms, true],
      ['exactly at the 24-hour deadline', day, false],
      ['one millisecond after grace', day + ms, false],
    ])('a repository-loaded row: %s', async (_n, offset, valid) => {
      const { organizationId, row } = await organizationSubscription(new Date('2027-04-01T00:00:00Z'));
      const loaded = await subs.getByOrganization(organizationId);
      const now = new Date(row.currentPeriodEnd!.getTime() + offset);
      expect(deriveEntitlement(loaded, now)).toEqual(valid ? { valid: true, expiresAt: graceOf(row.currentPeriodEnd!) } : { valid: false, expiresAt: null });
    });

    it('renewals: early, during grace and at its last instant anchor on the original end; after grace starts at the settlement; each period gets its own 24 hours', async () => {
      const o = await organizationSubscription(new Date('2027-05-01T00:00:00Z'));
      const end1 = o.row.currentPeriodEnd!;
      const early = (await renew(o, new Date(end1.getTime() - 5 * day))).subscription!;
      expect(early).toMatchObject({ currentPeriodStart: end1, currentPeriodEnd: new Date(end1.getTime() + 30 * day), graceUntil: new Date(end1.getTime() + 31 * day) });
      const end2 = early.currentPeriodEnd!;
      const inGrace = (await renew(o, new Date(end2.getTime() + 12 * hour))).subscription!;
      expect(inGrace).toMatchObject({ currentPeriodStart: end2, currentPeriodEnd: new Date(end2.getTime() + 30 * day), graceUntil: new Date(end2.getTime() + 31 * day) });
      const end3 = inGrace.currentPeriodEnd!;
      const lastInstant = (await renew(o, new Date(end3.getTime() + day))).subscription!; // the deadline itself is not late
      expect(lastInstant).toMatchObject({ currentPeriodStart: end3 });
      const end4 = lastInstant.currentPeriodEnd!;
      const lateAt = new Date(end4.getTime() + day + ms);
      const late = (await renew(o, lateAt)).subscription!;
      expect(late).toMatchObject({ currentPeriodStart: lateAt, currentPeriodEnd: new Date(lateAt.getTime() + 30 * day), graceUntil: new Date(lateAt.getTime() + 31 * day) });
    });

    it('a monthly cadence: grace follows the clamped period end, and an in-grace renewal keeps the billing anchor', async () => {
      const anchor = new Date('2027-01-31T09:30:00Z');
      const o = await organizationSubscription(anchor, 'month');
      expect(o.row).toMatchObject({ currentPeriodEnd: new Date('2027-02-28T09:30:00Z'), graceUntil: new Date('2027-03-01T09:30:00Z') });
      const renewed = (await renew(o, new Date('2027-03-01T09:00:00Z'))).subscription!;
      expect(renewed).toMatchObject({ currentPeriodStart: new Date('2027-02-28T09:30:00Z'), currentPeriodEnd: anchorOccurrence(anchor, 2), graceUntil: graceOf(anchorOccurrence(anchor, 2)), billingAnchorAt: anchor });
    });

    it('termination during grace is stronger than grace: access ends immediately; the stored grace is unchanged', async () => {
      const o = await organizationSubscription(new Date(Date.now() - 30 * day - hour)); // the period ended an hour ago
      expect(deriveEntitlement(await subs.getByOrganization(o.organizationId), new Date())).toMatchObject({ valid: true });
      const terminated = (await subs.terminate(o.organizationId, ctx)).subscription;
      expect(terminated.graceUntil).toEqual(o.row.graceUntil);
      expect(deriveEntitlement(terminated, new Date())).toEqual({ valid: false, expiresAt: null });
    });

    it('the HTTP read answers the same boundary: an hour into grace is valid until graceUntil; 25 hours after the end is not', async () => {
      const get = (organizationId: string) => request(t.app.getHttpServer()).get(`/billing/organizations/${organizationId}/entitlement`).set('authorization', `Bearer ${producer.token}`);
      const inGrace = await organizationSubscription(new Date(Date.now() - 30 * day - hour));
      expect((await get(inGrace.organizationId).expect(200)).body).toEqual({ valid: true, expiresAt: inGrace.row.graceUntil!.toISOString() });
      const lapsed = await organizationSubscription(new Date(Date.now() - 30 * day - 25 * hour));
      expect((await get(lapsed.organizationId).expect(200)).body).toEqual({ valid: false, expiresAt: null });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── grace creates nothing

  describe('grace is never settlement evidence', () => {
    it('entering grace, reading entitlement in grace, and expiring create no payment, settlement, purchase, renewal or period', async () => {
      const o = await organizationSubscription(new Date(Date.now() - 30 * day - hour));
      const before = await facts();
      const graced = (await subs.enterGrace(o.organizationId, ctx)).subscription;
      for (let i = 0; i < 3; i++) await request(t.app.getHttpServer()).get(`/billing/organizations/${o.organizationId}/entitlement`).set('authorization', `Bearer ${producer.token}`).expect(200);
      const expired = (await subs.expire(o.organizationId, ctx)).subscription;
      expect(await facts()).toEqual(before);
      for (const row of [graced, expired]) {
        expect(row).toMatchObject({ currentPeriodStart: o.row.currentPeriodStart, currentPeriodEnd: o.row.currentPeriodEnd, graceUntil: o.row.graceUntil, billingAnchorAt: o.row.billingAnchorAt });
      }
    });

    it('no raw SQL path stores another grace, drops it, or moves it with the period: refused, and the row is unchanged (rollback)', async () => {
      const o = await organizationSubscription(new Date('2027-06-01T00:00:00Z'));
      const snapshot = async () => (await admin.query(`SELECT * FROM subscription WHERE id = $1`, [o.row.id])).rows[0];
      const before = await snapshot();
      for (const set of [`"graceUntil" = "currentPeriodEnd" + interval '7 days'`, `"graceUntil" = NULL`, `"graceUntil" = "currentPeriodEnd" + interval '23 hours 59 minutes'`]) {
        await expect(admin.query(`UPDATE subscription SET ${set} WHERE id = $1`, [o.row.id]), set).rejects.toMatchObject({ code: '23514', constraint: 'subscription_grace_fixed' });
      }
      // a period extension with a correct grace, but without a settlement in its transaction, is still DB-11's refusal (at commit)
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query(`UPDATE subscription SET "currentPeriodStart" = "currentPeriodEnd", "currentPeriodEnd" = "currentPeriodEnd" + interval '30 days', "graceUntil" = "currentPeriodEnd" + interval '31 days' WHERE id = $1`, [o.row.id]);
        await c.query(`INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "causeType") SELECT 'subscription', id, 'active', 'active', revision, 'system', 'request' FROM subscription WHERE id = $1`, [o.row.id]);
        await expect(c.query('COMMIT')).rejects.toMatchObject({ code: '23514', constraint: 'subscription_period_settled' });
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── Personal: none

  describe('Personal: no grace', () => {
    it('valid until the paid end and not one millisecond after; renewal before expiry continues, after a lapse it restarts', async () => {
      const u = user();
      const { productId, priceId } = await personalPrice(admin, { intervalUnit: 'day', intervalCount: 30 });
      const at = new Date('2027-07-01T00:00:00Z');
      await settle(t.app, { organizationId: null, priceId, at, payer: { type: 'user', id: u } });
      const end = new Date(at.getTime() + 30 * day);
      const ent = (now: Date) => personal.entitlement(u, SUBSCRIPTION_PLATFORM, productId, now);
      expect(await ent(new Date(end.getTime() - ms))).toEqual({ valid: true, expiresAt: end });
      expect(await ent(end)).toEqual({ valid: false, expiresAt: null });
      expect(await ent(new Date(end.getTime() + hour))).toEqual({ valid: false, expiresAt: null }); // where an Organization would be in grace
      await settle(t.app, { organizationId: null, priceId, at: new Date(end.getTime() - day), payer: { type: 'user', id: u } }); // before expiry
      const end2 = new Date(end.getTime() + 30 * day);
      expect(await ent(end)).toEqual({ valid: true, expiresAt: end2 });
      const lapseAt = new Date(end2.getTime() + 12 * hour); // after a lapse, even a short one: a gap, then a new span from the settlement
      await settle(t.app, { organizationId: null, priceId, at: lapseAt, payer: { type: 'user', id: u } });
      expect(await ent(new Date(end2.getTime() + hour))).toEqual({ valid: false, expiresAt: null });
      expect(await ent(lapseAt)).toEqual({ valid: true, expiresAt: new Date(lapseAt.getTime() + 30 * day) });
    });

    it('inherits nothing from an Organization subscription in grace, and stays isolated by user, product and Platform', async () => {
      const u = user();
      const p = await personalPrice(admin, { intervalUnit: 'day', intervalCount: 30 });
      const other = await personalPrice(admin, { intervalUnit: 'day', intervalCount: 30 });
      const otherPlatform = await personalPrice(admin, { intervalUnit: 'day', intervalCount: 30, platformId: OTHER_PLATFORM });
      const at = new Date(Date.now() - 30 * day - hour); // the personal period ended an hour ago
      await settle(t.app, { organizationId: null, priceId: p.priceId, at, payer: { type: 'user', id: u } });
      // the same user's Organization, on the same Platform, is in its 24-hour grace right now
      const o = await organizationSubscription(at);
      const now = new Date();
      expect(deriveEntitlement(await subs.getByOrganization(o.organizationId), now)).toMatchObject({ valid: true });
      expect(await personal.entitlement(u, SUBSCRIPTION_PLATFORM, p.productId, now)).toEqual({ valid: false, expiresAt: null });
      const cols = (await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('personal_subscription', 'subscription_purchase') AND column_name ILIKE '%grace%'`)).rows;
      expect(cols).toEqual([]);
      // isolation: nothing for another user, another product, or the product read through another Platform
      const within = new Date(at.getTime() + day);
      expect(await personal.entitlement(u, SUBSCRIPTION_PLATFORM, p.productId, within)).toMatchObject({ valid: true });
      expect(await personal.entitlement(user(), SUBSCRIPTION_PLATFORM, p.productId, within)).toEqual({ valid: false, expiresAt: null });
      expect(await personal.entitlement(u, SUBSCRIPTION_PLATFORM, other.productId, within)).toEqual({ valid: false, expiresAt: null });
      expect(await personal.entitlement(u, OTHER_PLATFORM, p.productId, within)).toEqual({ valid: false, expiresAt: null });
      expect(await personal.entitlement(u, OTHER_PLATFORM, otherPlatform.productId, within)).toEqual({ valid: false, expiresAt: null });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── concurrency

  describe('concurrency', () => {
    it('renewal settlements racing grace entry, expiry and termination: no deadlock, and the final row always carries the fixed grace', async () => {
      for (let round = 0; round < 3; round++) {
        const o = await organizationSubscription(new Date(Date.now() - 30 * day - hour));
        const results = await Promise.allSettled([
          renew(o, new Date()), renew(o, new Date()),
          subs.enterGrace(o.organizationId, ctx), subs.expire(o.organizationId, ctx), subs.terminate(o.organizationId, ctx),
        ]);
        for (const r of results) {
          if (r.status === 'rejected') expect(String((r.reason as { response?: { code?: string } }).response?.code ?? r.reason)).toMatch(/invalid_subscription_transition/);
        }
        expect(results.slice(0, 2).every((r) => r.status === 'fulfilled')).toBe(true); // a verified settlement always applies
        const row = (await admin.query(`SELECT status, "currentPeriodEnd", "graceUntil" FROM subscription WHERE id = $1`, [o.row.id])).rows[0];
        expect(row.graceUntil).toEqual(graceOf(row.currentPeriodEnd));
        expect((await admin.query(`SELECT count(*)::int AS n FROM subscription_settlement WHERE "subscriptionId" = $1`, [o.row.id])).rows[0].n).toBe(3);
      }
    });
  });
});
