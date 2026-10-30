import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type HttpException } from '@nestjs/common';
import { DbService, pgConstraint, type AuthIdentity, type Queryable } from '@nawara/service-kit';
import { AssistanceAuthority } from '../assistance/assistance-authority.js';
import { AssistanceCommandIdempotency, type AssistanceCommandResult } from '../assistance/assistance-idempotency.js';
import { BillingAudit } from '../audit/billing-audit.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import type { TransitionContext } from '../domain/actors.js';
import { billingError, notFound, operationNotPermitted } from '../domain/errors.js';
import { FRAUD_EVIDENCE_FILES, FRAUD_HOLD_RECEIPTS, type FraudEvidenceFiles, type FraudHoldBinding, type FraudHoldReceipts, type ReceiptConsumption } from '../fraud-holds/fraud-hold-clients.js';
import { BILLING_MESSAGES } from '../messages.js';
import { OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import type { VerifiedRefundOwner } from '../refunds/refund-owner.guard.js';
import { PersonalSubscriptionRepository } from '../subscriptions/personal-subscription.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** R6G-3: the closed L-4 reason codes, each requiring its own evidence path. */
export const LATE_SETTLEMENT_REASONS = ['cash_not_returned_attested', 'cash_not_returned_evidenced'] as const;
export type LateSettlementReason = (typeof LATE_SETTLEMENT_REASONS)[number];
/** R6G-2 Path A: the beneficiary's statement (a contrary one refuses both paths). */
export const ATTESTATION_STATEMENTS = ['cash_not_returned', 'cash_returned'] as const;
export type AttestationStatement = (typeof ATTESTATION_STATEMENTS)[number];

/** The closed refusals of `409 late_settlement_refused` (BIL-32 C, as extended by the Owner's R6G-2 and R6G-7 safeguards). */
export const LATE_SETTLEMENT_REFUSALS = [
  'purchase_exists', 'cash_return_confirmed', 'cash_return_reported', 'request_not_settleable', 'dispute_open', 'settlement_in_progress', 'refund_exists',
  'evidence_insufficient', 'evidence_contradictory', 'settlement_time_unavailable', 'already_applied',
] as const;
export type LateSettlementRefusal = (typeof LATE_SETTLEMENT_REFUSALS)[number];

/** The database's own refusals (migration 0040), mapped to the same closed reasons. */
const CONSTRAINT_REFUSAL: Record<string, LateSettlementRefusal> = {
  late_settlement_purchase_exists: 'purchase_exists',
  late_settlement_cash_return_confirmed: 'cash_return_confirmed',
  late_settlement_cash_return_reported: 'cash_return_reported',
  late_settlement_request_not_settleable: 'request_not_settleable',
  late_settlement_dispute_open: 'dispute_open',
  late_settlement_channel_open: 'settlement_in_progress',
  late_settlement_refund_exists: 'refund_exists',
  late_settlement_evidence_insufficient: 'evidence_insufficient',
  late_settlement_evidence_contradictory: 'evidence_contradictory',
  late_settlement_time_unavailable: 'settlement_time_unavailable',
  late_settlement_application_lateSettlementId_key: 'already_applied',
  late_settlement_application_assistanceRequestId_key: 'purchase_exists',
  subscription_purchase_assistance_unique: 'purchase_exists',
  cash_return_obligation_supersession: 'cash_return_reported',
};

export function lateSettlementRefused(reason: LateSettlementRefusal): HttpException {
  const e = billingError(409, 'late_settlement_refused', BILLING_MESSAGES.lateSettlementRefused, { reason });
  (e.getResponse() as Record<string, unknown>).reason = reason;
  return e;
}

const invalid = () => billingError(400, 'invalid_late_settlement_request', BILLING_MESSAGES.invalidLateSettlementRequest);

/**
 * The Auth consumption reference of one application: derived from the late settlement and the receipt secret (one-way; the secret is sent
 * only in Auth's consume body, never stored or logged). The same request repeated keeps its reference; another receipt gets its own, so a
 * refused receipt never blocks the late settlement.
 */
export function lateSettlementConsumeRef(lateSettlementId: string, secret: string): string {
  const h = createHash('sha256').update(`billing.late_settlement_apply\0${lateSettlementId}\0${secret}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface ApplicationInput {
  reasonCode: LateSettlementReason;
  receiptSecret: string;
  evidence: { grantId: string; fileId: string }[];
}

/** Strict body of `POST /billing/admin/late-settlements/:id/application` (R6G-2, R6G-3): no other field; no override. */
export function normaliseApplicationInput(body: unknown): ApplicationInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid();
  const b = body as Record<string, unknown>;
  const allowed = ['reasonCode', 'receiptSecret', 'evidence', 'ownerDetermination'];
  if (Object.keys(b).some((k) => !allowed.includes(k))) throw invalid();
  if (!(LATE_SETTLEMENT_REASONS as readonly unknown[]).includes(b.reasonCode)) throw invalid();
  if (typeof b.receiptSecret !== 'string' || !SECRET.test(b.receiptSecret)) throw invalid();
  const evidenced = b.reasonCode === 'cash_not_returned_evidenced';
  let evidence: { grantId: string; fileId: string }[] = [];
  if (evidenced) {
    // Path B: 1 to 5 File grants AND the Owner's explicit determination that they show the cash was not returned
    if (b.ownerDetermination !== 'cash_not_returned' || !Array.isArray(b.evidence) || b.evidence.length < 1 || b.evidence.length > 5) throw invalid();
    evidence = b.evidence.map((e) => {
      if (typeof e !== 'object' || e === null || Array.isArray(e)) throw invalid();
      const r = e as Record<string, unknown>;
      if (Object.keys(r).some((k) => k !== 'grantId' && k !== 'fileId')) throw invalid();
      const grantId = typeof r.grantId === 'string' ? r.grantId.toLowerCase() : '';
      const fileId = typeof r.fileId === 'string' ? r.fileId.toLowerCase() : '';
      if (!UUID.test(grantId) || !UUID.test(fileId)) throw invalid();
      return { grantId, fileId };
    });
    if (new Set(evidence.map((e) => e.grantId)).size !== evidence.length) throw invalid();
  } else if (b.evidence !== undefined || b.ownerDetermination !== undefined) {
    throw invalid(); // Path A carries no File evidence: its basis is the beneficiary's own attestation
  }
  return { reasonCode: b.reasonCode as LateSettlementReason, receiptSecret: b.receiptSecret, evidence };
}

interface LateRow {
  id: string; assistanceRequestId: string; invoiceId: string; paymentRequestId: string; receiptId: string; reason: string; recordedAt: Date;
  organizationId: string; platformId: string; beneficiaryUserId: string; productId: string; companyId: string | null;
}

/**
 * Core V2 S6g (register BIL-32; S0 §3.4 L-1 to L-6; ADR-0044 B14; the Owner's R6G-1 to R6G-9 and Option A), DEVELOPMENT AND SIMULATION ONLY.
 * L-1 to L-3 and L-5 are S5b / S6a-S6d. This adds the L-4 exception, refused per L-6:
 * - the beneficiary attests, once, about the cash of a late settlement's request (Path A): a statement, never a financial fact;
 * - the Owner of the seller Company applies one verified late settlement as the request's single purchase, with Auth's `late_settlement_apply`
 *   receipt (factor step-up) and either the beneficiary's `cash_not_returned` attestation or live File `settlement_evidence` grants with the
 *   Owner's explicit determination (Path B). One transaction: the application, the supersession of the live deadline obligation, the purchase
 *   (Payment's instant kept, the period anchored at the application: R6G-5) and the settled request; T1 / T2 end for that request only.
 * Every condition is re-checked by the database (migration 0040). Nothing here moves money, refunds, or touches another request.
 */
@Injectable()
export class LateSettlementService {
  private readonly log = new Logger('BillingLateSettlement');

  constructor(
    private readonly db: DbService,
    private readonly audit: BillingAudit,
    private readonly authority: AssistanceAuthority,
    private readonly idempotency: AssistanceCommandIdempotency,
    private readonly personal: PersonalSubscriptionRepository,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    @Inject(OWNER_AUTHORITY) private readonly owners: OwnerAuthority,
    @Inject(FRAUD_HOLD_RECEIPTS) private readonly receipts: FraudHoldReceipts,
    @Inject(FRAUD_EVIDENCE_FILES) private readonly files: FraudEvidenceFiles,
  ) {}

  private deadline(): AbortSignal {
    return AbortSignal.timeout(this.config.authTimeoutMs);
  }

  private async late(q: Queryable, id: string): Promise<LateRow | undefined> {
    if (!UUID.test(id)) return undefined;
    return (await q.query<LateRow>(
      `SELECT l.id, l."assistanceRequestId", l."invoiceId", l."paymentRequestId", l."receiptId", l.reason, l."recordedAt",
              a."organizationId", a."platformId", a."beneficiaryUserId", a."productId", b."companyId"
         FROM assistance_late_settlement l JOIN assistance_request a ON a.id = l."assistanceRequestId"
         LEFT JOIN billing_platform b ON b."platformId" = a."platformId" WHERE l.id = $1`, [id])).rows[0];
  }

  /** The decision and evidence state of one late settlement (R6G-4 read). */
  private async view(q: Queryable, l: LateRow) {
    const [settled, attestation, application, evidence, refunds] = await Promise.all([
      q.query<{ v: Date | null }>(`SELECT billing_late_settlement_settled_at($1) AS v`, [l.id]).then((r) => r.rows[0]!.v),
      q.query<{ statement: string; attestedAt: Date }>(`SELECT statement, "attestedAt" FROM late_settlement_attestation WHERE "lateSettlementId" = $1`, [l.id]).then((r) => r.rows[0] ?? null),
      q.query<{ id: string; reasonCode: string; obligationId: string | null; appliedAt: Date; appliedByUserId: string; receiptId: string; purchaseId: string | null }>(
        `SELECT a.id, a."reasonCode", a."obligationId", a."appliedAt", a."appliedByUserId", a."receiptId",
                (SELECT p.id FROM subscription_purchase p WHERE p."invoiceId" = $2 AND p."assistanceRequestId" = a."assistanceRequestId") AS "purchaseId"
           FROM late_settlement_application a WHERE a."lateSettlementId" = $1`, [l.id, l.invoiceId]).then((r) => r.rows[0] ?? null),
      q.query<{ grantId: string; fileId: string; verifiedAt: Date }>(`SELECT "grantId", "fileId", "verifiedAt" FROM late_settlement_evidence WHERE "lateSettlementId" = $1 ORDER BY "verifiedAt", "grantId"`, [l.id]).then((r) => r.rows),
      q.query<{ id: string; status: string }>(`SELECT id, status FROM refund_case WHERE "paymentRequestId" = $1 ORDER BY "openedAt", id`, [l.paymentRequestId]).then((r) => r.rows),
    ]);
    const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
    return {
      id: l.id, assistanceRequestId: l.assistanceRequestId, organizationId: l.organizationId, platformId: l.platformId, invoiceId: l.invoiceId,
      paymentRequestId: l.paymentRequestId, lateReason: l.reason, recordedAt: iso(l.recordedAt), settledAt: iso(settled),
      status: application ? 'applied' : 'unapplied',
      attestation: attestation ? { statement: attestation.statement, attestedAt: iso(attestation.attestedAt) } : null,
      application: application ? {
        id: application.id, reasonCode: application.reasonCode, appliedAt: iso(application.appliedAt), appliedBy: { userId: application.appliedByUserId },
        receiptId: application.receiptId, purchaseId: application.purchaseId, supersededObligationId: application.obligationId,
      } : null,
      evidence: evidence.map((e) => ({ grantId: e.grantId, fileId: e.fileId, verifiedAt: iso(e.verifiedAt) })),
      refundCases: refunds,
    };
  }

  /** The request's late settlements, for its beneficiary or its Organization's administrator (live). */
  async listForRequest(identity: AuthIdentity, requestId: string) {
    if (this.config.isProduction) throw notFound();
    if (!UUID.test(requestId)) throw notFound();
    const a = (await this.db.query<{ beneficiaryUserId: string; organizationId: string; platformId: string }>(
      `SELECT "beneficiaryUserId", "organizationId", "platformId" FROM assistance_request WHERE id = $1`, [requestId])).rows[0];
    if (!a) throw notFound();
    const relation = await this.authority.relation(identity, a);
    if (!relation.beneficiary && !relation.organizationActor) throw notFound();
    const ids = (await this.db.query<{ id: string }>(`SELECT id FROM assistance_late_settlement WHERE "assistanceRequestId" = $1 ORDER BY "recordedAt", id`, [requestId])).rows;
    const items = [];
    for (const { id } of ids) {
      const v = await this.view(this.db, (await this.late(this.db, id))!);
      // a participant's view: no Owner identity, receipt or evidence reference
      items.push({ id: v.id, assistanceRequestId: v.assistanceRequestId, lateReason: v.lateReason, recordedAt: v.recordedAt, settledAt: v.settledAt, status: v.status,
        attestation: v.attestation, application: v.application ? { reasonCode: v.application.reasonCode, appliedAt: v.application.appliedAt } : null });
    }
    return { lateSettlements: items };
  }

  /**
   * R6G-2 Path A: `POST /billing/assistance-late-settlements/:id/attestation` `{statement}` + `Idempotency-Key` (class K, permanent). Only the
   * live beneficiary of the late settlement's own request (anyone else the collapsed 404; the Organization's administrator 403); once per late
   * settlement (`409 late_settlement_already_attested`). It changes no financial fact and creates no purchase.
   */
  async attest(identity: AuthIdentity, key: string, id: string, statement: AttestationStatement, ctx: TransitionContext) {
    if (this.config.isProduction) throw notFound();
    const l = await this.late(this.db, id);
    if (!l) throw notFound();
    const relation = await this.authority.relation(identity, l);
    if (!relation.beneficiary && !relation.organizationActor) throw notFound();
    if (!relation.beneficiary) throw operationNotPermitted();
    try {
      return await this.idempotency.run(identity.id, key, 'assistance_late_settlement.attest', { id, statement }, async (q): Promise<AssistanceCommandResult> => {
        const a = (await q.query<{ id: string; attestedAt: Date }>(
          `INSERT INTO late_settlement_attestation ("lateSettlementId", "assistanceRequestId", "beneficiaryUserId", statement) VALUES ($1, $2, $3, $4)
           ON CONFLICT ("lateSettlementId") DO NOTHING RETURNING id, "attestedAt"`, [id, l.assistanceRequestId, identity.id, statement])).rows[0];
        if (!a) throw billingError(409, 'late_settlement_already_attested', BILLING_MESSAGES.lateSettlementAlreadyAttested);
        await this.audit.record(q, 'assistance_late_settlement.attested', {
          organizationId: l.organizationId, resource: { type: 'assistance_late_settlement', id }, changes: { assistance_request_id: l.assistanceRequestId, statement },
        }, ctx);
        return { status: 201, body: { lateSettlementId: id, statement, attestedAt: new Date(a.attestedAt).toISOString() } };
      });
    } catch (e) {
      if (pgConstraint(e) === 'late_settlement_attestation_beneficiary') throw operationNotPermitted();
      throw e;
    }
  }

  /** The Owner of the late settlement's seller Company (Billing's Platform projection) and, live, of its Platform; the collapsed 404 otherwise. */
  private async ownerLate(owner: VerifiedRefundOwner, id: string): Promise<LateRow> {
    const l = await this.late(this.db, id);
    if (!l || l.companyId !== owner.companyId || !(await this.owners.platformAllowed(owner.bearer, l.platformId, this.deadline()))) throw notFound();
    return l;
  }

  /** R6G-4: `GET /billing/admin/late-settlements/:id`: the decision and evidence state, for the Owner. */
  async readAsOwner(owner: VerifiedRefundOwner, id: string) {
    if (this.config.isProduction) throw notFound();
    return this.view(this.db, await this.ownerLate(owner, id));
  }

  /**
   * The L-4 / L-6 refusals that can be answered BEFORE the receipt is consumed (so a doomed request never spends the Owner's step-up). The
   * database re-checks every one of them, under its locks, when the application is written.
   */
  private async precheck(l: LateRow, input: ApplicationInput): Promise<LateSettlementRefusal | null> {
    const r = (await this.db.query<Record<string, unknown>>(
      `SELECT a.status,
              EXISTS (SELECT 1 FROM late_settlement_application x WHERE x."lateSettlementId" = $1) AS applied,
              EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."assistanceRequestId" = a.id) AS purchased,
              EXISTS (SELECT 1 FROM cash_return_obligation o WHERE o."assistanceRequestId" = a.id AND o.status = 'confirmed_returned') AS confirmed,
              EXISTS (SELECT 1 FROM cash_return_obligation o WHERE o."assistanceRequestId" = a.id AND o.status = 'return_reported') AS reported,
              EXISTS (SELECT 1 FROM assistance_dispute d WHERE d."assistanceRequestId" = a.id AND d.status = 'open') AS disputed,
              EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."assistanceRequestId" = a.id AND c."invoiceId" <> $2 AND c.status IN ('open', 'uncertain')) AS channel,
              EXISTS (SELECT 1 FROM refund_case c WHERE c."paymentRequestId" = $3
                        AND (c.status <> 'cancelled' OR EXISTS (SELECT 1 FROM refund_authorization_relay x WHERE x."refundCaseId" = c.id))) AS refunded,
              (SELECT statement FROM late_settlement_attestation t WHERE t."lateSettlementId" = $1) AS statement,
              billing_late_settlement_settled_at($1) IS NULL AS untimed
         FROM assistance_request a WHERE a.id = $4`, [l.id, l.invoiceId, l.paymentRequestId, l.assistanceRequestId])).rows[0]!;
    if (r.applied) return 'already_applied';
    if (r.purchased) return 'purchase_exists';
    if (r.confirmed) return 'cash_return_confirmed';
    if (r.status !== 'cash_collected') return 'request_not_settleable';
    if (r.reported) return 'cash_return_reported';
    if (r.disputed) return 'dispute_open';
    if (r.channel) return 'settlement_in_progress';
    if (r.refunded) return 'refund_exists';
    if (r.statement === 'cash_returned') return 'evidence_contradictory';
    if (input.reasonCode === 'cash_not_returned_attested' && r.statement !== 'cash_not_returned') return 'evidence_insufficient';
    if (r.untimed) return 'settlement_time_unavailable';
    return null;
  }

  /**
   * BIL-32 (L-4): `POST /billing/admin/late-settlements/:id/application` `{reasonCode, receiptSecret, evidence?, ownerDetermination?}` +
   * `Idempotency-Key` (class K, permanent: the same key and command answers the stored application without spending the receipt again).
   */
  async apply(owner: VerifiedRefundOwner, key: string, id: string, input: ApplicationInput, ctx: TransitionContext) {
    if (this.config.isProduction) throw notFound();
    const l = await this.ownerLate(owner, id);
    const command = { id, reasonCode: input.reasonCode, evidence: input.evidence };
    const stored = await this.idempotency.stored(owner.userId, key, 'assistance_late_settlement.apply', command);
    if (stored) return stored;
    const refusal = await this.precheck(l, input);
    if (refusal) throw lateSettlementRefused(refusal);
    // R6G-2 Path B: every reference is a live File `settlement_evidence` grant to Billing for exactly this late settlement (and, where the
    // grant names them, its Company and beneficiary). A file reference alone proves nothing: the Owner's explicit determination is required
    for (const ev of input.evidence) {
      let g;
      try {
        g = await this.files.granted(ev.grantId, ev.fileId, this.deadline());
      } catch {
        throw billingError(503, 'late_settlement_evidence_unavailable', BILLING_MESSAGES.lateSettlementEvidenceUnavailable);
      }
      if (!g || g.grantId !== ev.grantId || g.fileId !== ev.fileId || g.purpose !== 'settlement_evidence' || g.caseRef !== id
        || (g.companyId !== null && g.companyId !== l.companyId) || (g.subjectUserId !== null && g.subjectUserId !== l.beneficiaryUserId)) {
        throw billingError(422, 'late_settlement_evidence_invalid', BILLING_MESSAGES.lateSettlementEvidenceInvalid);
      }
    }
    const binding: FraudHoldBinding = {
      operation: 'late_settlement_apply', audience: 'billing-service', companyId: l.companyId!, lateSettlementId: id, assistanceRequestId: l.assistanceRequestId,
      beneficiaryUserId: l.beneficiaryUserId, reasonCode: input.reasonCode,
    };
    const consumption = await this.consume(binding, input.receiptSecret, lateSettlementConsumeRef(id, input.receiptSecret), owner);
    try {
      return await this.idempotency.run(owner.userId, key, 'assistance_late_settlement.apply', command, (q) => this.applyIn(q, l, input, owner, consumption, ctx));
    } catch (e) {
      const refused = CONSTRAINT_REFUSAL[pgConstraint(e) ?? ''];
      if (refused) throw lateSettlementRefused(refused);
      throw e;
    }
  }

  /** The one transaction (lock order Organization -> request -> live obligation -> payment request: the database guard takes them). */
  private async applyIn(q: Queryable, l: LateRow, input: ApplicationInput, owner: VerifiedRefundOwner, consumption: ReceiptConsumption, ctx: TransitionContext): Promise<AssistanceCommandResult> {
    await q.query(`SELECT billing_assistance_organization_lock($1)`, [l.organizationId]);
    await q.query(`SELECT 1 FROM assistance_request WHERE id = $1 FOR UPDATE`, [l.assistanceRequestId]);
    const live = (await q.query<{ id: string }>(
      `SELECT id FROM cash_return_obligation WHERE "assistanceRequestId" = $1 AND status IN ('open', 'return_reported') FOR UPDATE`, [l.assistanceRequestId])).rows[0];
    const attestation = input.reasonCode === 'cash_not_returned_attested'
      ? (await q.query<{ id: string }>(`SELECT id FROM late_settlement_attestation WHERE "lateSettlementId" = $1 AND statement = 'cash_not_returned'`, [l.id])).rows[0]?.id ?? null
      : null;
    // the instants as text: exact to the microsecond (a JS Date would truncate them, and the database compares them exactly)
    const app = (await q.query<{ id: string; appliedAt: string; settledAt: string }>(
      `INSERT INTO late_settlement_application ("lateSettlementId", "assistanceRequestId", "companyId", "platformId", "organizationId", "beneficiaryUserId",
                                                "reasonCode", "attestationId", "obligationId", "appliedByUserId", "receiptId", "settledAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, billing_late_settlement_settled_at($1)) RETURNING id, "appliedAt"::text AS "appliedAt", "settledAt"::text AS "settledAt"`,
      [l.id, l.assistanceRequestId, l.companyId, l.platformId, l.organizationId, l.beneficiaryUserId, input.reasonCode, attestation, live?.id ?? null,
        owner.userId, consumption.receiptId])).rows[0]!;
    for (const ev of input.evidence) {
      await q.query(`INSERT INTO late_settlement_evidence ("applicationId", "lateSettlementId", "grantId", "fileId") VALUES ($1, $2, $3, $4)`, [app.id, l.id, ev.grantId, ev.fileId]);
    }
    if (live) {
      await q.query(`UPDATE cash_return_obligation SET status = 'superseded_by_settlement', "supersededByApplicationId" = $2 WHERE id = $1`, [live.id, app.id]);
      await this.audit.record(q, 'cash_return_obligation.superseded', {
        organizationId: l.organizationId, resource: { type: 'cash_return_obligation', id: live.id }, changes: { assistance_request_id: l.assistanceRequestId, late_settlement_id: l.id },
      }, ctx);
    }
    // the single purchase: Payment's original instant kept, the period anchored at the application (R6G-5); the late invoice's own line
    const line = (await q.query<{ priceId: string }>(
      `SELECT "priceId" FROM invoice_line WHERE "invoiceId" = $1 AND "productId" = $2 AND "interval" = 'recurring'`, [l.invoiceId, l.productId])).rows;
    if (line.length !== 1) throw lateSettlementRefused('request_not_settleable');
    await this.personal.recordPurchase(q, {
      userId: l.beneficiaryUserId, productId: l.productId, priceId: line[0]!.priceId, invoiceId: l.invoiceId, paymentRequestId: l.paymentRequestId,
      receiptId: l.receiptId, settledAt: app.settledAt, assistanceRequestId: l.assistanceRequestId, appliedAt: app.appliedAt,
    });
    const purchase = (await q.query<{ id: string }>(`SELECT id FROM subscription_purchase WHERE "invoiceId" = $1 AND "appliedAt" = $2::timestamptz`, [l.invoiceId, app.appliedAt])).rows[0];
    if (!purchase) throw lateSettlementRefused('purchase_exists');
    await q.query(`UPDATE assistance_settlement_channel SET status = 'settled' WHERE "invoiceId" = $1 AND status IN ('open', 'uncertain')`, [l.invoiceId]);
    await q.query(`UPDATE assistance_request SET status = 'settled' WHERE id = $1`, [l.assistanceRequestId]);
    await this.audit.record(q, 'assistance_late_settlement.applied', {
      organizationId: l.organizationId, resource: { type: 'assistance_late_settlement', id: l.id },
      changes: {
        assistance_request_id: l.assistanceRequestId, reason_code: input.reasonCode, purchase_id: purchase.id, evidence_count: input.evidence.length,
        ...(live ? { superseded_obligation_id: live.id } : {}),
      },
    }, ctx);
    this.log.log(`late_settlement_applied lateSettlement=${l.id} request=${l.assistanceRequestId} purchase=${purchase.id} superseded=${live?.id ?? 'none'}`);
    return { status: 201, body: await this.view(q, l) };
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
      throw billingError(503, 'late_settlement_authorization_unavailable', BILLING_MESSAGES.lateSettlementAuthorizationUnavailable);
    }
    if (out.kind === 'refused' || (out.kind === 'consumed' && out.consumption.approvedByUserId !== owner.userId)) {
      throw billingError(409, 'late_settlement_authorization_refused', BILLING_MESSAGES.lateSettlementAuthorizationRefused);
    }
    if (out.kind === 'unresolved') throw billingError(503, 'late_settlement_authorization_unresolved', BILLING_MESSAGES.lateSettlementAuthorizationUnresolved);
    return out.consumption;
  }
}
