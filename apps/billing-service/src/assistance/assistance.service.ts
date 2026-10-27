import { Inject, Injectable } from '@nestjs/common';
import { DbService, type AuthIdentity, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import { OWNER_CATALOG_PRODUCER, type BillingConfig } from '../config/billing-config.js';
import type { TransitionContext } from '../domain/actors.js';
import { billingError, notFound, operationNotPermitted } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';
import { AssistanceAuthority, type AssistanceParties } from './assistance-authority.js';
import { AssistanceCommandIdempotency, type AssistanceCommandResult } from './assistance-idempotency.js';
import type { AssistanceCreateInput } from './assistance-input.js';

/** The row as stored, plus the overdue state the database derives at read time (D-6). */
interface AssistanceRow extends AssistanceParties {
  id: string;
  productId: string;
  priceId: string;
  currency: string;
  baseAmount: string;
  feeAmount: string;
  totalAmount: string;
  feeProposalId: string | null;
  feeCapVersion: number | null;
  consent: boolean;
  consentAt: Date;
  status: 'pending' | 'declined' | 'cash_collected';
  declinedByRole: 'beneficiary' | 'organization_actor' | null;
  declinedAt: Date | null;
  cashCollectedAt: Date | null;
  reportedAt: Date | null;
  settleBy: Date | null;
  createdAt: Date;
  overdue: boolean;
}

const SELECT_ROW = `SELECT id, "beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", trim(currency) AS currency, "baseAmount", "feeAmount",
  "totalAmount", "feeProposalId", "feeCapVersion", consent, "consentAt", status, "declinedByRole", "declinedAt", "cashCollectedAt", "reportedAt",
  "settleBy", "createdAt", billing_assistance_overdue(status, "settleBy") AS overdue FROM assistance_request`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * The representation every caller with a relation sees. The frozen terms are the ones the beneficiary consented to; `overdue` is derived
 * from the database's current time (D-6). No actor identifier other than the beneficiary is exposed.
 */
export function representAssistanceRequest(r: AssistanceRow) {
  return {
    id: r.id,
    status: r.status,
    beneficiaryUserId: r.beneficiaryUserId,
    organizationId: r.organizationId,
    platformId: r.platformId,
    productId: r.productId,
    priceId: r.priceId,
    currency: r.currency,
    baseAmount: Number(r.baseAmount),
    feeAmount: Number(r.feeAmount),
    totalAmount: Number(r.totalAmount),
    feeProposalId: r.feeProposalId,
    feeCapVersion: r.feeCapVersion,
    consent: r.consent,
    consentAt: iso(r.consentAt),
    declinedByRole: r.declinedByRole,
    declinedAt: iso(r.declinedAt),
    cashCollectedAt: iso(r.cashCollectedAt),
    reportedAt: iso(r.reportedAt),
    settleBy: iso(r.settleBy),
    overdue: r.overdue,
    createdAt: iso(r.createdAt),
  };
}

const memberNotEligible = () => billingError(403, 'member_not_eligible', BILLING_MESSAGES.assistanceMemberNotEligible);

/**
 * Core V2 S5a Organization assistance (register BIL-13, BIL-14, BIL-15 and the assistance read; FC-8; the Owner's D-1 to D-12).
 * DEVELOPMENT AND SIMULATION ONLY: production never mounts the routes and every method refuses there too (D-8, D-12); nothing configures
 * otherwise.
 *
 * Every command: the caller's live Auth identity (guard) and the Organization reference read are checked BEFORE the transaction (never a
 * network call while holding a lock), then ONE class-K transaction (D-10) holds the effect, its idempotency record and its audit intent
 * (D-9). What this never does (D-11): create an invoice, a payment request, a payment, a purchase or an entitlement, emit a domain event,
 * or treat a cash declaration as settlement. Restrictions (T1, T2, T3, inactivity) are S5d's and are not evaluated here (D-8).
 */
@Injectable()
export class AssistanceService {
  constructor(
    private readonly db: DbService,
    private readonly authority: AssistanceAuthority,
    private readonly idempotency: AssistanceCommandIdempotency,
    private readonly audit: BillingAudit,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  private refuseInProduction(): void {
    if (this.config.isProduction) throw notFound(); // second line of the production refusal (the routes are not mounted there)
  }

  /**
   * BIL-13 (D-1, D-2, D-3, D-7): `POST /billing/assistance-requests` `{organizationId, productId, priceId, consent: true}` → 201 the request
   * with its frozen terms. 403 `member_not_eligible` (not an active ordinary member with an active membership in that Organization on its
   * Platform); 409 `platform_not_configured` | `product_not_available` | `fee_not_usable` | `assistance_request_open`; 422 `price_not_available`.
   */
  async create(identity: AuthIdentity, key: string, input: AssistanceCreateInput, ctx: TransitionContext) {
    this.refuseInProduction();
    const platformId = await this.authority.beneficiaryPlatform(identity, input.organizationId);
    if (!platformId) throw memberNotEligible();
    const beneficiary = identity.id;
    return this.idempotency.run(beneficiary, key, 'assistance_request.create', { ...input }, async (q): Promise<AssistanceCommandResult> => {
      // D-7: one beneficiary's requests for one (Organization, product) are serialized whatever the key, so two can never both be created
      await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing.assistance_open:' || $1 || ':' || $2 || ':' || $3, 0))`, [beneficiary, input.organizationId, input.productId]);
      const platform = (await q.query<{ companyId: string; currency: string }>(`SELECT "companyId", trim(currency) AS currency FROM billing_platform WHERE "platformId" = $1`, [platformId])).rows[0];
      if (!platform) throw billingError(409, 'platform_not_configured', BILLING_MESSAGES.platformNotConfigured);
      // the authoritative offering, exactly as checkout sells it (S3f, S3g): an active Owner-catalog personal product of this Platform
      const product = (await q.query(
        `SELECT 1 FROM product WHERE id = $1 AND "platformId" = $2 AND "subscriptionTarget" = 'personal' AND status = 'active' AND "sellerType" = 'company' AND "sellerId" = $3 AND producer = $4`,
        [input.productId, platformId, platform.companyId, OWNER_CATALOG_PRODUCER])).rows[0];
      if (!product) throw billingError(409, 'product_not_available', BILLING_MESSAGES.productNotAvailable);
      const price = (await q.query<{ unitAmount: string }>(
        `SELECT "unitAmount" FROM price WHERE id = $1 AND "productId" = $2 AND "retiredAt" IS NULL AND "effectiveFrom" <= now() AND "interval" = 'recurring' AND currency = $3`,
        [input.priceId, input.productId, platform.currency])).rows[0];
      if (!price) throw billingError(422, 'price_not_available', BILLING_MESSAGES.priceNotAvailable);
      const open = (await q.query(`SELECT 1 FROM assistance_request WHERE "beneficiaryUserId" = $1 AND "organizationId" = $2 AND "productId" = $3 AND status <> 'declined'`,
        [beneficiary, input.organizationId, input.productId])).rows[0];
      if (open) throw billingError(409, 'assistance_request_open', BILLING_MESSAGES.assistanceRequestOpen);

      // D-1: the Organization's current approved fee, re-checked against the Platform's CURRENT cap under the fee lock (so no cap change or
      // approval interleaves); refused above the cap, never reduced; no approved fee is a fee of 0. The insert guard re-derives all of it.
      await q.query(`SELECT billing_fee_lock($1)`, [platformId]);
      const fee = (await q.query<{ proposalId: string; amount: string; usable: boolean }>(`SELECT "proposalId", amount, usable FROM billing_fee_for_use($1, $2)`,
        [input.organizationId, input.productId])).rows[0];
      if (fee && !fee.usable) throw billingError(409, 'fee_not_usable', BILLING_MESSAGES.feeNotUsable);
      const cap = (await q.query<{ version: number }>(`SELECT version FROM billing_current_fee_cap($1)`, [platformId])).rows[0];
      const baseAmount = Number(price.unitAmount);
      const feeAmount = fee ? Number(fee.amount) : 0;
      const { id } = (await q.query<{ id: string }>(
        `INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeProposalId", "feeCapVersion", consent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true) RETURNING id`,
        [beneficiary, input.organizationId, platformId, input.productId, input.priceId, platform.currency, baseAmount, feeAmount, baseAmount + feeAmount, fee?.proposalId ?? null, cap?.version ?? null])).rows[0];
      const created = (await this.load(q, id))!;
      await this.audit.record(q, 'assistance_request.created', {
        organizationId: created.organizationId,
        resource: { type: 'assistance_request', id: created.id },
        changes: { product_id: created.productId, price_id: created.priceId, base_amount: Number(created.baseAmount), fee_amount: Number(created.feeAmount), ...(created.feeProposalId ? { fee_proposal_id: created.feeProposalId } : {}) },
      }, ctx);
      return { status: 201, body: representAssistanceRequest(created) };
    });
  }

  /** The assistance read: the beneficiary or the request's Organization actor; anyone else (and an unknown id) is the collapsed 404. */
  async read(identity: AuthIdentity, id: string) {
    this.refuseInProduction();
    const row = await this.load(this.db, id);
    if (!row) throw notFound();
    const relation = await this.authority.relation(identity, row);
    if (!relation.beneficiary && !relation.organizationActor) throw notFound();
    return representAssistanceRequest(row);
  }

  /**
   * BIL-14 (D-4): `POST /billing/assistance-requests/:id/decline`. The beneficiary or the Organization actor, while the request is pending;
   * final. The actual authenticated actor and the database's time are recorded. 404 without a relation; 409 `assistance_request_not_pending`.
   */
  async decline(identity: AuthIdentity, key: string, id: string, ctx: TransitionContext) {
    this.refuseInProduction();
    const parties = await this.load(this.db, id);
    if (!parties) throw notFound();
    const relation = await this.authority.relation(identity, parties);
    if (!relation.beneficiary && !relation.organizationActor) throw notFound();
    const role = relation.beneficiary ? 'beneficiary' : 'organization_actor'; // the beneficiary declines as themself, administrator or not
    return this.idempotency.run(identity.id, key, 'assistance_request.decline', { id }, async (q): Promise<AssistanceCommandResult> => {
      const current = await this.load(q, id, true);
      if (current!.status !== 'pending') throw billingError(409, 'assistance_request_not_pending', BILLING_MESSAGES.assistanceRequestNotPending);
      await q.query(`UPDATE assistance_request SET status = 'declined', "declinedBy" = $2, "declinedByRole" = $3 WHERE id = $1`, [id, identity.id, role]);
      const updated = (await this.load(q, id))!;
      await this.audit.record(q, 'assistance_request.declined', {
        organizationId: updated.organizationId, resource: { type: 'assistance_request', id }, changes: { declined_by: role },
      }, ctx);
      return { status: 200, body: representAssistanceRequest(updated) };
    });
  }

  /**
   * BIL-15 (D-5, D-6, D-11): `POST /billing/assistance-requests/:id/cash-collection` `{cashCollectedAt}`. The Organization actor only, never
   * the beneficiary of the same request (403 `operation_not_permitted`); 404 without a relation. `consentAt <= cashCollectedAt <= now`
   * (database time) else 422 `cash_collection_time_invalid`; once only (409 `cash_collection_already_reported`); a declined request is
   * 409 `assistance_request_not_pending`. The report is the complete frozen total; it is evidence, never settlement.
   */
  async reportCashCollection(identity: AuthIdentity, key: string, id: string, input: { cashCollectedAt: string }, ctx: TransitionContext) {
    this.refuseInProduction();
    const parties = await this.load(this.db, id);
    if (!parties) throw notFound();
    const relation = await this.authority.relation(identity, parties);
    if (!relation.beneficiary && !relation.organizationActor) throw notFound();
    if (relation.beneficiary) throw operationNotPermitted(); // D-5: the beneficiary never reports their own collection, administrator or not
    return this.idempotency.run(identity.id, key, 'assistance_request.cash_collection', { id, ...input }, async (q): Promise<AssistanceCommandResult> => {
      const current = (await this.load(q, id, true))!;
      if (current.status === 'cash_collected') throw billingError(409, 'cash_collection_already_reported', BILLING_MESSAGES.cashCollectionAlreadyReported);
      if (current.status !== 'pending') throw billingError(409, 'assistance_request_not_pending', BILLING_MESSAGES.assistanceRequestNotPending);
      const ordered = (await q.query<{ ok: boolean }>(`SELECT ($1::timestamptz >= $2::timestamptz AND $1::timestamptz <= now()) AS ok`, [input.cashCollectedAt, current.consentAt])).rows[0];
      if (!ordered.ok) throw billingError(422, 'cash_collection_time_invalid', BILLING_MESSAGES.cashCollectionTimeInvalid);
      await q.query(`UPDATE assistance_request SET status = 'cash_collected', "cashCollectedAt" = $2, "reportedBy" = $3 WHERE id = $1`, [id, input.cashCollectedAt, identity.id]);
      const updated = (await this.load(q, id))!;
      await this.audit.record(q, 'assistance_request.cash_collection_reported', {
        organizationId: updated.organizationId, resource: { type: 'assistance_request', id },
        changes: { cash_collected_at: iso(updated.cashCollectedAt)!, settle_by: iso(updated.settleBy)! },
      }, ctx);
      return { status: 200, body: representAssistanceRequest(updated) };
    });
  }

  private async load(q: Queryable, id: string, forUpdate = false): Promise<AssistanceRow | null> {
    return (await q.query<AssistanceRow>(`${SELECT_ROW} WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id])).rows[0] ?? null;
  }
}
