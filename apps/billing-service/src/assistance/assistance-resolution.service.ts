import { Inject, Injectable } from '@nestjs/common';
import { DbService, type AuthIdentity, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import type { TransitionContext } from '../domain/actors.js';
import { billingError, notFound, operationNotPermitted } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';
import { OWNER_AUTHORITY, type BillingStepUpPurpose, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import { AssistanceAuthority, type AssistanceParties } from './assistance-authority.js';
import { lockOrganization } from './assistance-restrictions.js';
import { AssistanceCommandIdempotency, type AssistanceCommandResult, type AssistanceOperation } from './assistance-idempotency.js';
import type { CORRECTION_REASONS, CorrectableField, DisputeReason } from './assistance-input.js';
import { CORRECTION_COLUMNS, DISPUTE_COLUMNS, OBLIGATION_COLUMNS, representCashReturnObligation, representCorrection, representDispute } from './assistance-settlement.view.js';

/** The Owner the guard verified live (`/auth/grants`), with their own bearer for the per-request Platform and step-up checks. */
export interface VerifiedAssistanceOwner {
  userId: string;
  bearer: string;
}

const stepUpRequired = () => billingError(403, 'step_up_required', BILLING_MESSAGES.stepUpRequired);
const disputeOpen = () => billingError(409, 'assistance_dispute_open', BILLING_MESSAGES.assistanceDisputeOpen);
const disputeNotOpen = () => billingError(409, 'assistance_dispute_not_open', BILLING_MESSAGES.assistanceDisputeNotOpen);
const correctionNotPermitted = () => billingError(409, 'correction_not_permitted', BILLING_MESSAGES.correctionNotPermitted);
const resolutionNotPermitted = () => billingError(409, 'resolution_not_permitted', BILLING_MESSAGES.resolutionNotPermitted);
/** The correction a timestamp dispute rests on (J-2): its reason names exactly one Organization-asserted time. */
const DISPUTED_FIELD: Partial<Record<DisputeReason, CorrectableField>> = { collection_time_incorrect: 'cashCollectedAt', return_time_incorrect: 'returnedAt' };
/** The audit vocabulary of a corrected field (lowercase codes). */
const AUDIT_FIELD = { cashCollectedAt: 'cash_collected_at', returnedAt: 'returned_at' } as const satisfies Record<CorrectableField, string>;

/**
 * Core V2 S5c: beneficiary cash-return confirmation, assistance disputes, Organization responses, and the Owner's timestamp corrections and
 * nonfinancial dispute resolutions (register BIL-18 to BIL-22; S0 FC-8, DN-1.2; the Owner's H-1 to H-7 and J-1 to J-6). DEVELOPMENT AND
 * SIMULATION ONLY: production never mounts the routes and every method refuses there too.
 *
 * Authority is decided BEFORE any transaction, live (never a network call while holding a lock). Every command is ONE class-K transaction
 * (D-10) holding its effect, its idempotency record and its audit intent, and takes its locks in the H-7 order: the assistance request,
 * then its cash-return obligation, then its dispute. The database re-checks every rule. What S5c never does (J-1, J-2): discharge an
 * obligation on anyone's word but the beneficiary's, reopen or void a report, create, reverse or refund a purchase or a payment, or
 * touch a settlement channel or a verified Payment fact. `resolved_by_owner` stays reserved and inactive.
 */
@Injectable()
export class AssistanceResolutionService {
  constructor(
    private readonly db: DbService,
    private readonly authority: AssistanceAuthority,
    private readonly idempotency: AssistanceCommandIdempotency,
    private readonly audit: BillingAudit,
    @Inject(OWNER_AUTHORITY) private readonly owners: OwnerAuthority,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  private refuseInProduction(): void {
    if (this.config.isProduction) throw notFound();
  }

  /** The beneficiary only: the Organization actor is 403 (a relation, not this one), anyone else the collapsed 404. */
  private async beneficiary(identity: AuthIdentity, parties: AssistanceParties): Promise<void> {
    const relation = await this.authority.relation(identity, parties);
    if (!relation.beneficiary && !relation.organizationActor) throw notFound();
    if (!relation.beneficiary) throw operationNotPermitted();
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the beneficiary

  /**
   * BIL-18 (H-3, J-4, J-6): `POST /billing/cash-return-obligations/:id/confirm`. Only the request's beneficiary, live. `return_reported`
   * only (`409 cash_return_not_reported` while open; `409 cash_return_already_confirmed`); never while a dispute of the request is open
   * (`409 assistance_dispute_open`). One transaction confirms the obligation and returns the request, which resolves it (the D-7 slot is
   * free). Confirmation creates no purchase, payment or entitlement.
   */
  async confirmReturn(identity: AuthIdentity, key: string, obligationId: string, ctx: TransitionContext) {
    this.refuseInProduction();
    const parties = (await this.db.query<AssistanceParties & { assistanceRequestId: string }>(
      `SELECT o."assistanceRequestId", a."beneficiaryUserId", a."organizationId", a."platformId" FROM cash_return_obligation o JOIN assistance_request a ON a.id = o."assistanceRequestId" WHERE o.id = $1`,
      [obligationId])).rows[0];
    if (!parties) throw notFound();
    await this.beneficiary(identity, parties);
    return this.idempotency.run(identity.id, key, 'cash_return_obligation.confirm', { id: obligationId }, async (q): Promise<AssistanceCommandResult> => {
      await lockOrganization(q, parties.organizationId); // Core V2 S5d (S5D-5): the confirmation clears T1 and T2
      await q.query(`SELECT 1 FROM assistance_request WHERE id = $1 FOR UPDATE`, [parties.assistanceRequestId]);
      const o = (await q.query<{ status: string }>(`SELECT status FROM cash_return_obligation WHERE id = $1 FOR UPDATE`, [obligationId])).rows[0]!;
      if (o.status === 'open') throw billingError(409, 'cash_return_not_reported', BILLING_MESSAGES.cashReturnNotReported);
      if (o.status !== 'return_reported') throw billingError(409, 'cash_return_already_confirmed', BILLING_MESSAGES.cashReturnAlreadyConfirmed);
      if (await this.hasOpenDispute(q, parties.assistanceRequestId)) throw disputeOpen();
      await q.query(`UPDATE cash_return_obligation SET status = 'confirmed_returned', "confirmedBy" = $2 WHERE id = $1`, [obligationId, identity.id]);
      await q.query(`UPDATE assistance_request SET status = 'returned' WHERE id = $1`, [parties.assistanceRequestId]);
      await this.audit.record(q, 'cash_return_obligation.confirmed', {
        organizationId: parties.organizationId, resource: { type: 'cash_return_obligation', id: obligationId }, changes: { assistance_request_id: parties.assistanceRequestId },
      }, ctx);
      return { status: 200, body: await this.obligation(q, obligationId) };
    });
  }

  /**
   * BIL-20 (H-4, J-1, J-3, J-4): `POST /billing/assistance-requests/:id/disputes` `{reasonCode}`. Only the beneficiary, live; no filing
   * cutoff. The request must carry cash evidence (`cash_collected`, `settled` or `returned`) and the reason must concern evidence that
   * exists: `cash_not_returned` needs a cash-return obligation, `return_time_incorrect` a reported return (else `409
   * dispute_not_permitted`). One open dispute per request (`409 assistance_dispute_open`). A dispute changes no financial fact, never
   * re-takes the D-7 slot of a resolved request, and never blocks a verified Payment success or the sweep; it blocks the confirmation.
   */
  async openDispute(identity: AuthIdentity, key: string, requestId: string, input: { reasonCode: DisputeReason }, ctx: TransitionContext) {
    this.refuseInProduction();
    const parties = await this.parties(this.db, requestId);
    if (!parties) throw notFound();
    await this.beneficiary(identity, parties);
    return this.idempotency.run(identity.id, key, 'assistance_request.dispute', { id: requestId, ...input }, async (q): Promise<AssistanceCommandResult> => {
      const r = (await q.query<{ status: string }>(`SELECT status FROM assistance_request WHERE id = $1 FOR UPDATE`, [requestId])).rows[0]!;
      const o = (await q.query<{ returnedAt: Date | null }>(`SELECT "returnedAt" FROM cash_return_obligation WHERE id = billing_assistance_current_obligation($1)`, [requestId])).rows[0]; // Core V2 S6g: the current obligation
      if (!['cash_collected', 'settled', 'returned'].includes(r.status) || (input.reasonCode === 'cash_not_returned' && !o)
        || (input.reasonCode === 'return_time_incorrect' && !o?.returnedAt)) throw billingError(409, 'dispute_not_permitted', BILLING_MESSAGES.disputeNotPermitted);
      if (await this.hasOpenDispute(q, requestId)) throw disputeOpen();
      const { id } = (await q.query<{ id: string }>(
        `INSERT INTO assistance_dispute ("assistanceRequestId", "beneficiaryUserId", "organizationId", "reasonCode") VALUES ($1, $2, $3, $4) RETURNING id`,
        [requestId, parties.beneficiaryUserId, parties.organizationId, input.reasonCode])).rows[0]!;
      await this.audit.record(q, 'assistance_dispute.opened', {
        organizationId: parties.organizationId, resource: { type: 'assistance_dispute', id }, changes: { assistance_request_id: requestId, reason_code: input.reasonCode },
      }, ctx);
      return { status: 201, body: await this.dispute(q, id) };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the Organization

  /**
   * BIL-21 (H-5): `POST /billing/assistance-disputes/:id/responses` `{position}`. The Organization actor of the request's Organization,
   * live, never its beneficiary (403); once per dispute (`409 dispute_response_exists`), only while it is open (`409
   * assistance_dispute_not_open`). Evidence only: it changes no state and closes nothing.
   */
  async respond(identity: AuthIdentity, key: string, disputeId: string, input: { position: 'accepts' | 'contests' }, ctx: TransitionContext) {
    this.refuseInProduction();
    const parties = (await this.db.query<AssistanceParties & { assistanceRequestId: string }>(
      `SELECT d."assistanceRequestId", a."beneficiaryUserId", a."organizationId", a."platformId" FROM assistance_dispute d JOIN assistance_request a ON a.id = d."assistanceRequestId" WHERE d.id = $1`,
      [disputeId])).rows[0];
    if (!parties) throw notFound();
    const relation = await this.authority.relation(identity, parties);
    if (!relation.beneficiary && !relation.organizationActor) throw notFound();
    if (relation.beneficiary) throw operationNotPermitted(); // the beneficiary never answers their own dispute, administrator or not
    return this.idempotency.run(identity.id, key, 'assistance_dispute.respond', { id: disputeId, ...input }, async (q): Promise<AssistanceCommandResult> => {
      await q.query(`SELECT 1 FROM assistance_request WHERE id = $1 FOR UPDATE`, [parties.assistanceRequestId]);
      const d = (await q.query<{ status: string }>(`SELECT status FROM assistance_dispute WHERE id = $1 FOR UPDATE`, [disputeId])).rows[0]!;
      if (d.status !== 'open') throw disputeNotOpen();
      if ((await q.query(`SELECT 1 FROM assistance_dispute_response WHERE "disputeId" = $1`, [disputeId])).rows.length > 0) {
        throw billingError(409, 'dispute_response_exists', BILLING_MESSAGES.disputeResponseExists);
      }
      await q.query(`INSERT INTO assistance_dispute_response ("disputeId", position, "respondedBy") VALUES ($1, $2, $3)`, [disputeId, input.position, identity.id]);
      await this.audit.record(q, 'assistance_dispute.responded', {
        organizationId: parties.organizationId, resource: { type: 'assistance_dispute', id: disputeId }, changes: { position: input.position },
      }, ctx);
      return { status: 201, body: await this.dispute(q, disputeId) };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the Owner

  /**
   * BIL-19 (H-1, H-2 option A): `POST /billing/admin/assistance-requests/:id/corrections` `{field, value, reasonCode}` with the
   * `billing.assistance.correct` step-up. The Owner (guard, live) of the request's Platform (`/auth/platform-access`, live; else the
   * collapsed 404). Appends a correction of `cashCollectedAt` or `returnedAt` only when that time was reported (else `409
   * correction_not_permitted`, also for an unchanged value) and the corrected value keeps the recorded time order against the other
   * effective times (`422 correction_time_invalid`). The original evidence, `settleBy`, overdue, the obligation, channels, purchases and
   * payments never change.
   */
  async correct(owner: VerifiedAssistanceOwner, key: string, requestId: string, input: { field: CorrectableField; value: string; reasonCode: (typeof CORRECTION_REASONS)[number] }, stepUpToken: string | undefined, ctx: TransitionContext) {
    this.refuseInProduction();
    const parties = await this.parties(this.db, requestId);
    if (!parties) throw notFound();
    const operation: AssistanceOperation = 'assistance_request.correct';
    const request = { id: requestId, ...input };
    const ready = await this.ownerReady(owner, parties.platformId, key, operation, request, stepUpToken);
    if (ready) return ready;
    await this.correctable(this.db, requestId, input); // checked before the proof is spent, again under the lock
    await this.spendStepUp(owner, 'billing.assistance.correct', stepUpToken!);
    return this.idempotency.run(owner.userId, key, operation, request, async (q): Promise<AssistanceCommandResult> => {
      await q.query(`SELECT 1 FROM assistance_request WHERE id = $1 FOR UPDATE`, [requestId]);
      await q.query(`SELECT 1 FROM cash_return_obligation WHERE "assistanceRequestId" = $1 FOR UPDATE`, [requestId]);
      await this.correctable(q, requestId, input);
      const { id } = (await q.query<{ id: string }>(
        `INSERT INTO assistance_correction ("assistanceRequestId", field, "correctedValue", "reasonCode", "correctedBy") VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [requestId, input.field, input.value, input.reasonCode, owner.userId])).rows[0]!;
      const correction = await this.correction(q, id);
      await this.audit.record(q, 'assistance_request.corrected', {
        organizationId: parties.organizationId, resource: { type: 'assistance_request', id: requestId },
        changes: { correction_id: id, field: AUDIT_FIELD[input.field], corrected_value: correction.correctedValue, superseded_value: correction.supersededValue, reason_code: input.reasonCode },
        identity: id, // one record per correction: a request may be corrected many times (a deterministic id without it would collapse them)
      }, ctx);
      return { status: 201, body: correction };
    });
  }

  /**
   * BIL-22 (H-6, J-1, J-2): `POST /billing/admin/assistance-disputes/:id/resolution` `{outcome, correctionId}` with the
   * `billing.assistance.dispute.resolve` step-up. The Owner of the request's Platform, live. The only outcome S5c admits is the nonfinancial
   * `timestamp_corrected`: a `collection_time_incorrect` or `return_time_incorrect` dispute, closed on an Owner correction of exactly that
   * time appended after the dispute opened (else `409 resolution_not_permitted`). A `cash_not_returned` or `collection_not_made` dispute
   * has no resolution here and stays open (J-1). Never a discharge, a confirmation, a reversal or a payment.
   */
  async resolve(owner: VerifiedAssistanceOwner, key: string, disputeId: string, input: { outcome: 'timestamp_corrected'; correctionId: string }, stepUpToken: string | undefined, ctx: TransitionContext) {
    this.refuseInProduction();
    const parties = (await this.db.query<AssistanceParties & { assistanceRequestId: string }>(
      `SELECT d."assistanceRequestId", a."beneficiaryUserId", a."organizationId", a."platformId" FROM assistance_dispute d JOIN assistance_request a ON a.id = d."assistanceRequestId" WHERE d.id = $1`,
      [disputeId])).rows[0];
    if (!parties) throw notFound();
    const operation: AssistanceOperation = 'assistance_dispute.resolve';
    const request = { id: disputeId, ...input };
    const ready = await this.ownerReady(owner, parties.platformId, key, operation, request, stepUpToken);
    if (ready) return ready;
    await this.resolvable(this.db, disputeId, parties.assistanceRequestId, input.correctionId); // before the proof is spent, again under the lock
    await this.spendStepUp(owner, 'billing.assistance.dispute.resolve', stepUpToken!);
    return this.idempotency.run(owner.userId, key, operation, request, async (q): Promise<AssistanceCommandResult> => {
      await q.query(`SELECT 1 FROM assistance_request WHERE id = $1 FOR UPDATE`, [parties.assistanceRequestId]);
      await q.query(`SELECT 1 FROM cash_return_obligation WHERE "assistanceRequestId" = $1 FOR UPDATE`, [parties.assistanceRequestId]);
      await q.query(`SELECT 1 FROM assistance_dispute WHERE id = $1 FOR UPDATE`, [disputeId]);
      await this.resolvable(q, disputeId, parties.assistanceRequestId, input.correctionId);
      await q.query(`UPDATE assistance_dispute SET status = 'resolved', "resolvedBy" = $2, outcome = $3, "correctionId" = $4 WHERE id = $1`,
        [disputeId, owner.userId, input.outcome, input.correctionId]);
      await this.audit.record(q, 'assistance_dispute.resolved', {
        organizationId: parties.organizationId, resource: { type: 'assistance_dispute', id: disputeId }, changes: { outcome: input.outcome, correction_id: input.correctionId },
      }, ctx);
      return { status: 200, body: await this.dispute(q, disputeId) };
    });
  }

  /**
   * The Owner's live Platform scope (`/auth/platform-access`: an unknown request, or another Company's Platform, is the collapsed 404), then
   * a replay of this exact command (answered without spending a proof), then the step-up proof's presence. Returns the replay, or null.
   */
  private async ownerReady(owner: VerifiedAssistanceOwner, platformId: string, key: string, operation: AssistanceOperation, request: Record<string, unknown>, stepUpToken: string | undefined) {
    if (!(await this.owners.platformAllowed(owner.bearer, platformId, AbortSignal.timeout(this.config.authTimeoutMs)))) throw notFound();
    if (!stepUpToken) throw stepUpRequired();
    return this.idempotency.stored(owner.userId, key, operation, request);
  }

  /** Auth verifies and consumes the proof: this Owner, this session, exactly this purpose, once. Refused: 403 `step_up_required`. */
  private async spendStepUp(owner: VerifiedAssistanceOwner, purpose: BillingStepUpPurpose, token: string): Promise<void> {
    if (!(await this.owners.consumeStepUp(owner.bearer, purpose, token, AbortSignal.timeout(this.config.authTimeoutMs)))) throw stepUpRequired();
  }

  /** H-2: the time was reported, the value changes it, and the recorded time order holds with the other effective time. */
  private async correctable(q: Queryable, requestId: string, input: { field: CorrectableField; value: string }): Promise<void> {
    const r = (await q.query<{ status: string; ok: boolean | null; unchanged: boolean | null; reported: boolean }>(
      `SELECT a.status, o."returnedAt" IS NOT NULL AS reported,
              billing_assistance_effective_time(a.id, $2) = $3::timestamptz AS unchanged,
              (a."consentAt" <= c.v AND c.v <= a."reportedAt" AND (r.v IS NULL OR (c.v <= r.v AND r.v <= o."returnReportedAt"))) AS ok
         FROM assistance_request a
         LEFT JOIN cash_return_obligation o ON o.id = billing_assistance_current_obligation(a.id) -- Core V2 S6g: the current obligation
         CROSS JOIN LATERAL (SELECT CASE WHEN $2 = 'cashCollectedAt' THEN $3::timestamptz ELSE billing_assistance_effective_time(a.id, 'cashCollectedAt') END AS v) c
         CROSS JOIN LATERAL (SELECT CASE WHEN $2 = 'returnedAt' THEN $3::timestamptz ELSE billing_assistance_effective_time(a.id, 'returnedAt') END AS v) r
        WHERE a.id = $1`, [requestId, input.field, input.value])).rows[0]!;
    if (!['cash_collected', 'settled', 'returned'].includes(r.status) || (input.field === 'returnedAt' && !r.reported) || r.unchanged) throw correctionNotPermitted();
    if (!r.ok) throw billingError(422, 'correction_time_invalid', BILLING_MESSAGES.correctionTimeInvalid);
  }

  /** J-2: the dispute is open, its reason names a time, and the correction is of exactly that time, on this request, after it opened. */
  private async resolvable(q: Queryable, disputeId: string, requestId: string, correctionId: string): Promise<void> {
    const d = (await q.query<{ status: string; reasonCode: DisputeReason; openedAt: Date }>(`SELECT status, "reasonCode", "openedAt" FROM assistance_dispute WHERE id = $1`, [disputeId])).rows[0]!;
    if (d.status !== 'open') throw disputeNotOpen();
    const field = DISPUTED_FIELD[d.reasonCode];
    const c = (await q.query<{ field: string; correctedAt: Date }>(`SELECT field, "correctedAt" FROM assistance_correction WHERE id = $1 AND "assistanceRequestId" = $2`, [correctionId, requestId])).rows[0];
    if (!field || !c || c.field !== field || c.correctedAt < d.openedAt) throw resolutionNotPermitted();
  }

  private async hasOpenDispute(q: Queryable, requestId: string): Promise<boolean> {
    return (await q.query(`SELECT 1 FROM assistance_dispute WHERE "assistanceRequestId" = $1 AND status = 'open'`, [requestId])).rows.length > 0;
  }

  private async parties(q: Queryable, requestId: string): Promise<AssistanceParties | null> {
    return (await q.query<AssistanceParties>(`SELECT "beneficiaryUserId", "organizationId", "platformId" FROM assistance_request WHERE id = $1`, [requestId])).rows[0] ?? null;
  }

  private async obligation(q: Queryable, id: string) {
    return representCashReturnObligation((await q.query(`SELECT ${OBLIGATION_COLUMNS} FROM cash_return_obligation WHERE id = $1`, [id])).rows[0]);
  }

  private async dispute(q: Queryable, id: string) {
    return representDispute((await q.query(`SELECT ${DISPUTE_COLUMNS} FROM assistance_dispute d LEFT JOIN assistance_dispute_response p ON p."disputeId" = d.id WHERE d.id = $1`, [id])).rows[0]);
  }

  private async correction(q: Queryable, id: string) {
    return representCorrection((await q.query(`SELECT ${CORRECTION_COLUMNS} FROM assistance_correction WHERE id = $1`, [id])).rows[0]);
  }
}
