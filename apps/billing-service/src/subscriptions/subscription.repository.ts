import { Inject, Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import type { TransitionContext } from '../domain/actors.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { billingError, notFound } from '../domain/errors.js';
import { renewalAnchor } from '../domain/subscription-period.js';
import { recordTransition } from '../domain/transitions.js';
import type { SubscriptionRow } from './subscription.types.js';

export interface SubscriptionWriteResult {
  subscription: SubscriptionRow;
  /** false when the current row already reflected the requested change: nothing was written (state idempotency). */
  changed: boolean;
}

/**
 * The ONLY writer of `subscription` (mirrors `InvoiceRepository`). Scope is always `organizationId` (section 37): there
 * is no `findCurrent()`/`byId()` with no tenant context. Every domain operation is one transaction that locks the row
 * (`SELECT ... FOR UPDATE`) before deciding anything from it — the same lock-then-decide-then-write pattern
 * `PaymentRequestRepository` uses (section 35/36) — so two concurrent operations on the same Organization always
 * serialize on the row lock and the second always computes its result from the first's already-committed change.
 * There is no generic `updateSubscription(patch)` (section 32): every write path below is one named, guarded operation.
 */
@Injectable()
export class SubscriptionRepository {
  constructor(
    private readonly db: DbService,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  /**
   * Creates the `pending` row for an Organization, for THIS product/price — not a generic "ensure any subscription
   * exists" (R3). Idempotent only for an identical replay: the SAME organization asking for the SAME product/price
   * again returns the existing row unchanged (`changed: false`). An organization that already has a subscription to a
   * DIFFERENT product or price is a genuine conflicting commercial intent, not the same logical request, and is
   * refused rather than silently answered with whichever offering happened to exist first — `create` is never a
   * disguised upgrade/downgrade (that remains a deliberately unimplemented, explicit future operation).
   */
  async create(organizationId: string, productId: string, priceId: string, ctx: TransitionContext): Promise<SubscriptionWriteResult> {
    return this.db.tx((q) => this.createTx(q, organizationId, productId, priceId, ctx));
  }

  /** The composable core of `create` (Stage 12.4): callable from within an ALREADY-OPEN transaction (`applySuccessfulPayment`), never opening its own. */
  private async createTx(q: Queryable, organizationId: string, productId: string, priceId: string, ctx: TransitionContext): Promise<SubscriptionWriteResult> {
    // ON CONFLICT DO NOTHING: a concurrent create never raises the unique violation, so the loser simply reads the winner's row.
    const res = await q.query<SubscriptionRow>(
      `INSERT INTO subscription ("organizationId", "productId", "priceId") VALUES ($1, $2, $3)
       ON CONFLICT ("organizationId") DO NOTHING RETURNING *`,
      [organizationId, productId, priceId],
    );
    const inserted = res.rows[0];
    if (inserted) {
      await recordTransition(q, { entityType: 'subscription', entityId: inserted.id, from: null, to: 'pending', revision: inserted.revision, ctx });
      return { subscription: inserted, changed: true };
    }
    const existing = await this.findByOrganization(q, organizationId);
    if (!existing) throw billingError(409, 'subscription_conflict', 'The subscription request conflicts with another request.');
    if (existing.productId !== productId || existing.priceId !== priceId) {
      throw billingError(409, 'subscription_conflict', 'This organization already has a subscription to a different product or price.');
    }
    return { subscription: existing, changed: false };
  }

  /**
   * `pending -> active`: the first paid period. `end` must be strictly after `start` (the database CHECK is the
   * unreachable backstop). Precomputes `graceUntil` (R1) from the deployment's configured grace policy — never from a
   * caller — in the SAME statement, so it is a trustworthy timestamp from the moment the period exists, not only once
   * some later sweeper gets around to calling `enterGrace`.
   */
  async activate(organizationId: string, period: { start: Date; end: Date }, ctx: TransitionContext): Promise<SubscriptionWriteResult> {
    if (period.end.getTime() <= period.start.getTime()) throw billingError(400, 'invalid_subscription_period', 'currentPeriodEnd must be after currentPeriodStart.');
    return this.db.tx(async (q) => {
      const row = await this.lock(q, organizationId);
      if (row.status !== 'pending') throw billingError(409, 'invalid_subscription_transition', `A subscription that is ${row.status} cannot be activated.`);
      const graceDays = this.config.subscriptionGraceDays ?? null;
      const { rows } = await q.query<SubscriptionRow>(
        `UPDATE subscription SET status = 'active', "currentPeriodStart" = $2, "currentPeriodEnd" = $3,
                "graceUntil" = CASE WHEN $4::int IS NULL THEN NULL ELSE (($3::timestamptz AT TIME ZONE 'UTC') + ($4::int || ' days')::interval) AT TIME ZONE 'UTC' END
           WHERE id = $1 RETURNING *`,
        [row.id, period.start, period.end, graceDays],
      );
      const updated = rows[0]!;
      await this.record(q, row, updated, ctx);
      return { subscription: updated, changed: true };
    });
  }

  /**
   * Applies a successful commercial renewal (early, on-time, during grace, or fully late — sections 22-25): the ONE
   * operation for all of them, because the anchor rule (`renewalAnchor`) already accounts for every case from the row's
   * OWN currently-locked state. Always ends in `active`. Refused only for a `pending` subscription, which has never
   * been activated and has no period to renew (`activate` is the first step).
   */
  async renew(organizationId: string, now: Date, ctx: TransitionContext): Promise<SubscriptionWriteResult> {
    return this.db.tx((q) => this.renewTx(q, organizationId, now, ctx));
  }

  /** The composable core of `renew` (Stage 12.4): callable from within an ALREADY-OPEN transaction. */
  private async renewTx(q: Queryable, organizationId: string, now: Date, ctx: TransitionContext): Promise<SubscriptionWriteResult> {
    const row = await this.lock(q, organizationId);
    if (row.status === 'pending') throw billingError(409, 'invalid_subscription_transition', 'A pending subscription must be activated before it can be renewed.');
    const anchor = renewalAnchor({ currentPeriodEnd: row.currentPeriodEnd!, graceUntil: row.graceUntil }, now);
    return this.rollPeriod(q, row, anchor, ctx);
  }

  /**
   * Rolls a subscription's period forward to start at `anchor`, extending by its own price's recurring interval, and
   * recomputing `graceUntil` from the configured policy (R1) — the one place that actually performs this UPDATE.
   * `renewTx` computes `anchor` via the frozen renewal-anchor rule; `applySuccessfulPayment`'s first-activation branch
   * uses the authoritative settlement instant directly as `anchor` instead (there is no prior period to anchor from).
   * Either way this is the SAME move the database allows from `pending`, `active`, `grace` or `expired` alike.
   */
  private async rollPeriod(q: Queryable, row: SubscriptionRow, anchor: Date, ctx: TransitionContext): Promise<SubscriptionWriteResult> {
    const graceDays = this.config.subscriptionGraceDays ?? null;
    // Calendar arithmetic (month/year/days) on a `timestamptz` is otherwise done in the SESSION's TimeZone, which
    // could shift the result across a DST boundary (section 17: server/database UTC semantics, never a local
    // clock). The `AT TIME ZONE 'UTC'` round trips force every addition to happen in UTC wall-clock time, with no
    // DST. `graceUntil` is recomputed from the NEW `currentPeriodEnd` here too (R1): every roll forward carries the
    // grace boundary forward with it, in the same statement, so it is never stale relative to the new period
    // (`subscription_grace_after_period` would refuse the write outright if it ever were).
    const { rows } = await q.query<SubscriptionRow>(
      `UPDATE subscription s SET status = 'active', "currentPeriodStart" = calc."newStart", "currentPeriodEnd" = calc."newEnd",
              "graceUntil" = CASE WHEN $3::int IS NULL THEN NULL ELSE (calc."newEnd" AT TIME ZONE 'UTC' + ($3::int || ' days')::interval) AT TIME ZONE 'UTC' END
         FROM (
           SELECT $2::timestamptz AS "newStart",
                  (($2::timestamptz AT TIME ZONE 'UTC') + (p."intervalCount" || ' ' || p."intervalUnit")::interval) AT TIME ZONE 'UTC' AS "newEnd"
             FROM price p WHERE p.id = (SELECT "priceId" FROM subscription WHERE id = $1)
         ) calc
         WHERE s.id = $1 RETURNING s.*`,
      [row.id, anchor, graceDays],
    );
    const updated = rows[0]!;
    await this.record(q, row, updated, ctx);
    return { subscription: updated, changed: true };
  }

  /**
   * Stage 12.4: applies an authoritative, already-validated successful settlement to the Organization's Subscription,
   * within the CALLER's own transaction (`q`) — never opening its own, so the receipt, the PaymentRequest/Invoice
   * transition and this Subscription effect commit or roll back as one unit (section 15). Ensures the subscription
   * exists for this exact `(organizationId, productId, priceId)` offering (idempotent; throws `subscription_conflict`
   * if the organization already has a DIFFERENT offering — never a silent, disguised upgrade), then either performs
   * the FIRST activation (anchored on `settledAt` itself, since there is no prior period to compare against) or a
   * normal renewal (anchored per the frozen rule against whatever period/grace the row already has) — the same
   * `rollPeriod` primitive either way, so period/grace arithmetic is never duplicated here.
   */
  async applySuccessfulPayment(
    q: Queryable,
    params: { organizationId: string; productId: string; priceId: string; settledAt: Date },
    ctx: TransitionContext,
  ): Promise<SubscriptionWriteResult> {
    await this.createTx(q, params.organizationId, params.productId, params.priceId, ctx); // idempotent; conflict on offering mismatch
    const row = await this.lock(q, params.organizationId); // re-read UNDER LOCK: createTx's own "existing" read is not locked
    const anchor = row.status === 'pending' ? params.settledAt : renewalAnchor({ currentPeriodEnd: row.currentPeriodEnd!, graceUntil: row.graceUntil }, params.settledAt);
    return this.rollPeriod(q, row, anchor, ctx);
  }

  /**
   * `active -> grace`: normalizes the STATUS LABEL once `currentPeriodEnd` has passed. It does not set `graceUntil` —
   * that boundary was already precomputed by `activate`/`renew` from the deployment's configured grace policy (R1), so
   * this is a pure reporting/consistency move a future sweeper would call, never the source of the grace timestamp
   * itself. Refused when this subscription has no grace window at all (no `SUBSCRIPTION_GRACE_DAYS` configured when its
   * current period was established): there is nothing to normalize into, and it should go straight to `expire`.
   */
  async enterGrace(organizationId: string, ctx: TransitionContext): Promise<SubscriptionWriteResult> {
    return this.db.tx(async (q) => {
      const row = await this.lock(q, organizationId);
      if (row.status !== 'active') throw billingError(409, 'invalid_subscription_transition', `A subscription that is ${row.status} cannot enter grace.`);
      if (row.graceUntil === null) throw billingError(409, 'subscription_grace_unavailable', 'This subscription has no grace window to enter.');
      const updated = await this.update(q, row.id, '', [], 'grace');
      await this.record(q, row, updated, ctx);
      return { subscription: updated, changed: true };
    });
  }

  /** `active | grace -> expired`: the paid period (and any grace) has fully elapsed with no renewal. Purely a fact about time; no `effectiveTerminationAt`. */
  async expire(organizationId: string, ctx: TransitionContext): Promise<SubscriptionWriteResult> {
    return this.db.tx(async (q) => {
      const row = await this.lock(q, organizationId);
      if (row.status !== 'active' && row.status !== 'grace') throw billingError(409, 'invalid_subscription_transition', `A subscription that is ${row.status} cannot expire.`);
      const updated = await this.update(q, row.id, '', [], 'expired');
      await this.record(q, row, updated, ctx);
      return { subscription: updated, changed: true };
    });
  }

  /** `active -> active`: the customer will not be renewed at period end. Already-paid access is untouched (section 21). State-idempotent. */
  async scheduleCancellation(organizationId: string, ctx: TransitionContext): Promise<SubscriptionWriteResult> {
    return this.setCancellation(organizationId, true, ctx);
  }

  /** `active -> active`: reverses a scheduled cancellation before it takes effect. State-idempotent. */
  async reverseCancellation(organizationId: string, ctx: TransitionContext): Promise<SubscriptionWriteResult> {
    return this.setCancellation(organizationId, false, ctx);
  }

  private async setCancellation(organizationId: string, cancelAtPeriodEnd: boolean, ctx: TransitionContext): Promise<SubscriptionWriteResult> {
    return this.db.tx(async (q) => {
      const row = await this.lock(q, organizationId);
      if (row.status !== 'active') throw billingError(409, 'invalid_subscription_transition', `A subscription that is ${row.status} cannot change its cancellation.`);
      if (row.cancelAtPeriodEnd === cancelAtPeriodEnd) return { subscription: row, changed: false };
      const updated = await this.update(q, row.id, `"cancelAtPeriodEnd" = $2`, [cancelAtPeriodEnd], 'active');
      await this.record(q, row, updated, ctx);
      return { subscription: updated, changed: true };
    });
  }

  /**
   * Administrative, immediate termination (section 20): `active | grace -> expired`, right now, regardless of how much
   * paid time or grace remained. `effectiveTerminationAt` is always the database's own `now()`, never a caller-supplied
   * timestamp (section 31) — the period-shortening-only CHECK is therefore always satisfied by construction.
   */
  async terminate(organizationId: string, ctx: TransitionContext): Promise<SubscriptionWriteResult> {
    return this.db.tx(async (q) => {
      const row = await this.lock(q, organizationId);
      if (row.status !== 'active' && row.status !== 'grace') throw billingError(409, 'invalid_subscription_transition', `A subscription that is ${row.status} cannot be terminated.`);
      const { rows } = await q.query<SubscriptionRow>(
        `UPDATE subscription SET status = 'expired', "effectiveTerminationAt" = now() WHERE id = $1 RETURNING *`,
        [row.id],
      );
      const updated = rows[0]!;
      await this.record(q, row, updated, ctx);
      return { subscription: updated, changed: true };
    });
  }

  /** Tenant-scoped read: the caller always names the Organization (section 37). */
  async findByOrganization(q: Queryable, organizationId: string): Promise<SubscriptionRow | null> {
    const { rows } = await q.query<SubscriptionRow>(`SELECT * FROM subscription WHERE "organizationId" = $1`, [organizationId]);
    return rows[0] ?? null;
  }

  async getByOrganization(organizationId: string): Promise<SubscriptionRow> {
    const row = await this.findByOrganization(this.db, organizationId);
    if (!row) throw notFound();
    return row;
  }

  private async lock(q: Queryable, organizationId: string): Promise<SubscriptionRow> {
    const { rows } = await q.query<SubscriptionRow>(`SELECT * FROM subscription WHERE "organizationId" = $1 FOR UPDATE`, [organizationId]);
    const row = rows[0];
    if (!row) throw notFound();
    return row;
  }

  private async update(q: Queryable, id: string, extraSet: string, extraParams: unknown[], status: SubscriptionRow['status']): Promise<SubscriptionRow> {
    const { rows } = await q.query<SubscriptionRow>(
      `UPDATE subscription SET status = $1${extraSet ? `, ${extraSet}` : ''} WHERE id = $${extraParams.length + 2} RETURNING *`,
      [status, ...extraParams, id],
    );
    return rows[0]!;
  }

  private async record(q: Queryable, from: SubscriptionRow, to: SubscriptionRow, ctx: TransitionContext): Promise<void> {
    await recordTransition(q, { entityType: 'subscription', entityId: to.id, from: from.status, to: to.status, revision: to.revision, ctx });
  }
}
