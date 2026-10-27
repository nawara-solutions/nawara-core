import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DbService, type AuthIdentity, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import { ASSISTANCE_PRODUCER, type BillingConfig } from '../config/billing-config.js';
import type { Caller, TransitionContext } from '../domain/actors.js';
import { billingError, notFound, operationNotPermitted } from '../domain/errors.js';
import { normaliseCreateInvoiceInput } from '../domain/invoice-input.js';
import { SYSTEM_TEMPLATE_V1 } from '../domain/snapshots.js';
import { InvoiceRepository } from '../invoices/invoice.repository.js';
import { PaymentRequestRepository } from '../invoices/payment-request.repository.js';
import { BILLING_MESSAGES } from '../messages.js';
import { AssistanceAuthority } from './assistance-authority.js';
import { AssistanceCommandIdempotency, type AssistanceCommandResult } from './assistance-idempotency.js';
import { OBLIGATION_COLUMNS, representCashReturnObligation } from './assistance-settlement.view.js';

const notSettleable = () => billingError(409, 'assistance_request_not_settleable', BILLING_MESSAGES.assistanceRequestNotSettleable);

/**
 * Core V2 S5b assisted electronic settlement and cash return (register BIL-16, BIL-17; ADR-0044 B2, B7, B14; S0 DB-5, DB-12, DB-13, FC-8;
 * the Owner's E-1 to E-13). DEVELOPMENT AND SIMULATION ONLY: production never mounts the routes and every method refuses there too.
 *
 * Both commands are taken by the Organization actor of the request's Organization (S5a D-5, live per request), never by its beneficiary.
 * Authority is checked BEFORE the transaction (never a network call while holding a lock); then ONE idempotent transaction holds the
 * effect, its idempotency record and its audit intent.
 */
@Injectable()
export class AssistanceSettlementService {
  constructor(
    private readonly db: DbService,
    private readonly authority: AssistanceAuthority,
    private readonly idempotency: AssistanceCommandIdempotency,
    private readonly invoices: InvoiceRepository,
    private readonly requests: PaymentRequestRepository,
    private readonly audit: BillingAudit,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  /** The Organization actor who is not the beneficiary; 403 for the beneficiary (administrator or not), the collapsed 404 for anyone else. */
  private async organizationActor(identity: AuthIdentity, parties: { beneficiaryUserId: string; organizationId: string; platformId: string }): Promise<void> {
    const relation = await this.authority.relation(identity, parties);
    if (!relation.beneficiary && !relation.organizationActor) throw notFound();
    if (relation.beneficiary) throw operationNotPermitted();
  }

  /**
   * BIL-16 (E-1 to E-5, E-11): `POST /billing/assistance-requests/:id/settlement` → `201 {invoiceId, paymentRequestId, paymentId: null}`.
   * Only a `cash_collected` request, before its `settleBy`, with no purchase and no cash-return obligation (else `409
   * assistance_request_not_settleable`), and with no open or uncertain channel (`409 settlement_channel_open`). One transaction opens the
   * channel, creates and issues the invoice of the reserved producer `billing-assistance` (an Organization payer; one line of the FROZEN
   * price at the frozen base, never the fee; routed `assisted_settlement` to the beneficiary) and its payment request. Payment is contacted
   * later by the existing dispatcher: `paymentId` stays null until Payment supplies one; a request is never a settlement.
   */
  async settle(identity: AuthIdentity, key: string, id: string, locale: string, ctx: TransitionContext) {
    if (this.config.isProduction) throw notFound(); // second line of the production refusal
    const parties = (await this.db.query<{ beneficiaryUserId: string; organizationId: string; platformId: string }>(
      `SELECT "beneficiaryUserId", "organizationId", "platformId" FROM assistance_request WHERE id = $1`, [id])).rows[0];
    if (!parties) throw notFound();
    await this.organizationActor(identity, parties);
    return this.idempotency.run(identity.id, key, 'assistance_request.settlement', { id }, async (q): Promise<AssistanceCommandResult> => {
      const r = (await q.query<{ status: string; organizationId: string; platformId: string; priceId: string; past: boolean }>(
        `SELECT status, "organizationId", "platformId", "priceId", now() > "settleBy" AS past FROM assistance_request WHERE id = $1 FOR UPDATE`, [id])).rows[0]!;
      if (r.status !== 'cash_collected' || r.past) throw notSettleable();
      const blocked = (await q.query<{ purchase: boolean; obligation: boolean; active: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM subscription_purchase WHERE "assistanceRequestId" = $1) AS purchase,
                EXISTS (SELECT 1 FROM cash_return_obligation WHERE "assistanceRequestId" = $1) AS obligation,
                EXISTS (SELECT 1 FROM assistance_settlement_channel WHERE "assistanceRequestId" = $1 AND status IN ('open', 'uncertain')) AS active`, [id])).rows[0]!;
      if (blocked.purchase || blocked.obligation) throw notSettleable();
      if (blocked.active) throw billingError(409, 'settlement_channel_open', BILLING_MESSAGES.settlementChannelOpen);
      // the Platform's Company from S3d: the SIMULATION commercial seller reference (S3f D4), never a verified legal seller (B-001, B-007)
      const platform = (await q.query<{ companyId: string }>(`SELECT "companyId" FROM billing_platform WHERE "platformId" = $1`, [r.platformId])).rows[0];
      if (!platform) throw billingError(409, 'platform_not_configured', BILLING_MESSAGES.platformNotConfigured);
      const invoiceRequestId = randomUUID();
      const draft = normaliseCreateInvoiceInput({
        invoiceRequestId,
        seller: { type: 'company', id: platform.companyId },
        payer: { type: 'organization', id: r.organizationId },
        organizationId: r.organizationId,
        sourceType: 'assistance_request',
        sourceId: id,
        issuerSnapshot: { schemaVersion: 2, partyType: 'company', companyId: platform.companyId, platformId: r.platformId, legalIdentity: 'not_determined' },
        billToSnapshot: { schemaVersion: 2, partyType: 'organization', organizationId: r.organizationId, legalIdentity: 'not_determined' },
        lines: [{ priceId: r.priceId, quantity: 1 }], // E-4: the frozen price; its unit amount is the frozen base (checked at commit)
      });
      const issuer: Caller = { kind: 'service', service: ASSISTANCE_PRODUCER };
      const { invoice } = await this.invoices.createDraftIn(q, ASSISTANCE_PRODUCER, draft, this.config.supportedCurrencies, ctx);
      const cap = (await q.query<{ version: number }>(`SELECT version FROM billing_current_fee_cap($1)`, [r.platformId])).rows[0];
      const channel = (await q.query<{ id: string }>(
        `INSERT INTO assistance_settlement_channel ("assistanceRequestId", "invoiceId", "feeCapVersion", "startedBy") VALUES ($1, $2, $3, $4) RETURNING id`,
        [id, invoice.id, cap?.version ?? null, identity.id])).rows[0]!;
      await this.invoices.issueIn(q, invoice.id, issuer, { template: SYSTEM_TEMPLATE_V1, locale }, ctx, { callerPlatforms: new Set([r.platformId]), organizationPlatformId: null });
      const { request } = await this.requests.createForInvoiceIn(q, invoice.id, issuer, ctx);
      await q.query(`UPDATE assistance_settlement_channel SET "paymentRequestId" = $2 WHERE id = $1`, [channel.id, request.id]);
      await this.audit.record(q, 'assistance_request.settlement_requested', {
        organizationId: r.organizationId, resource: { type: 'assistance_request', id }, changes: { invoice_id: invoice.id, payment_request_id: request.id }, identity: channel.id,
      }, ctx);
      return { status: 201, body: { invoiceId: invoice.id, paymentRequestId: request.id, paymentId: request.paymentId } };
    });
  }

  /**
   * BIL-17 (E-9): `POST /billing/cash-return-obligations/:id/return` `{returnedAt}`. The Organization actor (never the beneficiary) reports
   * the complete frozen amount returned: `cashCollectedAt <= returnedAt <= now` (database time; `422 cash_return_time_invalid`); only from
   * `open` (`409 cash_return_not_open`). The obligation becomes `return_reported`: reported, NOT discharged (the beneficiary confirms, S5c).
   */
  async reportReturn(identity: AuthIdentity, key: string, obligationId: string, input: { returnedAt: string }, ctx: TransitionContext) {
    if (this.config.isProduction) throw notFound();
    const parties = (await this.db.query<{ beneficiaryUserId: string; organizationId: string; platformId: string }>(
      `SELECT a."beneficiaryUserId", a."organizationId", a."platformId" FROM cash_return_obligation o JOIN assistance_request a ON a.id = o."assistanceRequestId" WHERE o.id = $1`,
      [obligationId])).rows[0];
    if (!parties) throw notFound();
    await this.organizationActor(identity, parties);
    return this.idempotency.run(identity.id, key, 'cash_return_obligation.return', { id: obligationId, ...input }, async (q): Promise<AssistanceCommandResult> => {
      const o = (await q.query<{ status: string; organizationId: string; cashCollectedAt: Date }>(
        `SELECT status, "organizationId", "cashCollectedAt" FROM cash_return_obligation WHERE id = $1 FOR UPDATE`, [obligationId])).rows[0]!;
      if (o.status !== 'open') throw billingError(409, 'cash_return_not_open', BILLING_MESSAGES.cashReturnNotOpen);
      const ordered = (await q.query<{ ok: boolean }>(`SELECT ($1::timestamptz >= $2::timestamptz AND $1::timestamptz <= now()) AS ok`, [input.returnedAt, o.cashCollectedAt])).rows[0]!;
      if (!ordered.ok) throw billingError(422, 'cash_return_time_invalid', BILLING_MESSAGES.cashReturnTimeInvalid);
      await q.query(`UPDATE cash_return_obligation SET status = 'return_reported', "returnedAt" = $2, "returnReportedBy" = $3 WHERE id = $1`, [obligationId, input.returnedAt, identity.id]);
      const updated = await this.loadObligation(q, obligationId);
      await this.audit.record(q, 'cash_return_obligation.return_reported', {
        organizationId: o.organizationId, resource: { type: 'cash_return_obligation', id: obligationId }, changes: { returned_at: updated.returnedAt! },
      }, ctx);
      return { status: 200, body: updated };
    });
  }

  private async loadObligation(q: Queryable, id: string) {
    const row = (await q.query<Parameters<typeof representCashReturnObligation>[0]>(`SELECT ${OBLIGATION_COLUMNS} FROM cash_return_obligation WHERE id = $1`, [id])).rows[0]!;
    return representCashReturnObligation(row);
  }
}
