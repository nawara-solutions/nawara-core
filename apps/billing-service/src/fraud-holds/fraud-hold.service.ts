import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure, isUniqueViolation, pgConstraint, type DrainOutcome, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { requestTransitionContext, type TransitionContext } from '../domain/actors.js';
import { billingError, notFound } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';
import { OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import type { VerifiedRefundOwner } from '../refunds/refund-owner.guard.js';
import { PersonalSubscriptionRepository } from '../subscriptions/personal-subscription.repository.js';
import { FRAUD_EVIDENCE_FILES, FRAUD_HOLD_RECEIPTS, type FraudEvidenceFiles, type FraudHoldBinding, type FraudHoldReceipts, type ReceiptConsumption } from './fraud-hold-clients.js';
import { deniedByHold } from './fraud-hold-intervals.js';

export const FRAUD_HOLD_REASONS = ['account_takeover', 'stolen_payment_method', 'identity_fraud', 'chargeback_abuse', 'promotion_abuse'] as const;
/** The sweep's system identity (Audit catalog: `fraud_hold.expired`). */
export const FRAUD_HOLD_SWEEP = 'fraud_hold_sweep';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const BATCH = 50;

export interface FraudHoldRow {
  id: string; personalSubscriptionId: string; companyId: string; platformId: string; productId: string; beneficiaryUserId: string; reason: string;
  placedByUserId: string; receiptId: string; placedAt: Date; expiresAt: Date;
}

const invalid = () => billingError(400, 'invalid_fraud_hold_request', BILLING_MESSAGES.invalidFraudHoldRequest);
const unavailable = () => billingError(503, 'fraud_hold_unavailable', BILLING_MESSAGES.fraudHoldUnavailable);
const refused = () => billingError(409, 'fraud_hold_authorization_refused', BILLING_MESSAGES.fraudHoldAuthorizationRefused);
/** The release's receipt `consumeRef`: one per hold (a repeated release reuses it, so Auth answers the same consumption). */
const releaseRef = (holdId: string) => {
  const h = createHash('sha256').update(`billing.fraud_hold.release:${holdId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/**
 * Core V2 S6e-H (register BIL-27; S0 §1.1; OD-10 resolved by the Owner's H-1 to H-7 and compensation option C-1). DEVELOPMENT AND SIMULATION
 * ONLY (the refund module, which mounts it, is never mounted in production; the credentials are refused there too).
 *
 * Placement (H-1 to H-3): the Owner of the seller Company, verified live (`/auth/grants`, and `/auth/platform-access` for the product's
 * Platform), places ONE hold on one beneficiary's Personal subscription to one product of their Company:
 *   - Billing's own rows decide the scope (the subscription, its personal product, its Platform, the Platform's Company);
 *   - every evidence reference is verified live with File: a `fraud_evidence` grant to Billing for exactly this hold (its case), this Company
 *     and this beneficiary, naming the file; nothing else is evidence;
 *   - the operation is authorized only by Auth consuming a `fraud_hold_place` receipt bound to the Company, hold, beneficiary, product and
 *     reason, under the hold's id (a repeat of the same request is answered from Auth's recorded consumption); a refused or unprovable
 *     consumption places nothing;
 *   - then ONE transaction: the hold (the database stamps `placedAt` and its 14-day deadline and refuses a second restricting hold), its
 *     evidence references and the audit intent `fraud_hold.placed`.
 * Release (H-4): the same Owner, with a `fraud_hold_release` receipt, before the deadline; once. The deadline itself ends the restriction
 * (entitlement reads apply it directly); the sweep only records it (`fraud_hold.expired`) and posts each ended hold's compensation evidence.
 * Holds never block or change a financial command (H-6).
 */
@Injectable()
export class FraudHoldService {
  private readonly log = new Logger('BillingFraudHolds');
  private readonly loop = new PollLoop(
    () => this.sweepOnce(),
    (e) => this.log.error(`fraud_hold_sweep_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.log.warn(`worker_drain_timeout worker=fraud_hold_sweep drainTimeoutMs=${ms} — resumed after restart`),
  );
  private sweeping = false;

  constructor(
    private readonly db: DbService,
    private readonly audit: BillingAudit,
    private readonly personal: PersonalSubscriptionRepository,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    @Inject(OWNER_AUTHORITY) private readonly owners: OwnerAuthority,
    @Inject(FRAUD_HOLD_RECEIPTS) private readonly receipts: FraudHoldReceipts,
    @Inject(FRAUD_EVIDENCE_FILES) private readonly files: FraudEvidenceFiles,
  ) {}

  start(intervalMs = 60_000): void {
    this.loop.start(intervalMs);
  }

  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  private deadline() {
    return AbortSignal.timeout(this.config.authTimeoutMs);
  }

  private ownerContext(owner: VerifiedRefundOwner): TransitionContext {
    return requestTransitionContext({ type: 'user', id: owner.userId, userKind: 'owner' });
  }

  /** BIL-27: `POST /billing/admin/fraud-holds`. */
  async place(owner: VerifiedRefundOwner, input: Record<string, unknown>): Promise<{ hold: FraudHoldRow; created: boolean }> {
    const holdId = typeof input.holdId === 'string' ? input.holdId.toLowerCase() : '';
    const beneficiaryUserId = typeof input.beneficiaryUserId === 'string' ? input.beneficiaryUserId.toLowerCase() : '';
    const productId = typeof input.productId === 'string' ? input.productId.toLowerCase() : '';
    const reason = input.reason;
    const evidence = Array.isArray(input.evidence) ? (input.evidence as Record<string, unknown>[]) : [];
    if (![holdId, beneficiaryUserId, productId].every((v) => UUID.test(v)) || typeof reason !== 'string' || !(FRAUD_HOLD_REASONS as readonly string[]).includes(reason)
      || evidence.length < 1 || evidence.length > 5 || typeof input.receiptSecret !== 'string' || !SECRET.test(input.receiptSecret)
      || evidence.some((e) => !e || typeof e.grantId !== 'string' || !UUID.test(e.grantId) || typeof e.fileId !== 'string' || !UUID.test(e.fileId))) throw invalid();
    const refs = evidence.map((e) => ({ grantId: (e.grantId as string).toLowerCase(), fileId: (e.fileId as string).toLowerCase() }));
    if (new Set(refs.map((r) => r.grantId)).size !== refs.length || new Set(refs.map((r) => r.fileId)).size !== refs.length) throw invalid();

    const existing = await this.byId(this.db, holdId);
    if (existing) {
      if (existing.companyId !== owner.companyId) throw notFound();
      if (existing.beneficiaryUserId !== beneficiaryUserId || existing.productId !== productId || existing.reason !== reason) {
        throw billingError(409, 'fraud_hold_conflict', BILLING_MESSAGES.fraudHoldConflict);
      }
      return { hold: existing, created: false };
    }
    // the scope, from Billing's own rows, then live from Auth: a personal product of a Platform of the Owner's Company
    const sub = (await this.db.query<{ id: string; platformId: string }>(
      `SELECT s.id, s."platformId" FROM personal_subscription s JOIN product p ON p.id = s."productId" JOIN billing_platform b ON b."platformId" = p."platformId"
        WHERE s."userId" = $1 AND s."productId" = $2 AND p."subscriptionTarget" = 'personal' AND b."companyId" = $3`, [beneficiaryUserId, productId, owner.companyId])).rows[0];
    if (!sub || !(await this.owners.platformAllowed(owner.bearer, sub.platformId, this.deadline()))) throw notFound();
    if (await this.restricting(this.db, sub.id)) throw billingError(409, 'fraud_hold_active', BILLING_MESSAGES.fraudHoldActive);
    // H-3: every reference is a live `fraud_evidence` grant to Billing for exactly this hold, Company and beneficiary
    for (const r of refs) {
      let g;
      try {
        g = await this.files.granted(r.grantId, r.fileId, this.deadline());
      } catch {
        throw billingError(503, 'fraud_evidence_unavailable', BILLING_MESSAGES.fraudEvidenceUnavailable);
      }
      if (!g || g.grantId !== r.grantId || g.fileId !== r.fileId || g.purpose !== 'fraud_evidence' || g.caseRef !== holdId || g.companyId !== owner.companyId
        || g.subjectUserId !== beneficiaryUserId) throw billingError(422, 'fraud_evidence_invalid', BILLING_MESSAGES.fraudEvidenceInvalid);
    }
    const binding: FraudHoldBinding = { operation: 'fraud_hold_place', audience: 'billing-service', companyId: owner.companyId, holdId, beneficiaryUserId, productId, reason };
    const consumption = await this.consume(binding, input.receiptSecret, holdId, owner);
    try {
      const hold = await this.db.tx(async (q) => {
        const raced = await this.byId(q, holdId);
        if (raced) return raced;
        const h = (await q.query<FraudHoldRow>(
          `INSERT INTO fraud_hold (id, "personalSubscriptionId", "companyId", "platformId", "productId", "beneficiaryUserId", reason, "placedByUserId", "receiptId", "placedAt", "expiresAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now() + interval '14 days') RETURNING *`,
          [holdId, sub.id, owner.companyId, sub.platformId, productId, beneficiaryUserId, reason, owner.userId, consumption.receiptId])).rows[0]!;
        for (const r of refs) await q.query(`INSERT INTO fraud_hold_evidence ("holdId", "grantId", "fileId") VALUES ($1, $2, $3)`, [holdId, r.grantId, r.fileId]);
        await this.audit.record(q, 'fraud_hold.placed', { organizationId: null, resource: { type: 'fraud_hold', id: holdId }, changes: { product_id: productId, reason: reason as never } }, this.ownerContext(owner));
        return h;
      });
      this.log.log(`fraud_hold_placed hold=${holdId} subscription=${sub.id} reason=${reason}`);
      return { hold, created: true };
    } catch (e) {
      if (pgConstraint(e) === 'fraud_hold_active') throw billingError(409, 'fraud_hold_active', BILLING_MESSAGES.fraudHoldActive); // a concurrent hold won
      if (isUniqueViolation(e)) throw billingError(409, 'fraud_hold_conflict', BILLING_MESSAGES.fraudHoldConflict); // the evidence grant is another hold's
      throw e;
    }
  }

  /** BIL-27: `POST /billing/admin/fraud-holds/:id/release`. */
  async release(owner: VerifiedRefundOwner, holdId: string, input: Record<string, unknown>): Promise<{ hold: FraudHoldRow; created: boolean }> {
    if (!UUID.test(holdId)) throw notFound();
    if (typeof input.receiptSecret !== 'string' || !SECRET.test(input.receiptSecret)) throw invalid();
    const h = await this.byId(this.db, holdId);
    if (!h || h.companyId !== owner.companyId || !(await this.owners.platformAllowed(owner.bearer, h.platformId, this.deadline()))) throw notFound();
    if ((await this.db.query(`SELECT 1 FROM fraud_hold_release WHERE "holdId" = $1`, [holdId])).rows.length > 0) return { hold: h, created: false };
    const now = (await this.db.query<{ now: Date }>(`SELECT clock_timestamp() AS now`)).rows[0]!.now;
    if (now >= h.expiresAt) throw billingError(409, 'fraud_hold_not_active', BILLING_MESSAGES.fraudHoldNotActive);
    const binding: FraudHoldBinding = { operation: 'fraud_hold_release', audience: 'billing-service', companyId: owner.companyId, holdId, beneficiaryUserId: h.beneficiaryUserId, productId: h.productId };
    const consumption = await this.consume(binding, input.receiptSecret, releaseRef(holdId), owner);
    try {
      await this.db.tx(async (q) => {
        if ((await q.query(`SELECT 1 FROM fraud_hold_release WHERE "holdId" = $1`, [holdId])).rows.length > 0) return;
        await q.query(`INSERT INTO fraud_hold_release ("holdId", "releasedAt", "releasedByUserId", "receiptId") VALUES ($1, now(), $2, $3)`, [holdId, owner.userId, consumption.receiptId]);
        await this.audit.record(q, 'fraud_hold.released', { organizationId: null, resource: { type: 'fraud_hold', id: holdId }, changes: { product_id: h.productId } }, this.ownerContext(owner));
      });
    } catch (e) {
      if (pgConstraint(e) === 'fraud_hold_not_active') throw billingError(409, 'fraud_hold_not_active', BILLING_MESSAGES.fraudHoldNotActive);
      throw e;
    }
    this.log.log(`fraud_hold_released hold=${holdId}`);
    return { hold: h, created: true };
  }

  /** Auth consumes the receipt for exactly this binding, under `consumeRef`; anything but a provable consumption by this Owner changes nothing. */
  private async consume(binding: FraudHoldBinding, secret: string, consumeRef: string, owner: VerifiedRefundOwner): Promise<ReceiptConsumption> {
    let out;
    try {
      out = await this.receipts.consume({ secret, binding, consumeRef });
      if (out.kind === 'unresolved') {
        const found = await this.receipts.lookup({ binding, consumeRef }).catch(() => null);
        if (found) out = { kind: 'consumed' as const, consumption: found };
      }
    } catch {
      throw unavailable();
    }
    if (out.kind === 'refused') throw refused();
    if (out.kind === 'unresolved') throw billingError(503, 'fraud_hold_authorization_unresolved', BILLING_MESSAGES.fraudHoldAuthorizationUnresolved);
    if (out.consumption.approvedByUserId !== owner.userId) throw refused(); // the receipt's issuer must be the Owner who asks
    return out.consumption;
  }

  /** A hold of the Owner's Company, with its evidence, termination and compensation evidence; the collapsed 404 otherwise. */
  async read(owner: VerifiedRefundOwner, holdId: string) {
    if (!UUID.test(holdId)) throw notFound();
    const h = await this.byId(this.db, holdId);
    if (!h || h.companyId !== owner.companyId || !(await this.owners.platformAllowed(owner.bearer, h.platformId, this.deadline()))) throw notFound();
    const [evidence, release, expiry, compensation, now] = await Promise.all([
      this.db.query(`SELECT "grantId", "fileId", "verifiedAt" FROM fraud_hold_evidence WHERE "holdId" = $1 ORDER BY "verifiedAt", "fileId"`, [holdId]).then((r) => r.rows),
      this.db.query(`SELECT "releasedAt", "releasedByUserId" FROM fraud_hold_release WHERE "holdId" = $1`, [holdId]).then((r) => r.rows[0] ?? null),
      this.db.query(`SELECT "expiredAt", "recordedAt" FROM fraud_hold_expiry WHERE "holdId" = $1`, [holdId]).then((r) => r.rows[0] ?? null),
      this.db.query(`SELECT "deniedMs", "holdEndedAt", "computedAt" FROM fraud_hold_compensation WHERE "holdId" = $1`, [holdId]).then((r) => r.rows[0] ?? null),
      this.db.query<{ now: Date }>(`SELECT clock_timestamp() AS now`).then((r) => r.rows[0]!.now),
    ]);
    const endsAt: Date = release ? (release.releasedAt as Date) : h.expiresAt;
    return { hold: h, evidence, release, expiry, compensation, endsAt, state: release ? 'released' : now >= h.expiresAt ? 'expired' : 'active' };
  }

  /**
   * One sweep pass (also for tests): (1) records each hold that reached its deadline unreleased (`fraud_hold.expired`, the system actor);
   * (2) posts each ended hold's compensation evidence once (C-1: the paid time it denied, net of earlier holds, over the CURRENT ledger).
   * Both are idempotent (primary keys), so concurrent or repeated passes and a crash between them change nothing twice.
   */
  async sweepOnce(): Promise<{ expired: number; compensated: number }> {
    if (this.sweeping) return { expired: 0, compensated: 0 };
    this.sweeping = true;
    try {
      const tally = { expired: 0, compensated: 0 };
      const due = (await this.db.query<{ id: string }>(
        `SELECT h.id FROM fraud_hold h WHERE h."expiresAt" <= clock_timestamp()
            AND NOT EXISTS (SELECT 1 FROM fraud_hold_release r WHERE r."holdId" = h.id) AND NOT EXISTS (SELECT 1 FROM fraud_hold_expiry x WHERE x."holdId" = h.id)
          ORDER BY h."expiresAt", h.id LIMIT $1`, [BATCH])).rows;
      for (const d of due) {
        try {
          if (await this.expire(d.id)) tally.expired++;
        } catch (e) {
          this.log.warn(`fraud_hold_expiry_retry hold=${d.id} ${describeFailure(e)}`);
        }
      }
      const ended = (await this.db.query<{ id: string }>(
        `SELECT h.id FROM fraud_hold h LEFT JOIN fraud_hold_release r ON r."holdId" = h.id
          WHERE LEAST(h."expiresAt", COALESCE(r."releasedAt", h."expiresAt")) <= clock_timestamp()
            AND NOT EXISTS (SELECT 1 FROM fraud_hold_compensation c WHERE c."holdId" = h.id)
          ORDER BY h."placedAt", h.id LIMIT $1`, [BATCH])).rows;
      for (const d of ended) {
        try {
          if (await this.postCompensation(d.id)) tally.compensated++;
        } catch (e) {
          this.log.warn(`fraud_hold_compensation_retry hold=${d.id} ${describeFailure(e)}`);
        }
      }
      return tally;
    } finally {
      this.sweeping = false;
    }
  }

  private async expire(holdId: string): Promise<boolean> {
    const ctx: TransitionContext = { actor: { type: 'system', id: FRAUD_HOLD_SWEEP }, cause: { type: 'sweep', id: holdId }, correlationId: `fraud-hold:${holdId}` };
    return this.db.tx(async (q) => {
      const ins = await q.query(`INSERT INTO fraud_hold_expiry ("holdId", "expiredAt") SELECT $1, "expiresAt" FROM fraud_hold WHERE id = $1 ON CONFLICT ("holdId") DO NOTHING RETURNING "holdId"`, [holdId]);
      if (ins.rows.length === 0) return false;
      const h = (await this.byId(q, holdId))!;
      await this.audit.record(q, 'fraud_hold.expired', { organizationId: null, resource: { type: 'fraud_hold', id: holdId }, changes: { product_id: h.productId } }, ctx);
      this.log.log(`fraud_hold_expired hold=${holdId}`);
      return true;
    });
  }

  private async postCompensation(holdId: string): Promise<boolean> {
    return this.db.tx(async (q) => {
      const h = (await this.byId(q, holdId))!;
      await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing.fraud_hold:' || $1, 0))`, [h.personalSubscriptionId]);
      if ((await q.query(`SELECT 1 FROM fraud_hold_compensation WHERE "holdId" = $1`, [holdId])).rows.length > 0) return false;
      const spans = await this.personal.spans(h.personalSubscriptionId, q);
      const holds = await this.personal.holds(q, h.personalSubscriptionId);
      const self = holds.find((x) => x.id === holdId)!;
      const denied = deniedByHold(spans.map((s) => ({ start: s.effectiveStart.getTime(), end: s.effectiveEnd.getTime() })), holds).get(holdId) ?? 0;
      await q.query(`INSERT INTO fraud_hold_compensation ("holdId", "personalSubscriptionId", "deniedMs", "holdEndedAt") VALUES ($1, $2, $3, $4)`,
        [holdId, h.personalSubscriptionId, denied, new Date(self.end)]);
      this.log.log(`fraud_hold_compensation_recorded hold=${holdId} deniedMs=${denied}`);
      return true;
    });
  }

  private async restricting(q: Queryable, personalSubscriptionId: string): Promise<boolean> {
    return (await q.query(
      `SELECT 1 FROM fraud_hold h LEFT JOIN fraud_hold_release r ON r."holdId" = h.id
        WHERE h."personalSubscriptionId" = $1 AND LEAST(h."expiresAt", COALESCE(r."releasedAt", h."expiresAt")) > clock_timestamp()`, [personalSubscriptionId])).rows.length > 0;
  }

  private async byId(q: Queryable, id: string): Promise<FraudHoldRow | undefined> {
    return (await q.query<FraudHoldRow>(`SELECT * FROM fraud_hold WHERE id = $1`, [id])).rows[0];
  }
}

@Injectable()
export class FraudHoldSweepService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly holds: FraudHoldService) {}
  onApplicationBootstrap(): void {
    this.holds.start();
  }
  onModuleDestroy(): void {
    void this.holds.stop();
  }
  async beforeApplicationShutdown(): Promise<void> {
    await this.holds.stop();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.holds.stop();
  }
}
