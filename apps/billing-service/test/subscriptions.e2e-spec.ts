import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import type { TransitionContext } from '../src/domain/actors.js';
import { deriveEntitlement } from '../src/domain/entitlement.js';
import { SubscriptionRepository } from '../src/subscriptions/subscription.repository.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const ctx: TransitionContext = { actor: { type: 'service', id: 'test-producer' }, cause: { type: 'request', id: 'r1' }, correlationId: 'c1' };
const rejects = (p: Promise<unknown>, status: number, code: string) => expect(p).rejects.toMatchObject({ status, response: { code } });
const day = 86_400_000;
const month = 30 * day; // only for constructing an approximate starting period; never for asserting a renewal RESULT (see addMonthUTC)
/** Matches Postgres's `timestamptz + interval '1 month'` (calendar month, not a fixed 30 days) for asserting renewal results. */
const addMonthUTC = (d: Date, n = 1): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));

describeWithEnv('subscription domain (Stage 12.2), against a real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let subs: SubscriptionRepository;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingsub');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    t = await createTestApp({ databaseUrl: db.url });
    subs = t.app.get(SubscriptionRepository);
  });
  afterAll(async () => {
    await t.app.close();
    await admin.end();
    await db.drop();
  });

  /** A fresh product + a recurring, monthly price of its own, sold to nobody in particular. */
  async function recurringPrice(unit = 1000): Promise<{ productId: string; priceId: string }> {
    const seller = crypto.randomUUID();
    const productId = (await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name) VALUES ('test-producer', 'organization', $1, 'sub-plan', 'Plan') RETURNING id`, [seller])).rows[0].id;
    const priceId = (await admin.query(
      `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, 'p', 'TND', $2, 'recurring', 'month', 1) RETURNING id`,
      [productId, unit],
    )).rows[0].id;
    return { productId, priceId };
  }

  const org = () => crypto.randomUUID();

  it('1. first activation: pending -> active with the given period, auditable from creation', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    const created = await subs.create(organizationId, productId, priceId, ctx);
    expect(created).toMatchObject({ changed: true, subscription: { status: 'pending', organizationId, productId, priceId, cancelAtPeriodEnd: false, revision: 0 } });
    expect(created.subscription.currentPeriodStart).toBeNull();

    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-02-01T00:00:00Z');
    const activated = await subs.activate(organizationId, { start, end }, ctx);
    expect(activated).toMatchObject({ changed: true, subscription: { status: 'active', currentPeriodStart: start, currentPeriodEnd: end, revision: 1 } });

    const history = (await admin.query(`SELECT "fromStatus", "toStatus", revision FROM billing_transition WHERE "entityType"='subscription' AND "entityId"=$1 ORDER BY revision`, [activated.subscription.id])).rows;
    expect(history).toEqual([{ fromStatus: null, toStatus: 'pending', revision: 0 }, { fromStatus: 'pending', toStatus: 'active', revision: 1 }]);
  });

  it('12. duplicate current-subscription creation: an identical replay (same product AND price) returns the FIRST row, unchanged', async () => {
    const organizationId = org();
    const a = await recurringPrice();
    const first = await subs.create(organizationId, a.productId, a.priceId, ctx);
    const second = await subs.create(organizationId, a.productId, a.priceId, ctx);
    expect(second).toMatchObject({ changed: false, subscription: { id: first.subscription.id, productId: a.productId, priceId: a.priceId } });
    expect((await admin.query(`SELECT count(*)::int AS n FROM subscription WHERE "organizationId" = $1`, [organizationId])).rows[0].n).toBe(1);
  });

  it('R3: a create for an ALREADY-subscribed organization with a DIFFERENT product or price is a stable conflict, never a silent, disguised upgrade', async () => {
    const organizationId = org();
    const a = await recurringPrice();
    const b = await recurringPrice();
    // a second, distinct price of the SAME product as `a`, so this case tests a genuine price-only conflict rather than
    // an unrelated (product, price) pairing that could never have existed together in the first place.
    const aSecondPriceId = (await admin.query(
      `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, 'p2', 'TND', 2000, 'recurring', 'month', 1) RETURNING id`,
      [a.productId],
    )).rows[0].id;
    const first = await subs.create(organizationId, a.productId, a.priceId, ctx);

    await rejects(subs.create(organizationId, b.productId, b.priceId, ctx), 409, 'subscription_conflict'); // different product AND price
    await rejects(subs.create(organizationId, a.productId, aSecondPriceId, ctx), 409, 'subscription_conflict'); // same product, different price

    // none of the conflicting calls changed anything: still exactly the first row, with the first offering
    const row = await subs.getByOrganization(organizationId);
    expect(row).toMatchObject({ id: first.subscription.id, productId: a.productId, priceId: a.priceId });
    expect((await admin.query(`SELECT count(*)::int AS n FROM subscription WHERE "organizationId" = $1`, [organizationId])).rows[0].n).toBe(1);
  });

  it('R3 concurrency: concurrent creates for the SAME organization and SAME offering all converge on one row; concurrent creates for the SAME organization with DIFFERENT offerings leave exactly one winner and refuse every conflicting loser', async () => {
    const sameOrg = org();
    const a = await recurringPrice();
    const sameResults = await Promise.all(Array.from({ length: 6 }, () => subs.create(sameOrg, a.productId, a.priceId, ctx)));
    expect(sameResults.filter((r) => r.changed)).toHaveLength(1); // exactly one racer actually inserted
    expect(new Set(sameResults.map((r) => r.subscription.id)).size).toBe(1); // every racer agrees on the same row
    expect((await admin.query(`SELECT count(*)::int AS n FROM subscription WHERE "organizationId" = $1`, [sameOrg])).rows[0].n).toBe(1);

    const conflictOrg = org();
    const b = await recurringPrice();
    const settled = await Promise.allSettled([
      subs.create(conflictOrg, a.productId, a.priceId, ctx),
      subs.create(conflictOrg, b.productId, b.priceId, ctx),
      subs.create(conflictOrg, a.productId, a.priceId, ctx),
      subs.create(conflictOrg, b.productId, b.priceId, ctx),
    ]);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof subs.create>>>[];
    const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
    // whichever offering won the race, every racer for the SAME offering as the winner succeeds (idempotent), and every
    // racer for the OTHER offering is refused as a conflict — never a silent second winner, never a lost distinction.
    expect(fulfilled.length + rejected.length).toBe(4);
    expect(new Set(fulfilled.map((f) => f.value.subscription.id)).size).toBe(1);
    for (const r of rejected) expect(r.reason).toMatchObject({ status: 409, response: { code: 'subscription_conflict' } });
    expect((await admin.query(`SELECT count(*)::int AS n FROM subscription WHERE "organizationId" = $1`, [conflictOrg])).rows[0].n).toBe(1);
  });

  it('16. an invalid period (end <= start) is refused with a stable error code, and activation is refused for a non-pending subscription', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    const start = new Date('2026-02-01T00:00:00Z');
    await rejects(subs.activate(organizationId, { start, end: start }, ctx), 400, 'invalid_subscription_period');
    await rejects(subs.activate(organizationId, { start, end: new Date(start.getTime() - day) }, ctx), 400, 'invalid_subscription_period');

    await subs.activate(organizationId, { start, end: new Date(start.getTime() + month) }, ctx);
    await rejects(subs.activate(organizationId, { start, end: new Date(start.getTime() + month) }, ctx), 409, 'invalid_subscription_transition');
  });

  it('the database itself refuses currentPeriodEnd <= currentPeriodStart, independent of the repository', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    const created = await subs.create(organizationId, productId, priceId, ctx);
    const start = new Date('2026-02-01T00:00:00Z');
    await expect(admin.query(`UPDATE subscription SET status = 'active', "currentPeriodStart" = $2, "currentPeriodEnd" = $2 WHERE id = $1`, [created.subscription.id, start]))
      .rejects.toMatchObject({ code: '23514' });
  });

  describe('renewal (sections 22-25)', () => {
    async function activeSubscription(periodEnd: Date) {
      const organizationId = org();
      const { productId, priceId } = await recurringPrice();
      await subs.create(organizationId, productId, priceId, ctx);
      await subs.activate(organizationId, { start: new Date(periodEnd.getTime() - month), end: periodEnd }, ctx);
      return organizationId;
    }

    it('2. early renewal: anchors on the period end, not on now — no purchased time is lost', async () => {
      const periodEnd = new Date('2026-11-01T00:00:00Z');
      const organizationId = await activeSubscription(periodEnd);
      const renewed = await subs.renew(organizationId, new Date('2026-10-20T00:00:00Z'), ctx);
      expect(renewed.subscription).toMatchObject({ status: 'active', currentPeriodStart: periodEnd, currentPeriodEnd: addMonthUTC(periodEnd) });
    });

    it('3. multiple early renewals stay deterministic: each extends from the previous end', async () => {
      const periodEnd = new Date('2026-11-01T00:00:00Z');
      const organizationId = await activeSubscription(periodEnd);
      const r1 = await subs.renew(organizationId, new Date('2026-10-20T00:00:00Z'), ctx);
      expect(r1.subscription.currentPeriodEnd).toEqual(addMonthUTC(periodEnd));
      const r2 = await subs.renew(organizationId, new Date('2026-11-15T00:00:00Z'), ctx);
      expect(r2.subscription.currentPeriodEnd).toEqual(addMonthUTC(periodEnd, 2));
      expect(r2.subscription.revision).toBe(r1.subscription.revision + 1);
    });

    it('4. exact-boundary renewal: now === currentPeriodEnd anchors on currentPeriodEnd, identically to just-before', async () => {
      const periodEnd = new Date('2026-11-01T00:00:00Z');
      const organizationId = await activeSubscription(periodEnd);
      const renewed = await subs.renew(organizationId, periodEnd, ctx);
      expect(renewed.subscription).toMatchObject({ currentPeriodStart: periodEnd, currentPeriodEnd: addMonthUTC(periodEnd) });
    });

    it('5. fully late renewal (past expiry AND past the configured grace window, no back-charging): anchors on now', async () => {
      const periodEnd = new Date('2026-11-01T00:00:00Z');
      const organizationId = await activeSubscription(periodEnd);
      await subs.expire(organizationId, ctx);
      // past periodEnd (Nov 1) AND past the 7-day grace `activate` already precomputed (Nov 8) — genuinely, not just nominally, late.
      const lateAt = new Date(periodEnd.getTime() + 10 * day);
      const renewed = await subs.renew(organizationId, lateAt, ctx);
      expect(renewed.subscription).toMatchObject({ status: 'active', currentPeriodStart: lateAt, currentPeriodEnd: addMonthUTC(lateAt) });
    });

    it('renewing an "expired" row that is STILL inside its precomputed grace window anchors on the period end, not on now: the timestamp, not the possibly-stale status label, is authoritative (section 5)', async () => {
      const periodEnd = new Date('2026-11-01T00:00:00Z');
      const organizationId = await activeSubscription(periodEnd);
      // `expire` is called immediately, before any real time has passed — an artificially premature status change,
      // exactly the kind of staleness a delayed sweeper would also produce in production.
      await subs.expire(organizationId, ctx);
      const stillInGrace = new Date(periodEnd.getTime() + 4 * day); // grace runs Nov 1 -> Nov 8; Nov 5 is inside it
      const renewed = await subs.renew(organizationId, stillInGrace, ctx);
      expect(renewed.subscription).toMatchObject({ status: 'active', currentPeriodStart: periodEnd, currentPeriodEnd: addMonthUTC(periodEnd) });
    });

    it('6. renewal during grace anchors on the ORIGINAL period end, not on now and not on graceUntil, and rolls the grace boundary forward with the new period', async () => {
      const periodEnd = new Date('2026-11-01T00:00:00Z');
      const organizationId = await activeSubscription(periodEnd);
      // `activate` already precomputed graceUntil = periodEnd + the configured 7 days (R1); `enterGrace` only
      // normalizes the status label, it does not (and cannot) choose a timestamp.
      expect((await subs.getByOrganization(organizationId)).graceUntil).toEqual(new Date(periodEnd.getTime() + 7 * day));
      await subs.enterGrace(organizationId, ctx);
      const renewed = await subs.renew(organizationId, new Date(periodEnd.getTime() + 4 * day), ctx);
      const newEnd = addMonthUTC(periodEnd);
      expect(renewed.subscription).toMatchObject({ status: 'active', currentPeriodStart: periodEnd, currentPeriodEnd: newEnd, graceUntil: new Date(newEnd.getTime() + 7 * day) });
    });
  });

  it('7 & 8. grace entry then grace expiry', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    const periodEnd = new Date('2026-11-01T00:00:00Z');
    await subs.activate(organizationId, { start: new Date(periodEnd.getTime() - month), end: periodEnd }, ctx);
    // R1: graceUntil was already computed by `activate`, from the deployment's configured policy — `enterGrace` only
    // flips the status label and touches nothing else.
    const graceUntil = new Date(periodEnd.getTime() + 7 * day);
    const graced = await subs.enterGrace(organizationId, ctx);
    expect(graced.subscription).toMatchObject({ status: 'grace', graceUntil, currentPeriodEnd: periodEnd });

    const expired = await subs.expire(organizationId, ctx);
    expect(expired.subscription).toMatchObject({ status: 'expired', effectiveTerminationAt: null, graceUntil });
  });

  it('enterGrace is refused with no arbitrary caller-supplied timestamp possible: it only normalizes status once a grace window already exists', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    const periodEnd = new Date('2026-11-01T00:00:00Z');
    await subs.activate(organizationId, { start: new Date(periodEnd.getTime() - month), end: periodEnd }, ctx);
    await subs.enterGrace(organizationId, ctx);
    await rejects(subs.enterGrace(organizationId, ctx), 409, 'invalid_subscription_transition'); // already in grace
  });

  it('R1: with no grace configured for this deployment, activation sets no graceUntil, and enterGrace has nothing to normalize into', async () => {
    const noGrace = await createTestApp({ databaseUrl: db.url, env: { SUBSCRIPTION_GRACE_DAYS: '' } });
    try {
      const noGraceSubs = noGrace.app.get(SubscriptionRepository);
      const organizationId = org();
      const { productId, priceId } = await recurringPrice();
      await noGraceSubs.create(organizationId, productId, priceId, ctx);
      const periodEnd = new Date('2026-11-01T00:00:00Z');
      const activated = await noGraceSubs.activate(organizationId, { start: new Date(periodEnd.getTime() - month), end: periodEnd }, ctx);
      expect(activated.subscription.graceUntil).toBeNull();
      await rejects(noGraceSubs.enterGrace(organizationId, ctx), 409, 'subscription_grace_unavailable');
      // the only path left when the period ends is straight to expired — never invented, never client-supplied
      const expired = await noGraceSubs.expire(organizationId, ctx);
      expect(expired.subscription).toMatchObject({ status: 'expired', graceUntil: null });
    } finally {
      await noGrace.app.close();
    }
  });

  it('the database itself refuses graceUntil at or before the period end (section 19), independent of the repository', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    const periodEnd = new Date('2026-11-01T00:00:00Z');
    await subs.activate(organizationId, { start: new Date(periodEnd.getTime() - month), end: periodEnd }, ctx);
    const row = await subs.getByOrganization(organizationId);
    await expect(admin.query(`UPDATE subscription SET status = 'grace', "graceUntil" = "currentPeriodEnd" WHERE id = $1`, [row.id])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE subscription SET status = 'grace', "graceUntil" = "currentPeriodEnd" - interval '1 day' WHERE id = $1`, [row.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('9 & 10. scheduled cancellation, then reversed: already-paid access (currentPeriodEnd) is never touched', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    const periodEnd = new Date('2026-11-01T00:00:00Z');
    await subs.activate(organizationId, { start: new Date(periodEnd.getTime() - month), end: periodEnd }, ctx);

    const scheduled = await subs.scheduleCancellation(organizationId, ctx);
    expect(scheduled).toMatchObject({ changed: true, subscription: { cancelAtPeriodEnd: true, currentPeriodEnd: periodEnd, status: 'active' } });
    const again = await subs.scheduleCancellation(organizationId, ctx); // state-idempotent
    expect(again.changed).toBe(false);

    const reversed = await subs.reverseCancellation(organizationId, ctx);
    expect(reversed).toMatchObject({ changed: true, subscription: { cancelAtPeriodEnd: false, currentPeriodEnd: periodEnd } });
    const againReversed = await subs.reverseCancellation(organizationId, ctx);
    expect(againReversed.changed).toBe(false);
  });

  it('a renewal always starts the new period uncancelled, even if cancellation was scheduled on the old one', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    const periodEnd = new Date('2026-11-01T00:00:00Z');
    await subs.activate(organizationId, { start: new Date(periodEnd.getTime() - month), end: periodEnd }, ctx);
    await subs.scheduleCancellation(organizationId, ctx);
    const renewed = await subs.renew(organizationId, new Date('2026-10-20T00:00:00Z'), ctx);
    expect(renewed.subscription.cancelAtPeriodEnd).toBe(false);
  });

  it('11. administrative termination: active or grace -> expired immediately, shortening (never extending) access; it is set once', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    const periodEnd = new Date(Date.now() + 30 * day);
    await subs.activate(organizationId, { start: new Date(), end: periodEnd }, ctx);

    const terminated = await subs.terminate(organizationId, ctx);
    expect(terminated.subscription.status).toBe('expired');
    expect(terminated.subscription.effectiveTerminationAt).not.toBeNull();
    expect(terminated.subscription.effectiveTerminationAt!.getTime()).toBeLessThanOrEqual(periodEnd.getTime()); // shortened, never extended

    await rejects(subs.terminate(organizationId, ctx), 409, 'invalid_subscription_transition'); // expired cannot be terminated again
    const row = await subs.getByOrganization(organizationId);
    await expect(admin.query(`UPDATE subscription SET "effectiveTerminationAt" = now() WHERE id = $1`, [row.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('a later reactivation clears a past termination, so a SEPARATE termination can happen again on its own terms', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    await subs.activate(organizationId, { start: new Date(), end: new Date(Date.now() + 30 * day) }, ctx);
    await subs.terminate(organizationId, ctx);

    const reactivated = await subs.renew(organizationId, new Date(), ctx); // a late renewal reactivates it
    expect(reactivated.subscription).toMatchObject({ status: 'active', effectiveTerminationAt: null });

    const terminatedAgain = await subs.terminate(organizationId, ctx);
    expect(terminatedAgain.subscription.effectiveTerminationAt).not.toBeNull();
  });

  it('15. invalid transitions are refused with a stable error code: join/renew a pending subscription, or act on one that never existed', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    await rejects(subs.renew(organizationId, new Date(), ctx), 409, 'invalid_subscription_transition');
    await rejects(subs.enterGrace(organizationId, ctx), 409, 'invalid_subscription_transition');
    await rejects(subs.terminate(organizationId, ctx), 409, 'invalid_subscription_transition');
    await rejects(subs.getByOrganization(org()), 404, 'not_found');
  });

  it('every meaningful mutation is auditable: renewal and cancellation toggles each add exactly one history row, at the row’s own new revision', async () => {
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    const periodEnd = new Date('2026-11-01T00:00:00Z');
    await subs.activate(organizationId, { start: new Date(periodEnd.getTime() - month), end: periodEnd }, ctx);
    await subs.scheduleCancellation(organizationId, ctx);
    await subs.renew(organizationId, new Date('2026-10-20T00:00:00Z'), ctx);
    const row = await subs.getByOrganization(organizationId);
    const history = (await admin.query(`SELECT revision, "fromStatus", "toStatus" FROM billing_transition WHERE "entityType"='subscription' AND "entityId"=$1 ORDER BY revision`, [row.id])).rows;
    expect(history.map((h: any) => h.revision)).toEqual([0, 1, 2, 3]);
    expect(row.revision).toBe(3);
  });

  it('tenant isolation: an Organization only ever reaches its OWN subscription (section 37/52)', async () => {
    const orgA = org();
    const orgB = org();
    const a = await recurringPrice();
    const b = await recurringPrice();
    await subs.create(orgA, a.productId, a.priceId, ctx);
    await subs.create(orgB, b.productId, b.priceId, ctx);
    const rowA = await subs.getByOrganization(orgA);
    const rowB = await subs.getByOrganization(orgB);
    expect(rowA.id).not.toBe(rowB.id);
    expect(rowA.organizationId).toBe(orgA);
    expect(rowB.organizationId).toBe(orgB);
    // acting on A never reaches or moves B
    const periodEnd = new Date('2026-11-01T00:00:00Z');
    await subs.activate(orgA, { start: new Date(periodEnd.getTime() - month), end: periodEnd }, ctx);
    expect((await subs.getByOrganization(orgB)).status).toBe('pending');
  });

  it('two organizations can each hold a subscription against the SAME product/price with no interference', async () => {
    const { productId, priceId } = await recurringPrice();
    const orgA = org();
    const orgB = org();
    await subs.create(orgA, productId, priceId, ctx);
    await subs.create(orgB, productId, priceId, ctx);
    expect((await admin.query(`SELECT count(*)::int AS n FROM subscription WHERE "productId" = $1`, [productId])).rows[0].n).toBe(2);
  });

  it('13 & 14. concurrency: two simultaneous renewals never lose purchased time, and a renewal racing a termination ends in one consistent state (real PostgreSQL locking)', async () => {
    const periodEnd = new Date(Date.now() + 30 * day);
    const organizationId = org();
    const { productId, priceId } = await recurringPrice();
    await subs.create(organizationId, productId, priceId, ctx);
    await subs.activate(organizationId, { start: new Date(), end: periodEnd }, ctx);

    // 6 concurrent early renewals against the SAME subscription: row-level locking must serialize them, so no purchased
    // time is lost and every attempt is individually reflected (revision advances by exactly 6, end extends by 6 months).
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 6 }, () => subs.renew(organizationId, now, ctx)));
    expect(results.every((r) => r.changed)).toBe(true);
    const row = await subs.getByOrganization(organizationId);
    expect(row.revision).toBe(7); // create is revision 0 (no UPDATE yet); activate is the first UPDATE (1); 6 renewals (2..7) — none lost
    expect(row.currentPeriodEnd!.getTime()).toBe(addMonthUTC(periodEnd, 6).getTime());

    // a renewal racing a termination: real contention, no lost update, no deadlock — exactly one of the two operation
    // KINDS is the last writer, and the row ends in a single well-formed state either way.
    const raceOrg = org();
    const race = await recurringPrice();
    await subs.create(raceOrg, race.productId, race.priceId, ctx);
    const raceEnd = new Date(Date.now() + 30 * day);
    await subs.activate(raceOrg, { start: new Date(), end: raceEnd }, ctx);
    const settled = await Promise.allSettled([subs.renew(raceOrg, new Date(), ctx), subs.terminate(raceOrg, ctx)]);
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true); // both a renew and a terminate are always legal from `active`
    const final = await subs.getByOrganization(raceOrg);
    expect(['active', 'expired']).toContain(final.status); // whichever ran last, deterministically, under the row lock
    expect(final.revision).toBe(3); // create(0) + activate(1) + exactly 2 more operations, neither lost
  });

  describe('Stage 12.3: deriveEntitlement against a real, repository-loaded row', () => {
    it('a subscription created, activated and read back through the real repository derives entitlement identically to the unit fixtures', async () => {
      const organizationId = org();
      const { productId, priceId } = await recurringPrice();
      await subs.create(organizationId, productId, priceId, ctx);
      const start = new Date('2026-10-01T00:00:00Z');
      const end = new Date('2026-11-01T00:00:00Z');
      await subs.activate(organizationId, { start, end }, ctx);
      const row = await subs.getByOrganization(organizationId); // round-tripped through `pg`: timestamptz -> JS Date
      // `activate` also precomputed graceUntil (the test app's default SUBSCRIPTION_GRACE_DAYS=7), so the row's OWN
      // effective boundary is graceUntil, not currentPeriodEnd — exactly what a real, grace-configured deployment sees.
      expect(row.graceUntil).toEqual(new Date('2026-11-08T00:00:00Z'));

      expect(deriveEntitlement(row, new Date('2026-10-15T00:00:00Z'))).toEqual({ valid: true, expiresAt: row.graceUntil });
      expect(deriveEntitlement(row, end)).toEqual({ valid: true, expiresAt: row.graceUntil }); // still within grace at the paid-period end
      expect(deriveEntitlement(row, row.graceUntil!)).toEqual({ valid: false, expiresAt: null });
    });

    it('a subscription still `active` past its period end, but inside the real repository-computed graceUntil, derives valid — the exact Stage 12.2/12.3 sweeper-independence guarantee, over real PostgreSQL', async () => {
      const organizationId = org();
      const { productId, priceId } = await recurringPrice();
      await subs.create(organizationId, productId, priceId, ctx);
      const start = new Date(Date.now() - 40 * day);
      const end = new Date(Date.now() - 3 * day); // period already ended
      await subs.activate(organizationId, { start, end }, ctx); // graceUntil is precomputed here (7-day test default), status stays 'active'
      const row = await subs.getByOrganization(organizationId);
      expect(row.status).toBe('active');
      expect(row.graceUntil).not.toBeNull();

      const result = deriveEntitlement(row, new Date());
      expect(result).toEqual({ valid: true, expiresAt: row.graceUntil });
    });
  });
});
