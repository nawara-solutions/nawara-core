import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import type { TransitionContext } from '../src/domain/actors.js';
import { SubscriptionRepository } from '../src/subscriptions/subscription.repository.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 12.5: the HTTP transport over Stage 12.3's `deriveEntitlement` (already exhaustively proven at the unit level,
 * `src/domain/entitlement.spec.ts`) composed with Stage 12.2's `SubscriptionRepository` (already exhaustively proven
 * at the repository/database level, `test/subscriptions.e2e-spec.ts`). This file proves the TRANSPORT LAYER only:
 * authentication, tenant isolation, the frozen `{ valid, expiresAt }` response shape, read-only-ness, and that Stage
 * 12.3's timestamp-authoritative semantics (grace, premature/stale status, early termination) survive composition
 * through a real HTTP request — never re-implementing or re-deciding any of that here (SDD/repo convention: compare
 * `test/http-api.e2e-spec.ts`'s own relationship to `test/invoices.e2e-spec.ts`).
 *
 * Every scenario anchors its Subscription periods on the REAL wall clock (`Date.now()`), not a fixed calendar date,
 * because the controller itself supplies the one authoritative `now` from `new Date()` at the HTTP boundary (section
 * 9) — there is no injectable clock to fake here, matching this repo's existing convention for other real-time-bound
 * HTTP suites.
 */
describeWithEnv('Billing effective-access / entitlement contract (Stage 12.5), against a real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp; // grace-enabled (test app default: SUBSCRIPTION_GRACE_DAYS=7) — grace-specific scenarios and auth
  let noGrace: TestApp; // SUBSCRIPTION_GRACE_DAYS='' — scenarios that need a clean currentPeriodEnd/effectiveTerminationAt boundary
  let admin: pg.Pool;
  let subs: SubscriptionRepository;
  let noGraceSubs: SubscriptionRepository;

  const ctx: TransitionContext = { actor: { type: 'service', id: 'test-producer' }, cause: { type: 'request', id: 'r1' }, correlationId: 'c1' };
  const day = 86_400_000;
  const hour = 3_600_000;
  const org = () => crypto.randomUUID();

  const producer = generateServiceToken();
  // Recognized by Auth as a genuinely valid, active identity — proves the endpoint refuses even a REAL end-user, not
  // merely an unrecognized bearer (section 13: this is a service-to-service contract, never user-facing).
  const validUser: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const authClient: AuthClient = { getIdentity: async (bearer) => (bearer === 'user-jwt' ? validUser : null), hasPlatformAccess: async () => false };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingentitlement');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    t = await createTestApp({ databaseUrl: db.url, tokens: [{ caller: 'test-producer', digest: producer.digest }], authClient });
    noGrace = await createTestApp({ databaseUrl: db.url, tokens: [{ caller: 'test-producer', digest: producer.digest }], env: { SUBSCRIPTION_GRACE_DAYS: '' } });
    subs = t.app.get(SubscriptionRepository);
    noGraceSubs = noGrace.app.get(SubscriptionRepository);
  });
  afterAll(async () => {
    await t.app.close();
    await noGrace.app.close();
    await admin.end();
    await db.drop();
  });

  const getEntitlement = (organizationId: string) =>
    request(t.app.getHttpServer()).get(`/billing/organizations/${organizationId}/entitlement`).set('authorization', `Bearer ${producer.token}`);
  const getEntitlementNoGrace = (organizationId: string) =>
    request(noGrace.app.getHttpServer()).get(`/billing/organizations/${organizationId}/entitlement`).set('authorization', `Bearer ${producer.token}`);

  let seq = 0;
  async function recurringPrice(): Promise<{ productId: string; priceId: string }> {
    seq += 1;
    const seller = crypto.randomUUID();
    const productId = (
      await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name) VALUES ('test-producer', 'organization', $1, $2, 'Plan') RETURNING id`, [seller, `plan-${seq}`])
    ).rows[0].id;
    const priceId = (
      await admin.query(
        `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, $2, 'TND', 1000, 'recurring', 'month', 1) RETURNING id`,
        [productId, `ref-${seq}`],
      )
    ).rows[0].id;
    return { productId, priceId };
  }

  // ---------------------------------------------------------------------------------------------------- commercial scenarios
  it('1. no Subscription at all for the Organization -> 200, valid:false, expiresAt:null (never 404 — no Subscription is a normal commercial state)', async () => {
    const res = await getEntitlement(org()).expect(200);
    expect(res.body).toEqual({ valid: false, expiresAt: null });
  });

  it('2. a pending Subscription (created but never activated) -> false/null', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await noGraceSubs.create(organizationId, productId, priceId, ctx);
    const res = await getEntitlementNoGrace(organizationId).expect(200);
    expect(res.body).toEqual({ valid: false, expiresAt: null });
  });

  it('3. an active paid period, no grace configured -> true, expiresAt = currentPeriodEnd', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await noGraceSubs.create(organizationId, productId, priceId, ctx);
    const end = new Date(Date.now() + 28 * day);
    await noGraceSubs.activate(organizationId, { start: new Date(Date.now() - 2 * day), end }, ctx);
    const res = await getEntitlementNoGrace(organizationId).expect(200);
    expect(res.body).toEqual({ valid: true, expiresAt: end.toISOString() });
  });

  it('4. exact paid expiry, no grace configured -> false/null (the end boundary is exclusive)', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await noGraceSubs.create(organizationId, productId, priceId, ctx);
    await noGraceSubs.activate(organizationId, { start: new Date(Date.now() - 30 * day), end: new Date(Date.now() - hour) }, ctx);
    const res = await getEntitlementNoGrace(organizationId).expect(200);
    expect(res.body).toEqual({ valid: false, expiresAt: null });
  });

  it('5. Sweeper independence: status still "active" though the paid period already ended, but the PRECOMPUTED grace window is still open -> true/graceUntil', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    const activated = await subs.activate(organizationId, { start: new Date(Date.now() - 10 * day), end: new Date(Date.now() - hour) }, ctx); // default app: 7-day grace precomputed at activation
    expect(activated.subscription.status).toBe('active'); // never normalized to 'grace' — no sweeper exists (section 45)
    expect(activated.subscription.graceUntil).not.toBeNull();
    const res = await getEntitlement(organizationId).expect(200);
    expect(res.body).toEqual({ valid: true, expiresAt: activated.subscription.graceUntil!.toISOString() });
  });

  it('6. explicit grace status -> true/graceUntil', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    await subs.activate(organizationId, { start: new Date(Date.now() - 10 * day), end: new Date(Date.now() - hour) }, ctx);
    const graced = await subs.enterGrace(organizationId, ctx);
    expect(graced.subscription.status).toBe('grace');
    const res = await getEntitlement(organizationId).expect(200);
    expect(res.body).toEqual({ valid: true, expiresAt: graced.subscription.graceUntil!.toISOString() });
  });

  it('7. the grace window itself has fully elapsed -> false/null', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    // end 10 days ago; default 7-day grace => graceUntil 3 days ago, already elapsed too
    await subs.activate(organizationId, { start: new Date(Date.now() - 20 * day), end: new Date(Date.now() - 10 * day) }, ctx);
    const res = await getEntitlement(organizationId).expect(200);
    expect(res.body).toEqual({ valid: false, expiresAt: null });
  });

  // 8. Early termination. No repository method accepts a caller-supplied `effectiveTerminationAt` — `terminate()`
  // always anchors it to the database's own `now()` (section 31) — and the lifecycle trigger force-clears it back to
  // NULL on every write that leaves (or returns to) `active` (0013_subscription.sql), so a non-null
  // `effectiveTerminationAt` only ever exists on an already-`expired` row, at an instant that has, by construction,
  // already passed by the time any subsequent read observes it. The reachable "before/at-or-after" pair is therefore
  // exactly this: valid immediately beforehand, invalid immediately after the real `terminate()` call — precise
  // boundary arithmetic on an arbitrary `effectiveTerminationAt` is already exhaustively proven at the unit level
  // (`src/domain/entitlement.spec.ts`, which is not constrained by what the live schema can actually produce).
  it('8. early termination: valid right up until `terminate()`, then false/null immediately after (the DB itself owns the instant, never a caller-supplied one)', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await noGraceSubs.create(organizationId, productId, priceId, ctx);
    const end = new Date(Date.now() + 20 * day);
    await noGraceSubs.activate(organizationId, { start: new Date(Date.now() - 10 * day), end }, ctx);

    const before = await getEntitlementNoGrace(organizationId).expect(200);
    expect(before.body).toEqual({ valid: true, expiresAt: end.toISOString() });

    await noGraceSubs.terminate(organizationId, ctx);
    const after = await getEntitlementNoGrace(organizationId).expect(200);
    expect(after.body).toEqual({ valid: false, expiresAt: null });
  });

  it('9. cancelAtPeriodEnd is scheduled but never revokes already-purchased access before the boundary (Stage 12.3 excludes it from the input entirely)', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await noGraceSubs.create(organizationId, productId, priceId, ctx);
    const end = new Date(Date.now() + 28 * day);
    await noGraceSubs.activate(organizationId, { start: new Date(Date.now() - 2 * day), end }, ctx);
    await noGraceSubs.scheduleCancellation(organizationId, ctx);
    const res = await getEntitlementNoGrace(organizationId).expect(200);
    expect(res.body).toEqual({ valid: true, expiresAt: end.toISOString() });
  });

  it('10. status independence: forced to "expired" while the period itself has not actually ended -> the TIMESTAMP-derived answer wins, never the status label (section 29/30)', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await noGraceSubs.create(organizationId, productId, priceId, ctx);
    const end = new Date(Date.now() + 28 * day);
    await noGraceSubs.activate(organizationId, { start: new Date(Date.now() - 2 * day), end }, ctx);
    const expired = await noGraceSubs.expire(organizationId, ctx); // a legal active->expired transition, independent of whether time has actually elapsed
    expect(expired.subscription.status).toBe('expired');
    const res = await getEntitlementNoGrace(organizationId).expect(200);
    expect(res.body).toEqual({ valid: true, expiresAt: end.toISOString() });
  });

  // ---------------------------------------------------------------------------------------------------------------- authentication
  describe('authentication (internal service-to-service only, section 13)', () => {
    it('no Authorization header -> 401', async () => {
      await request(t.app.getHttpServer()).get(`/billing/organizations/${org()}/entitlement`).expect(401);
    });

    it('a malformed/unrecognized bearer -> 401', async () => {
      await request(t.app.getHttpServer()).get(`/billing/organizations/${org()}/entitlement`).set('authorization', 'Bearer not-a-real-token').expect(401);
    });

    it('a service token that is real but NOT configured for this deployment -> 401', async () => {
      const unknown = generateServiceToken();
      await request(t.app.getHttpServer()).get(`/billing/organizations/${org()}/entitlement`).set('authorization', `Bearer ${unknown.token}`).expect(401);
    });

    it('a genuinely valid, ACTIVE end-user identity is still refused (401): this is never a user-facing route, whatever Auth says about the bearer', async () => {
      await request(t.app.getHttpServer()).get(`/billing/organizations/${org()}/entitlement`).set('authorization', 'Bearer user-jwt').expect(401);
    });

    it('a correctly configured service token -> 200', async () => {
      await getEntitlement(org()).expect(200);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------- tenant isolation
  it('tenant isolation: two Organizations each see only their OWN entitlement, never a cross-tenant fallback', async () => {
    const orgA = org();
    const orgB = org();
    const a = await recurringPrice();
    const b = await recurringPrice();
    await noGraceSubs.create(orgA, a.productId, a.priceId, ctx);
    await noGraceSubs.activate(orgA, { start: new Date(Date.now() - day), end: new Date(Date.now() + 29 * day) }, ctx);
    await noGraceSubs.create(orgB, b.productId, b.priceId, ctx); // orgB stays pending — a different commercial state entirely

    const resA = await getEntitlementNoGrace(orgA).expect(200);
    const resB = await getEntitlementNoGrace(orgB).expect(200);
    expect(resA.body.valid).toBe(true);
    expect(resB.body).toEqual({ valid: false, expiresAt: null });
  });

  // ---------------------------------------------------------------------------------------------------------------- transport/shape
  it('a malformed organizationId never reaches PostgreSQL: 400', async () => {
    await request(t.app.getHttpServer()).get('/billing/organizations/not-a-uuid/entitlement').set('authorization', `Bearer ${producer.token}`).expect(400);
  });

  it('the response shape is EXACTLY {valid, expiresAt}: no Subscription internals (id/status/priceId/productId/revision/...) ever leak', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await noGraceSubs.create(organizationId, productId, priceId, ctx);
    await noGraceSubs.activate(organizationId, { start: new Date(Date.now() - day), end: new Date(Date.now() + 29 * day) }, ctx);
    const res = await getEntitlementNoGrace(organizationId).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'valid']);
  });

  // ---------------------------------------------------------------------------------------------------------------- read-only
  it('read-only: a GET never mutates the Subscription row, its history, or bumps its revision — even when called repeatedly', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await noGraceSubs.create(organizationId, productId, priceId, ctx);
    const activated = await noGraceSubs.activate(organizationId, { start: new Date(Date.now() - day), end: new Date(Date.now() + 29 * day) }, ctx);

    const before = (await admin.query(`SELECT revision, "updatedAt" FROM subscription WHERE id = $1`, [activated.subscription.id])).rows[0];
    const historyBefore = (await admin.query(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityType"='subscription' AND "entityId"=$1`, [activated.subscription.id])).rows[0].n;

    await getEntitlementNoGrace(organizationId).expect(200);
    await getEntitlementNoGrace(organizationId).expect(200);

    const after = (await admin.query(`SELECT revision, "updatedAt" FROM subscription WHERE id = $1`, [activated.subscription.id])).rows[0];
    expect(after).toEqual(before);
    const historyAfter = (await admin.query(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityType"='subscription' AND "entityId"=$1`, [activated.subscription.id])).rows[0].n;
    expect(historyAfter).toBe(historyBefore);
  });
});
