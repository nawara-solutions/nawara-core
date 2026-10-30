import { Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import { entitlementAt, type HoldWindow } from '../fraud-holds/fraud-hold-intervals.js';

export interface PersonalSubscriptionRow {
  id: string;
  userId: string;
  platformId: string;
  productId: string;
  createdAt: Date;
}

/** One kept (not reversed) period of the ledger, as K-3 Option D lays it. */
export interface PersonalSpan {
  purchaseId: string;
  effectiveStart: Date;
  effectiveEnd: Date;
}

export interface PersonalEntitlement {
  valid: boolean;
  expiresAt: Date | null;
}

/** The facts of a settled `direct_purchase` (its routing record, its price line and Payment's verified settlement), never a request value. */
export interface SettledPurchase {
  userId: string;
  productId: string;
  priceId: string;
  invoiceId: string;
  paymentRequestId: string;
  receiptId: string;
  /** A Date, or (Core V2 S6g) the database's exact text of an instant it recorded. */
  settledAt: Date | string;
  /** Core V2 S5b (E-12): an assisted purchase names its routing purpose and assistance request (DB-12); a direct purchase names neither. */
  assistanceRequestId?: string | null;
  /**
   * Core V2 S6g (R6G-5, the narrow K-3 exception): an L-4-applied late settlement's application instant. `settledAt` stays Payment's original
   * instant; the period is anchored here instead (never backdated). The database admits it only with that application.
   */
  appliedAt?: Date | string | null;
}

/**
 * Core V2 S3c (ADR-0044 B4, B5, B6): the ONLY writer and reader of `personal_subscription`, `subscription_purchase` and
 * `subscription_purchase_reversal`. A Personal Subscription's validity is the purchase ledger (append-only), laid and re-laid by ONE fold
 * in the database (`billing_personal_spans`, K-3 Option D); nothing here stores or edits a period.
 */
@Injectable()
export class PersonalSubscriptionRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Records one settled direct (or, Core V2 S5b, assisted) purchase, in the CALLER's transaction (the one applying Payment's verified settlement), so the receipt, the
   * invoice and request `paid`, and this purchase commit or roll back together. Ensures the beneficiary's Personal Subscription for the
   * product exists (its Platform is the product's), then appends the purchase; the database checks the evidence (DB-9 / DB-10, the S3b
   * settlement rule) and lays its original span. Purchases of one subscription are serialized (a transaction-scoped advisory lock), so
   * concurrent purchases lay one after the other. An invoice (or receipt) already recorded appends nothing: `recorded: false`.
   */
  async recordPurchase(q: Queryable, p: SettledPurchase): Promise<{ subscription: PersonalSubscriptionRow; recorded: boolean }> {
    await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing.personal_subscription:' || $1 || ':' || $2, 0))`, [p.userId, p.productId]);
    await q.query(
      `INSERT INTO personal_subscription ("userId", "platformId", "productId")
       SELECT $1, pr."platformId", pr.id FROM product pr WHERE pr.id = $2 AND pr."subscriptionTarget" = 'personal'
       ON CONFLICT ("userId", "productId") DO NOTHING`,
      [p.userId, p.productId],
    );
    const subscription = await this.find(q, p.userId, p.productId);
    if (!subscription) throw new Error('personal purchase: the product is not a personal subscription product'); // unreachable: the routing record's FK
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO subscription_purchase ("personalSubscriptionId", "invoiceId", purpose, "beneficiaryUserId", "productId", "priceId", "paymentRequestId", "receiptId",
                                          "settledAt", "originalStart", "originalEnd", "transactionId", "assistanceRequestId", "appliedAt")
       VALUES ($1, $2, $9, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz, $8::timestamptz + interval '1 second', pg_current_xact_id(), $10, $11::timestamptz)
       ON CONFLICT DO NOTHING RETURNING id`,
      [subscription.id, p.invoiceId, p.userId, p.productId, p.priceId, p.paymentRequestId, p.receiptId, p.settledAt,
       p.assistanceRequestId ? 'assisted_settlement' : 'direct_purchase', p.assistanceRequestId ?? null, p.appliedAt ?? null],
    );
    return { subscription, recorded: rows.length === 1 };
  }

  /**
   * B5 (K-3 Option D): records the ONE reversal a purchase may have; the ledger then re-lays later periods (the same fold). A purchase
   * already reversed changes nothing (`reversed: false`): a second cause is the refund / chargeback flows' reconciliation (S6), never a
   * second entitlement change. Called only by those flows (S6); no route reaches it.
   */
  async reversePurchase(q: Queryable, purchaseId: string, cause: 'refund_completion' | 'final_lost_chargeback'): Promise<{ reversed: boolean }> {
    const { rows } = await q.query(
      `INSERT INTO subscription_purchase_reversal ("purchaseId", cause) VALUES ($1, $2) ON CONFLICT ("purchaseId") DO NOTHING RETURNING "purchaseId"`,
      [purchaseId, cause],
    );
    return { reversed: rows.length === 1 };
  }

  /** The kept periods of a Personal Subscription, in ledger order (K-3 Option D). */
  async spans(personalSubscriptionId: string, q: Queryable = this.db): Promise<PersonalSpan[]> {
    const { rows } = await q.query<PersonalSpan>(`SELECT * FROM billing_personal_spans($1)`, [personalSubscriptionId]);
    return rows;
  }

  /**
   * B6: the beneficiary's entitlement to one Platform's personal product at `now` (supplied by the caller): valid while `now` falls in a
   * kept period; `expiresAt` is the end of the uninterrupted run of periods containing `now`. No subscription, or no period covering
   * `now`, is `{ valid: false, expiresAt: null }`. No grace (B13.2).
   */
  async entitlement(userId: string, platformId: string, productId: string, now: Date): Promise<PersonalEntitlement> {
    const subscription = await this.find(this.db, userId, productId);
    if (!subscription || subscription.platformId !== platformId) return { valid: false, expiresAt: null };
    const spans = await this.spans(subscription.id);
    // Core V2 S6e-H (H-1, H-4, C-1): this subscription's fraud holds restrict it from placement to the earlier of release and 14 days
    // (applied here directly, whatever the sweep's delay), and the paid time they denied is compensated after its run
    const holds = await this.holds(this.db, subscription.id);
    if (holds.length === 0) return personalEntitlementAt(spans, now);
    const e = entitlementAt(spans.map((s) => ({ start: s.effectiveStart.getTime(), end: s.effectiveEnd.getTime() })), holds, now.getTime());
    return { valid: e.valid, expiresAt: e.expiresAt === null ? null : new Date(e.expiresAt) };
  }

  /** Core V2 S6e-H: the subscription's holds, each with its effective end (the earlier of its release and its 14-day deadline). */
  async holds(q: Queryable, personalSubscriptionId: string): Promise<HoldWindow[]> {
    const { rows } = await q.query<{ id: string; placedAt: Date; endsAt: Date }>(
      `SELECT h.id, h."placedAt", LEAST(h."expiresAt", COALESCE(r."releasedAt", h."expiresAt")) AS "endsAt"
         FROM fraud_hold h LEFT JOIN fraud_hold_release r ON r."holdId" = h.id WHERE h."personalSubscriptionId" = $1`, [personalSubscriptionId]);
    return rows.map((h) => ({ id: h.id, start: h.placedAt.getTime(), end: h.endsAt.getTime() }));
  }

  /** Whether the product is a personal subscription product of that Platform (the B6 read's 404 otherwise). */
  async isPersonalProduct(platformId: string, productId: string): Promise<boolean> {
    const { rows } = await this.db.query(`SELECT 1 FROM product WHERE id = $1 AND "platformId" = $2 AND "subscriptionTarget" = 'personal'`, [productId, platformId]);
    return rows.length === 1;
  }

  private async find(q: Queryable, userId: string, productId: string): Promise<PersonalSubscriptionRow | null> {
    const { rows } = await q.query<PersonalSubscriptionRow>(`SELECT * FROM personal_subscription WHERE "userId" = $1 AND "productId" = $2`, [userId, productId]);
    return rows[0] ?? null;
  }
}

/** Pure: valid while some kept period contains `now` (half-open); `expiresAt` follows contiguous periods to the end of the run. */
export function personalEntitlementAt(spans: readonly PersonalSpan[], now: Date): PersonalEntitlement {
  const t = now.getTime();
  const sorted = [...spans].sort((a, b) => a.effectiveStart.getTime() - b.effectiveStart.getTime());
  const i = sorted.findIndex((s) => s.effectiveStart.getTime() <= t && t < s.effectiveEnd.getTime());
  if (i === -1) return { valid: false, expiresAt: null };
  let end = sorted[i]!.effectiveEnd;
  for (let j = i + 1; j < sorted.length && sorted[j]!.effectiveStart.getTime() === end.getTime(); j++) end = sorted[j]!.effectiveEnd;
  return { valid: true, expiresAt: end };
}
