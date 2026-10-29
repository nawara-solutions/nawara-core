import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure, pgConstraint, type AuthIdentity, type DrainOutcome, type Queryable } from '@nawara/service-kit';
import { AssistanceAuthority } from '../assistance/assistance-authority.js';
import { AssistanceCommandIdempotency, type AssistanceCommandResult } from '../assistance/assistance-idempotency.js';
import { lockOrganization } from '../assistance/assistance-restrictions.js';
import { BillingAudit } from '../audit/billing-audit.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import { RECOVERY_PRODUCER, type BillingConfig } from '../config/billing-config.js';
import type { Caller, TransitionContext } from '../domain/actors.js';
import { billingError, notFound, operationNotPermitted } from '../domain/errors.js';
import { normaliseCreateInvoiceInput } from '../domain/invoice-input.js';
import { SYSTEM_TEMPLATE_V1 } from '../domain/snapshots.js';
import { FRAUD_EVIDENCE_FILES, FRAUD_HOLD_RECEIPTS, type FraudEvidenceFiles, type FraudHoldBinding, type FraudHoldReceipts, type ReceiptConsumption } from '../fraud-holds/fraud-hold-clients.js';
import { InvoiceRepository } from '../invoices/invoice.repository.js';
import { PaymentRequestRepository } from '../invoices/payment-request.repository.js';
import { BILLING_MESSAGES } from '../messages.js';
import { OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import type { VerifiedRefundOwner } from '../refunds/refund-owner.guard.js';

/** The worker's system identity (Audit catalog: `recovery_obligation.opened`). */
export const RECOVERY_WORKER = 'recovery_worker';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const BATCH = 50;

/**
 * The Auth consumption reference of one Path B record: derived from the surplus and the receipt secret (one-way; the secret itself is never
 * sent anywhere but Auth's consume body, never stored or logged). The same request repeated keeps its reference (Auth answers the same
 * consumption, or AUTH-03 finds it); another receipt gets its own, so a refused receipt never blocks the surplus.
 */
export function surplusConsumeRef(surplusId: string, secret: string): string {
  const h = createHash('sha256').update(`billing.recovery_surplus_external\0${surplusId}\0${secret}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface ObligationRow {
  id: string; disputeId: string; assistanceRequestId: string; purchaseId: string; organizationId: string; companyId: string; platformId: string;
  baseAmount: string; currency: string; status: 'open' | 'recovered'; openedAt: Date; recoveredAt: Date | null;
}

const closed = () => billingError(409, 'recovery_obligation_closed', BILLING_MESSAGES.recoveryObligationClosed);
const channelOpen = () => billingError(409, 'settlement_channel_open', BILLING_MESSAGES.settlementChannelOpen);
const invalid = () => billingError(400, 'invalid_recovery_request', BILLING_MESSAGES.invalidRecoveryRequest);

/**
 * Core V2 S6f (register BIL-26 (T3), BIL-28 to BIL-31; ADR-0044 B8, B10; S0 §3.5, FC-9; the Owner's R6F-1 to R6F-8). DEVELOPMENT AND
 * SIMULATION ONLY (the assistance module, which mounts it, is never mounted in production).
 *
 * - The recovery worker (R6F-8) visits every verified assisted loss recorded by S6e-D (`payment_dispute_loss` whose effect kept the
 *   beneficiary's entitlement), including losses recorded before S6f, once: a FULL chargeback of a payment never refunded opens the
 *   Organization's base-only `recovery_obligation` (B10, D5); a partial chargeback (R6F-3) or a refunded payment (R6F-4) is recorded in
 *   `recovery_review` for S6h, with no debt and no T3. The database re-checks every condition.
 * - Settlement (BIL-29; R6F-1, R6F-2): the Organization's administrator (live, never the beneficiary) opens ONE channel for the outstanding
 *   amount: an invoice of the reserved producer `billing-recovery` (one line of a single-use price of that amount on the Platform's reserved
 *   recovery product), routed `recovery_settlement`, and its payment request; the administrator pays it at Payment. Only Payment's verified
 *   success is a recovery payment (`recovery-ledger.ts`).
 * - Reads (BIL-28): the Organization's administrator, or the Owner of the obligation's Platform.
 * - Surplus Path B (BIL-30, BIL-31; R-3b): the Owner records an external repayment with File `surplus_evidence` and a dedicated receipt; the
 *   receiving Organization's administrator confirms it (never the recorder). Path A is the refund-case flow (`recovery_surplus` eligibility).
 */
@Injectable()
export class RecoveryService {
  private readonly log = new Logger('BillingRecovery');
  private readonly loop = new PollLoop(
    () => this.drainOnce(),
    (e) => this.log.error(`recovery_worker_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.log.warn(`worker_drain_timeout worker=recovery_worker drainTimeoutMs=${ms} — resumed after restart`),
  );
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly audit: BillingAudit,
    private readonly authority: AssistanceAuthority,
    private readonly idempotency: AssistanceCommandIdempotency,
    private readonly invoices: InvoiceRepository,
    private readonly requests: PaymentRequestRepository,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    @Inject(OWNER_AUTHORITY) private readonly owners: OwnerAuthority,
    @Inject(FRAUD_HOLD_RECEIPTS) private readonly receipts: FraudHoldReceipts,
    @Inject(FRAUD_EVIDENCE_FILES) private readonly files: FraudEvidenceFiles,
  ) {}

  start(intervalMs = 5000): void {
    this.loop.start(intervalMs);
  }

  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  /** One pass over every assisted verified loss not yet visited (R6F-8). Exposed for tests. */
  async drainOnce(): Promise<{ opened: number; review: number; failed: number }> {
    if (this.running) return { opened: 0, review: 0, failed: 0 };
    this.running = true;
    try {
      const tally = { opened: 0, review: 0, failed: 0 };
      const { rows } = await this.db.query<{ disputeId: string }>(
        `SELECT l."disputeId" FROM payment_dispute_loss l JOIN dispute_loss_effect e ON e."disputeId" = l."disputeId"
          WHERE e.reason = 'assisted_purchase_preserved'
            AND NOT EXISTS (SELECT 1 FROM recovery_obligation o WHERE o."disputeId" = l."disputeId")
            AND NOT EXISTS (SELECT 1 FROM recovery_review r WHERE r."disputeId" = l."disputeId")
          ORDER BY l."recordedAt", l."disputeId" LIMIT $1`, [BATCH]);
      for (const r of rows) {
        try {
          const o = await this.visit(r.disputeId);
          if (o === 'opened') tally.opened++;
          if (o === 'review') tally.review++;
        } catch (e) {
          tally.failed++;
          this.log.warn(`recovery_worker_retry dispute=${r.disputeId} ${describeFailure(e)} — nothing was applied; the next pass retries`);
        }
      }
      return tally;
    } finally {
      this.running = false;
    }
  }

  /** One verified assisted loss: the obligation, or the review record; idempotent (both are keyed by the loss). */
  async visit(disputeId: string): Promise<'opened' | 'review' | 'already'> {
    const ctx: TransitionContext = { actor: { type: 'system', id: RECOVERY_WORKER }, cause: { type: 'sweep', id: disputeId }, correlationId: `recovery:${disputeId}` };
    const f = (await this.db.query<{ purchaseId: string; assistanceRequestId: string; organizationId: string; platformId: string; companyId: string | null;
      baseAmount: string; currency: string; chargebackAmount: string; prAmount: string; refunded: boolean }>(
      `SELECT e."purchaseId", s."assistanceRequestId", a."organizationId", a."platformId", b."companyId", a."baseAmount", a.currency,
              l."chargebackAmount", pr.amount AS "prAmount",
              EXISTS (SELECT 1 FROM refund_case c WHERE c."paymentRequestId" = pr.id AND c.status = 'completed') AS refunded
         FROM payment_dispute_loss l JOIN dispute_loss_effect e ON e."disputeId" = l."disputeId" JOIN subscription_purchase s ON s.id = e."purchaseId"
         JOIN assistance_request a ON a.id = s."assistanceRequestId" JOIN payment_request pr ON pr.id = l."paymentRequestId"
         LEFT JOIN billing_platform b ON b."platformId" = a."platformId"
        WHERE l."disputeId" = $1 AND e.reason = 'assisted_purchase_preserved'`, [disputeId])).rows[0];
    if (!f) return 'already';
    return this.db.tx(async (q) => {
      await lockOrganization(q, f.organizationId);
      const seen = (await q.query(`SELECT 1 FROM recovery_obligation WHERE "disputeId" = $1 UNION ALL SELECT 1 FROM recovery_review WHERE "disputeId" = $1`, [disputeId])).rows.length;
      if (seen > 0) return 'already' as const;
      // R6F-4 first (a refunded payment is reconciliation only, whatever was charged back), then R6F-3 (Option A: a partial chargeback)
      const reason = f.refunded ? 'refund_completed' : Number(f.chargebackAmount) < Number(f.prAmount) ? 'partial_chargeback' : null;
      if (!reason && Number(f.chargebackAmount) > Number(f.prAmount)) throw new Error('chargeback_exceeds_payment');
      if (!reason && !f.companyId) throw new Error('platform_not_configured');
      if (reason) {
        await q.query(`INSERT INTO recovery_review ("disputeId", reason) VALUES ($1, $2)`, [disputeId, reason]);
        this.log.warn(`recovery_review dispute=${disputeId} reason=${reason} — no obligation, no T3; kept for reconciliation (S6h)`);
        return 'review' as const;
      }
      const o = (await q.query<{ id: string }>(
        `INSERT INTO recovery_obligation ("disputeId", "assistanceRequestId", "purchaseId", "organizationId", "companyId", "platformId", "baseAmount", currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [disputeId, f.assistanceRequestId, f.purchaseId, f.organizationId, f.companyId!, f.platformId, f.baseAmount, f.currency])).rows[0]!;
      await this.audit.record(q, 'recovery_obligation.opened', {
        organizationId: f.organizationId, resource: { type: 'recovery_obligation', id: o.id },
        changes: { dispute_id: disputeId, assistance_request_id: f.assistanceRequestId, base_amount: Number(f.baseAmount) },
      }, ctx);
      this.log.log(`recovery_obligation_opened obligation=${o.id} dispute=${disputeId} organization=${f.organizationId}`);
      return 'opened' as const;
    });
  }

  /** The Organization's administrator, live; never the obligation's beneficiary (R6F-1). The collapsed 404 for anyone else. */
  private async organizationAdministrator(identity: AuthIdentity, o: { assistanceRequestId: string; organizationId: string; platformId: string }): Promise<void> {
    const beneficiary = (await this.db.query<{ beneficiaryUserId: string }>(`SELECT "beneficiaryUserId" FROM assistance_request WHERE id = $1`, [o.assistanceRequestId])).rows[0]!;
    const relation = await this.authority.relation(identity, { beneficiaryUserId: beneficiary.beneficiaryUserId, organizationId: o.organizationId, platformId: o.platformId });
    if (!relation.organizationActor && !relation.beneficiary) throw notFound();
    if (relation.beneficiary || !relation.organizationActor) throw operationNotPermitted();
  }

  private async obligation(q: Queryable, id: string, lock = false): Promise<ObligationRow | undefined> {
    if (!UUID.test(id)) return undefined;
    return (await q.query<ObligationRow>(`SELECT * FROM recovery_obligation WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  }

  /**
   * BIL-29: `POST /billing/recovery-obligations/:id/settlement` → `201 {invoiceId, paymentRequestId, paymentId: null, amount}`. One idempotent
   * transaction (class M): the Organization lock, the obligation, no active channel (`409 settlement_channel_open`), an open obligation (`409
   * recovery_obligation_closed`), then the invoice for the outstanding amount, its channel, its issue and its payment request.
   */
  async settle(identity: AuthIdentity, key: string, id: string, locale: string, ctx: TransitionContext) {
    if (this.config.isProduction) throw notFound();
    const o = await this.obligation(this.db, id);
    if (!o) throw notFound();
    await this.organizationAdministrator(identity, o);
    return this.idempotency.run(identity.id, key, 'recovery_obligation.settlement', { id }, async (q): Promise<AssistanceCommandResult> => {
      await lockOrganization(q, o.organizationId);
      const cur = (await this.obligation(q, id, true))!;
      if (cur.status !== 'open') throw closed();
      if ((await q.query(`SELECT 1 FROM recovery_settlement_channel c WHERE c."obligationId" = $1 AND billing_recovery_channel_active(c.id)`, [id])).rows.length > 0) throw channelOpen();
      const outstanding = Number((await q.query<{ n: string }>(`SELECT billing_recovery_outstanding($1) AS n`, [id])).rows[0]!.n);
      if (outstanding <= 0) throw closed();
      const productId = await this.recoveryProduct(q, cur);
      const channelRef = randomUUID();
      const priceId = (await q.query<{ id: string }>(
        `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval") VALUES ($1, $2, $3, $4, 'one_time') RETURNING id`,
        [productId, `recovery-${channelRef}`, cur.currency.trim(), outstanding])).rows[0]!.id;
      const draft = normaliseCreateInvoiceInput({
        invoiceRequestId: randomUUID(),
        seller: { type: 'company', id: cur.companyId },
        payer: { type: 'organization', id: cur.organizationId },
        organizationId: cur.organizationId,
        sourceType: 'recovery_obligation',
        sourceId: id,
        issuerSnapshot: { schemaVersion: 2, partyType: 'company', companyId: cur.companyId, platformId: cur.platformId, legalIdentity: 'not_determined' },
        billToSnapshot: { schemaVersion: 2, partyType: 'organization', organizationId: cur.organizationId, legalIdentity: 'not_determined' },
        lines: [{ priceId, quantity: 1 }],
      });
      const issuer: Caller = { kind: 'service', service: RECOVERY_PRODUCER };
      const { invoice } = await this.invoices.createDraftIn(q, RECOVERY_PRODUCER, draft, this.config.supportedCurrencies, ctx);
      const channel = (await q.query<{ id: string }>(
        `INSERT INTO recovery_settlement_channel ("obligationId", "invoiceId", amount, "startedBy") VALUES ($1, $2, $3, $4) RETURNING id`, [id, invoice.id, outstanding, identity.id])).rows[0]!;
      await this.invoices.issueIn(q, invoice.id, issuer, { template: SYSTEM_TEMPLATE_V1, locale }, ctx, { callerPlatforms: new Set([cur.platformId]), organizationPlatformId: null });
      const { request } = await this.requests.createForInvoiceIn(q, invoice.id, issuer, ctx);
      await q.query(`UPDATE recovery_settlement_channel SET "paymentRequestId" = $2 WHERE id = $1`, [channel.id, request.id]);
      this.log.log(`recovery_settlement_started obligation=${id} channel=${channel.id} amount=${outstanding}`);
      return { status: 201, body: { invoiceId: invoice.id, paymentRequestId: request.id, paymentId: request.paymentId, amount: outstanding } };
    });
  }

  /**
   * The Platform's reserved recovery product (the reserved producer, target `none`), created once; never a catalog or checkout product. A
   * product of that Company already holding the code under any other producer, target or Platform is never reused (409, nothing written).
   */
  private async recoveryProduct(q: Queryable, o: ObligationRow): Promise<string> {
    const code = `recovery-${o.platformId}`;
    const find = async () => (await q.query<{ id: string }>(
      `SELECT id FROM product WHERE "sellerType" = 'company' AND "sellerId" = $1 AND code = $2 AND producer = $3 AND "subscriptionTarget" = 'none' AND "platformId" = $4`,
      [o.companyId, code, RECOVERY_PRODUCER, o.platformId])).rows[0]?.id;
    const existing = await find();
    if (existing) return existing;
    const created = (await q.query<{ id: string }>(
      `INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
       VALUES ($1, 'company', $2, $3, 'Recovery settlement', 'active', 'none', $4) ON CONFLICT ("sellerType", "sellerId", code) DO NOTHING RETURNING id`,
      [RECOVERY_PRODUCER, o.companyId, code, o.platformId])).rows[0]?.id;
    const id = created ?? await find();
    if (!id) throw billingError(409, 'product_conflict', BILLING_MESSAGES.productConflict);
    return id;
  }

  /** BIL-28 for the Organization's administrator. */
  async readAsOrganization(identity: AuthIdentity, id: string) {
    const o = await this.obligation(this.db, id);
    if (!o) throw notFound();
    await this.organizationAdministrator(identity, o);
    return this.view(o);
  }

  /** BIL-28 for the Owner of the obligation's Platform (live). */
  async readAsOwner(owner: VerifiedRefundOwner, id: string) {
    const o = await this.obligation(this.db, id);
    if (!o || o.companyId !== owner.companyId || !(await this.owners.platformAllowed(owner.bearer, o.platformId, AbortSignal.timeout(this.config.authTimeoutMs)))) throw notFound();
    return this.view(o);
  }

  private async view(o: ObligationRow) {
    const [payments, surpluses, channels, outstanding] = await Promise.all([
      this.db.query(`SELECT id, "paymentRequestId", amount::int, "principalAmount"::int, "surplusAmount"::int, "recordedAt" FROM recovery_payment WHERE "obligationId" = $1 ORDER BY "recordedAt", id`, [o.id]).then((r) => r.rows),
      this.db.query(`SELECT su.id, su.amount::int, su."recordedAt",
          (SELECT "recordedAt" FROM recovery_surplus_external x WHERE x."surplusId" = su.id) AS "externalRecordedAt",
          (SELECT "confirmedAt" FROM recovery_surplus_confirmation c WHERE c."surplusId" = su.id) AS "confirmedAt",
          (SELECT "refundCaseId" FROM recovery_surplus_refund r WHERE r."surplusId" = su.id) AS "refundCaseId"
          FROM recovery_surplus su WHERE su."obligationId" = $1 ORDER BY su."recordedAt", su.id`, [o.id]).then((r) => r.rows),
      this.db.query(`SELECT c.id, c."invoiceId", c."paymentRequestId", c.amount::int, pr.status AS "paymentRequestStatus", billing_recovery_channel_active(c.id) AS active, c."createdAt"
          FROM recovery_settlement_channel c LEFT JOIN payment_request pr ON pr.id = c."paymentRequestId" WHERE c."obligationId" = $1 ORDER BY c."createdAt", c.id`, [o.id]).then((r) => r.rows),
      this.db.query<{ n: string }>(`SELECT billing_recovery_outstanding($1) AS n`, [o.id]).then((r) => Number(r.rows[0]!.n)),
    ]);
    const base = Number(o.baseAmount);
    return {
      id: o.id, organizationId: o.organizationId, companyId: o.companyId, platformId: o.platformId, assistanceRequestId: o.assistanceRequestId, disputeId: o.disputeId,
      baseAmount: base, recovered: base - Math.max(0, outstanding), outstanding: Math.max(0, outstanding), currency: o.currency.trim(), status: o.status,
      openedAt: o.openedAt.toISOString(), recoveredAt: o.recoveredAt?.toISOString() ?? null, payments, channels,
      surpluses: (surpluses as Record<string, unknown>[]).map((s) => ({
        ...s, status: s.refundCaseId || s.confirmedAt ? 'resolved' : s.externalRecordedAt ? 'external_execution_evidenced' : 'owed_to_organization',
      })),
    };
  }

  /**
   * BIL-30 (R-3b, R6F-5 Path B): the Owner records that a surplus was repaid outside Core. A live File `surplus_evidence` grant to Billing for
   * exactly this surplus, and an Auth `recovery_surplus_external` receipt for exactly this Company, surplus, Organization, amount and currency,
   * issued by the requesting Owner and consumed once. Recorded append-only; NOT a provider fact; the Organization still confirms (BIL-31).
   */
  async recordExternal(owner: VerifiedRefundOwner, surplusId: string, input: Record<string, unknown>, ctx: TransitionContext) {
    if (this.config.isProduction) throw notFound();
    const grantId = typeof input.grantId === 'string' ? input.grantId.toLowerCase() : '';
    const fileId = typeof input.fileId === 'string' ? input.fileId.toLowerCase() : '';
    if (!UUID.test(surplusId) || !UUID.test(grantId) || !UUID.test(fileId) || typeof input.receiptSecret !== 'string' || !SECRET.test(input.receiptSecret)) throw invalid();
    const s = (await this.db.query<{ id: string; organizationId: string; amount: string; currency: string; companyId: string; platformId: string }>(
      `SELECT su.id, su."organizationId", su.amount, su.currency, o."companyId", o."platformId" FROM recovery_surplus su JOIN recovery_obligation o ON o.id = su."obligationId" WHERE su.id = $1`,
      [surplusId])).rows[0];
    if (!s || s.companyId !== owner.companyId || !(await this.owners.platformAllowed(owner.bearer, s.platformId, AbortSignal.timeout(this.config.authTimeoutMs)))) throw notFound();
    const replay = await this.recorded(surplusId, grantId, fileId);
    if (replay) return replay;
    const done = (await this.db.query(`SELECT 1 FROM recovery_surplus_external WHERE "surplusId" = $1 UNION ALL SELECT 1 FROM recovery_surplus_refund WHERE "surplusId" = $1
      UNION ALL SELECT 1 FROM refund_case WHERE "surplusId" = $1 AND status <> 'cancelled'`, [surplusId])).rows.length;
    if (done > 0) {
      const raced = await this.recorded(surplusId, grantId, fileId); // an identical request committed in between: answered, not refused
      if (raced) return raced;
      throw billingError(409, 'surplus_not_owed', BILLING_MESSAGES.surplusNotOwed);
    }
    let g;
    try {
      g = await this.files.granted(grantId, fileId, AbortSignal.timeout(this.config.authTimeoutMs));
    } catch {
      throw billingError(503, 'surplus_evidence_unavailable', BILLING_MESSAGES.surplusEvidenceUnavailable);
    }
    if (!g || g.grantId !== grantId || g.fileId !== fileId || g.purpose !== 'surplus_evidence' || g.caseRef !== surplusId
      || (g.companyId !== null && g.companyId !== s.companyId)) {
      throw billingError(422, 'surplus_evidence_invalid', BILLING_MESSAGES.surplusEvidenceInvalid);
    }
    const binding = { operation: 'recovery_surplus_external' as const, audience: 'billing-service' as const, companyId: s.companyId, surplusId, organizationId: s.organizationId,
      amount: Number(s.amount), currency: s.currency.trim() };
    const consumption = await this.consume(binding, input.receiptSecret, surplusConsumeRef(surplusId, input.receiptSecret), owner);
    try {
      await this.db.tx(async (q) => {
        await q.query(`INSERT INTO recovery_surplus_external ("surplusId", "recordedByUserId", "receiptId", "grantId", "fileId") VALUES ($1, $2, $3, $4, $5)`,
          [surplusId, owner.userId, consumption.receiptId, grantId, fileId]);
        await this.audit.record(q, 'recovery_surplus.resolved', {
          organizationId: s.organizationId, resource: { type: 'recovery_surplus', id: surplusId }, changes: { method: 'external_execution_evidenced', file_id: fileId },
        }, ctx);
      });
    } catch (e) {
      const c = pgConstraint(e);
      if (c === 'recovery_surplus_external_pkey' || c === 'recovery_surplus_external_receiptId_key' || c === 'recovery_surplus_external_grantId_key') {
        const again = await this.recorded(surplusId, grantId, fileId);
        if (again) return again; // a concurrent identical request recorded it
      }
      if (c === 'recovery_surplus_one_path' || c === 'recovery_surplus_external_pkey') throw billingError(409, 'surplus_not_owed', BILLING_MESSAGES.surplusNotOwed);
      throw e;
    }
    return { created: true, body: { surplusId, status: 'external_execution_evidenced' } };
  }

  /** The same record repeated (same surplus, grant and file) answers the record (200), never a second consumption. */
  private async recorded(surplusId: string, grantId: string, fileId: string) {
    const r = (await this.db.query(`SELECT 1 FROM recovery_surplus_external WHERE "surplusId" = $1 AND "grantId" = $2 AND "fileId" = $3`, [surplusId, grantId, fileId])).rows[0];
    return r ? { created: false, body: { surplusId, status: 'external_execution_evidenced' } } : null;
  }

  /**
   * BIL-31 (R-3b): the receiving Organization's administrator confirms the external repayment; the surplus is resolved, once. Never the Owner
   * or the recorder (the database refuses the recorder too); `409 surplus_not_evidenced` before the Owner's record.
   */
  async confirm(identity: AuthIdentity, key: string, surplusId: string, ctx: TransitionContext) {
    if (this.config.isProduction) throw notFound();
    if (!UUID.test(surplusId)) throw notFound();
    const s = (await this.db.query<{ obligationId: string; organizationId: string }>(`SELECT "obligationId", "organizationId" FROM recovery_surplus WHERE id = $1`, [surplusId])).rows[0];
    if (!s) throw notFound();
    const o = (await this.obligation(this.db, s.obligationId))!;
    await this.organizationAdministrator(identity, o);
    return this.idempotency.run(identity.id, key, 'recovery_surplus.confirm', { id: surplusId }, async (q): Promise<AssistanceCommandResult> => {
      if ((await q.query(`SELECT 1 FROM recovery_surplus_external WHERE "surplusId" = $1`, [surplusId])).rows.length === 0) {
        throw billingError(409, 'surplus_not_evidenced', BILLING_MESSAGES.surplusNotEvidenced);
      }
      const ins = await q.query(`INSERT INTO recovery_surplus_confirmation ("surplusId", "confirmedByUserId") VALUES ($1, $2) ON CONFLICT ("surplusId") DO NOTHING RETURNING "surplusId"`, [surplusId, identity.id]);
      if (ins.rows.length > 0) {
        await this.audit.record(q, 'recovery_surplus.recipient_confirmed', { organizationId: s.organizationId, resource: { type: 'recovery_surplus', id: surplusId } }, ctx);
      }
      return { status: 200, body: { surplusId, status: 'resolved' } };
    });
  }

  private async consume(binding: FraudHoldBinding, secret: string, consumeRef: string, owner: VerifiedRefundOwner): Promise<ReceiptConsumption> {
    let out;
    try {
      out = await this.receipts.consume({ secret, binding, consumeRef });
      if (out.kind === 'unresolved') {
        const found = await this.receipts.lookup({ binding, consumeRef }).catch(() => null);
        if (found) out = { kind: 'consumed' as const, consumption: found };
      }
    } catch {
      throw billingError(503, 'recovery_authorization_unavailable', BILLING_MESSAGES.recoveryAuthorizationUnavailable);
    }
    if (out.kind === 'refused' || (out.kind === 'consumed' && out.consumption.approvedByUserId !== owner.userId)) {
      throw billingError(409, 'recovery_authorization_refused', BILLING_MESSAGES.recoveryAuthorizationRefused);
    }
    if (out.kind === 'unresolved') throw billingError(503, 'recovery_authorization_unresolved', BILLING_MESSAGES.recoveryAuthorizationUnresolved);
    return out.consumption;
  }
}

@Injectable()
export class RecoveryWorkerService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly worker: RecoveryService) {}
  onApplicationBootstrap(): void {
    this.worker.start();
  }
  onModuleDestroy(): void {
    void this.worker.stop();
  }
  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
}
