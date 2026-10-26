import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import type { TransitionContext } from '../src/domain/actors.js';
import { SubscriptionRepository } from '../src/subscriptions/subscription.repository.js';
import { createTestApp, type TestApp } from './support/app.js';
import { monthlyPeriodEndingBy } from './support/billing-calendar.js';
import { describeWithEnv } from './support/env.js';
import { settle, subscriptionPrice } from './support/settlement.js';

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
 * HTTP suites. The commercial scenarios use a 30-day price (`activeUntil`), whose period ends at an exact wall-clock instant, since
 * the Organization grace is exactly 24 hours (Core V2 S3e); the others use a monthly price on its anchor cadence
 * (`monthlyPeriodEndingBy`, ADR-0044 B-025), where a few days' slack changes nothing.
 */
describeWithEnv('Billing effective-access / entitlement contract (Stage 12.5), against a real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let subs: SubscriptionRepository;

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
    subs = t.app.get(SubscriptionRepository);
  });
  afterAll(async () => {
    await t.app.close();
    await admin.end();
    await db.drop();
  });

  const getEntitlement = (organizationId: string) =>
    request(t.app.getHttpServer()).get(`/billing/organizations/${organizationId}/entitlement`).set('authorization', `Bearer ${producer.token}`);

  /**
   * Core V2 S3e: these scenarios run against the real wall clock, and the Organization grace is exactly 24 hours, so a period must end at
   * an EXACT instant (a monthly cadence can end up to three days early). A 30-day price has no calendar cadence: settled at `end - 30
   * days`, its first period ends exactly at `end`, and its grace exactly 24 hours later.
   */
  async function activeUntil(end: Date): Promise<{ organizationId: string; end: Date; graceUntil: Date }> {
    const organizationId = org();
    const { productId, priceId } = await subscriptionPrice(admin, { intervalUnit: 'day', intervalCount: 30 });
    await subs.create(organizationId, productId, priceId, ctx);
    const settled = await settle(t.app, { organizationId, priceId, at: new Date(end.getTime() - 30 * day) });
    expect(settled.subscription).toMatchObject({ status: 'active', currentPeriodEnd: end, graceUntil: new Date(end.getTime() + day) });
    return { organizationId, end, graceUntil: new Date(end.getTime() + day) };
  }

  // ---------------------------------------------------------------------------------------------------- commercial scenarios
  it('1. no Subscription at all for the Organization -> 200, valid:false, expiresAt:null (never 404 — no Subscription is a normal commercial state)', async () => {
    const res = await getEntitlement(org()).expect(200);
    expect(res.body).toEqual({ valid: false, expiresAt: null });
  });

  it('2. a pending Subscription (created but never activated) -> false/null', async () => {
    const organizationId = org();
    const { productId, priceId } = await subscriptionPrice(admin);
    await subs.create(organizationId, productId, priceId, ctx);
    const res = await getEntitlement(organizationId).expect(200);
    expect(res.body).toEqual({ valid: false, expiresAt: null });
  });

  it('3. an active paid period -> true; expiresAt is the access boundary: the period end plus the fixed 24-hour grace (S3e)', async () => {
    const { organizationId, graceUntil } = await activeUntil(new Date(Date.now() + 20 * day));
    const res = await getEntitlement(organizationId).expect(200);
    expect(res.body).toEqual({ valid: true, expiresAt: graceUntil.toISOString() });
  });

  it('4. the paid period ended an hour ago: still inside the 24-hour grace -> true/graceUntil', async () => {
    const { organizationId, graceUntil } = await activeUntil(new Date(Date.now() - hour));
    const res = await getEntitlement(organizationId).expect(200);
    expect(res.body).toEqual({ valid: true, expiresAt: graceUntil.toISOString() });
  });

  it('5. Sweeper independence: status still "active" though the paid period already ended, but the grace window is still open -> true/graceUntil', async () => {
    const { organizationId, graceUntil } = await activeUntil(new Date(Date.now() - 23 * hour)); // one hour of grace left
    expect((await subs.getByOrganization(organizationId)).status).toBe('active'); // never normalized to 'grace' — no sweeper exists (section 45)
    const res = await getEntitlement(organizationId).expect(200);
    expect(res.body).toEqual({ valid: true, expiresAt: graceUntil.toISOString() });
  });

  it('6. explicit grace status -> true/graceUntil', async () => {
    const { organizationId, graceUntil } = await activeUntil(new Date(Date.now() - hour));
    const graced = await subs.enterGrace(organizationId, ctx);
    expect(graced.subscription).toMatchObject({ status: 'grace', graceUntil });
    const res = await getEntitlement(organizationId).expect(200);
    expect(res.body).toEqual({ valid: true, expiresAt: graceUntil.toISOString() });
  });

  it('7. the 24-hour grace window has elapsed (the period ended 25 hours ago) -> false/null, whatever the status label says', async () => {
    const { organizationId } = await activeUntil(new Date(Date.now() - 25 * hour));
    expect((await getEntitlement(organizationId).expect(200)).body).toEqual({ valid: false, expiresAt: null });
    await subs.enterGrace(organizationId, ctx); // a stale label never revives access
    expect((await getEntitlement(organizationId).expect(200)).body).toEqual({ valid: false, expiresAt: null });
  });

  // 8. Early termination. No repository method accepts a caller-supplied `effectiveTerminationAt` — `terminate()`
  // always anchors it to the database's own `now()` (section 31) — so the reachable "before/after" pair is exactly this: valid
  // immediately beforehand, invalid immediately after the real `terminate()` call. Termination is stronger than grace: it cuts the
  // grace too (S3e). Precise boundary arithmetic is proven at the unit level (`src/domain/entitlement.spec.ts`).
  it('8. early termination: valid right up until `terminate()`, then false/null immediately after — during the paid period and during grace alike', async () => {
    for (const end of [new Date(Date.now() + 20 * day), new Date(Date.now() - hour)]) {
      const { organizationId, graceUntil } = await activeUntil(end);
      expect((await getEntitlement(organizationId).expect(200)).body).toEqual({ valid: true, expiresAt: graceUntil.toISOString() });
      await subs.terminate(organizationId, ctx);
      expect((await getEntitlement(organizationId).expect(200)).body).toEqual({ valid: false, expiresAt: null });
    }
  });

  it('9. cancelAtPeriodEnd is scheduled but never revokes already-purchased access, nor its grace (Stage 12.3 excludes it from the input entirely)', async () => {
    const { organizationId, graceUntil } = await activeUntil(new Date(Date.now() + 20 * day));
    const scheduled = await subs.scheduleCancellation(organizationId, ctx);
    expect(scheduled.subscription.graceUntil).toEqual(graceUntil); // S3e: the toggle keeps the period's grace
    const res = await getEntitlement(organizationId).expect(200);
    expect(res.body).toEqual({ valid: true, expiresAt: graceUntil.toISOString() });
  });

  it('10. status independence: forced to "expired" while the period itself has not actually ended -> the TIMESTAMP-derived answer wins, never the status label (section 29/30)', async () => {
    const { organizationId, graceUntil } = await activeUntil(new Date(Date.now() + 20 * day));
    const expired = await subs.expire(organizationId, ctx); // a legal active->expired transition, independent of whether time has actually elapsed
    expect(expired.subscription.status).toBe('expired');
    const res = await getEntitlement(organizationId).expect(200);
    expect(res.body).toEqual({ valid: true, expiresAt: graceUntil.toISOString() });
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
    const a = await subscriptionPrice(admin);
    const b = await subscriptionPrice(admin);
    await subs.create(orgA, a.productId, a.priceId, ctx);
    await settle(t.app, { organizationId: orgA, priceId: a.priceId, at: monthlyPeriodEndingBy(new Date(Date.now() + 29 * day)).start });
    await subs.create(orgB, b.productId, b.priceId, ctx); // orgB stays pending — a different commercial state entirely

    const resA = await getEntitlement(orgA).expect(200);
    const resB = await getEntitlement(orgB).expect(200);
    expect(resA.body.valid).toBe(true);
    expect(resB.body).toEqual({ valid: false, expiresAt: null });
  });

  // ---------------------------------------------------------------------------------------------------------------- transport/shape
  it('a malformed organizationId never reaches PostgreSQL: 400', async () => {
    await request(t.app.getHttpServer()).get('/billing/organizations/not-a-uuid/entitlement').set('authorization', `Bearer ${producer.token}`).expect(400);
  });

  it('the response shape is EXACTLY {valid, expiresAt}: no Subscription internals (id/status/priceId/productId/revision/...) ever leak', async () => {
    const organizationId = org();
    const { productId, priceId } = await subscriptionPrice(admin);
    await subs.create(organizationId, productId, priceId, ctx);
    await settle(t.app, { organizationId, priceId, at: monthlyPeriodEndingBy(new Date(Date.now() + 29 * day)).start });
    const res = await getEntitlement(organizationId).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'valid']);
  });

  // ---------------------------------------------------------------------------------------------------------------- read-only
  it('read-only: a GET never mutates the Subscription row, its history, or bumps its revision — even when called repeatedly', async () => {
    const organizationId = org();
    const { productId, priceId } = await subscriptionPrice(admin);
    await subs.create(organizationId, productId, priceId, ctx);
    const activated = await settle(t.app, { organizationId, priceId, at: monthlyPeriodEndingBy(new Date(Date.now() + 29 * day)).start });

    const before = (await admin.query(`SELECT revision, "updatedAt" FROM subscription WHERE id = $1`, [activated.subscription!.id])).rows[0];
    const historyBefore = (await admin.query(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityType"='subscription' AND "entityId"=$1`, [activated.subscription!.id])).rows[0].n;

    await getEntitlement(organizationId).expect(200);
    await getEntitlement(organizationId).expect(200);

    const after = (await admin.query(`SELECT revision, "updatedAt" FROM subscription WHERE id = $1`, [activated.subscription!.id])).rows[0];
    expect(after).toEqual(before);
    const historyAfter = (await admin.query(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityType"='subscription' AND "entityId"=$1`, [activated.subscription!.id])).rows[0].n;
    expect(historyAfter).toBe(historyBefore);
  });
});
