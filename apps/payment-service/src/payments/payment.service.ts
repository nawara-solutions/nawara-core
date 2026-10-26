import { PaymentAudit } from '../audit/payment-audit.js';
import { Inject, Injectable } from '@nestjs/common';
import { DbService, OutboxService, isUniqueViolation } from '@nawara/service-kit';
import { paymentEvent, requestContext, type EventContext } from '../events/payment-events.js';
import { paymentError } from '../errors.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import type { PaymentConfig } from '../config/payment-config.js';
import { canTransitionPayment, isTerminalPaymentStatus } from './payment-state-machine.js';
import { isPaymentUncertain } from './payment-closing.js';
import { ACCEPTED_PURPOSES, CORE_V2_LIVE_MODE, type PaymentPurpose, type PaymentRow } from './payment.types.js';
import type { CreatePaymentDto } from './dto/create-payment.dto.js';
import { OrganizationScopeService } from '../authorization/organization-scope.service.js';
import { PAYMENT_MESSAGES } from '../messages.js';

export interface CreatePaymentResult {
  payment: PaymentRow;
  replayed: boolean;
}

export interface CancelPaymentResult {
  payment: PaymentRow;
  replayed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SNAPSHOT_FIELDS = [
  'sourceType', 'sourceId', 'payerType', 'payerId', 'sellerType', 'sellerId', 'organizationId', 'amount', 'currency',
  'description', 'reference', 'purpose', 'beneficiaryUserId',
] as const;

@Injectable()
export class PaymentService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(PaymentAudit) private readonly audit: PaymentAudit,
    @Inject(OrganizationScopeService) private readonly organizationScope: OrganizationScopeService,
  ) {}

  /** Creates a payment, or replays an identical one (SDD sections 3.1–3.3, 6). */
  async create(producer: string, dto: CreatePaymentDto): Promise<CreatePaymentResult> {
    if (!this.config.supportedCurrencies.includes(dto.currency)) {
      throw paymentError(422, 'unsupported_currency', `Currency ${dto.currency} is not supported.`);
    }
    if (dto.payer.type === dto.seller.type && dto.payer.id === dto.seller.id) {
      throw paymentError(400, 'invalid_payment_request', PAYMENT_MESSAGES.payerSellerMustDiffer);
    }
    // An organization is identified by a uuid (the `organizationId` column is a uuid): a seller of that type whose id is
    // not one is a bad request, not a database error. Compared and stored in canonical (lower-case) form.
    let seller = dto.seller;
    let organizationId: string | null = dto.organizationId ? dto.organizationId.toLowerCase() : null;
    if (dto.seller.type === 'organization') {
      if (!UUID.test(dto.seller.id)) throw paymentError(400, 'invalid_payment_request', PAYMENT_MESSAGES.sellerIdMustBeUuid);
      seller = { type: dto.seller.type, id: dto.seller.id.toLowerCase() };
      if (organizationId && organizationId !== seller.id) {
        throw paymentError(400, 'invalid_payment_request', PAYMENT_MESSAGES.organizationIdMustEqualSeller);
      }
      organizationId = seller.id;
    }
    // The shape check in the DTO admits values such as 2026-13-45T00:00:00Z that are not instants.
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw paymentError(400, 'invalid_payment_request', PAYMENT_MESSAGES.expiresAtInvalid);
    const ctx = requestContext({ type: 'service', id: producer });

    // Core V2 S4a (P-1, P-2, P-3): a new payment names its purpose; only a replay of a payment created before S4a may omit it, and it is
    // answered with that historical record, never re-interpreted as purpose-bearing.
    if (dto.purpose === undefined) {
      const { rows: prior } = await this.db.query<PaymentRow>(`SELECT * FROM payment WHERE producer = $1 AND "paymentRequestId" = $2`, [producer, dto.paymentRequestId]);
      if (prior[0] && prior[0].purpose === null && isIdenticalSnapshot(prior[0], producer, dto, seller, organizationId, expiresAt)) return { payment: prior[0], replayed: true };
      throw paymentError(400, 'invalid_payment_request', PAYMENT_MESSAGES.purposeRequired);
    }
    // P-5, P-7: an unknown purpose, or an Organization-payer purpose whose workflow is not open yet, is 400 invalid_payment_request
    if (!(ACCEPTED_PURPOSES as readonly string[]).includes(dto.purpose)) throw paymentError(400, 'invalid_payment_request', PAYMENT_MESSAGES.purposeNotAccepted);
    assertPurposePairing(dto.purpose, dto.payer, dto.beneficiaryUserId);

    if (organizationId !== null) {
      // Stage 21.C.2 (ADR-0052 decision 3, ADR-0042 decision 5): a replay returns the record already created (and verified then) without
      // asking Organization Service; anything new is verified BEFORE the transaction, so a refusal or an unavailable authority writes
      // nothing. A concurrent identical create that wins the race is still handled by the unique-violation path below.
      const { rows: prior } = await this.db.query<PaymentRow>(`SELECT * FROM payment WHERE producer = $1 AND "paymentRequestId" = $2`, [producer, dto.paymentRequestId]);
      if (prior[0]) {
        if (isIdenticalSnapshot(prior[0], producer, dto, seller, organizationId, expiresAt)) return { payment: prior[0], replayed: true };
        throw paymentError(409, 'payment_request_conflict', PAYMENT_MESSAGES.paymentRequestConflict);
      }
      await this.organizationScope.assertInScope(producer, organizationId);
    }

    return this.db.tx(async (q) => {
      // A savepoint, not a bare try/catch: once a statement in a transaction errors, PostgreSQL aborts the whole
      // transaction (25P02) until a ROLLBACK — the recovery SELECT below needs the transaction usable again.
      await q.query('SAVEPOINT create_payment');
      try {
        const { rows } = await q.query<PaymentRow>(
          `INSERT INTO payment(
             producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId",
             "organizationId", amount, currency, description, reference, "expiresAt", purpose, "beneficiaryUserId", "liveMode"
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           RETURNING *`,
          [
            producer, dto.paymentRequestId, dto.sourceType, dto.sourceId, dto.payer.type, dto.payer.id, seller.type,
            seller.id, organizationId, dto.amount, dto.currency, dto.description ?? null, dto.reference ?? null, expiresAt,
            dto.purpose, dto.beneficiaryUserId ?? null, CORE_V2_LIVE_MODE, // liveMode: server-derived only (P-6)
          ],
        );
        const payment = rows[0];
        await this.outbox.enqueue(q, paymentEvent('payment.created', payment, ctx));
        await this.audit.record(q, 'payment.created', payment, ctx); // Stage 18.7.1: central audit intent, same transaction
        return { payment, replayed: false };
      } catch (e) {
        if (!isUniqueViolation(e, 'payment_request_id_unique')) throw e;
        await q.query('ROLLBACK TO SAVEPOINT create_payment');
        const { rows } = await q.query<PaymentRow>(`SELECT * FROM payment WHERE producer = $1 AND "paymentRequestId" = $2`, [producer, dto.paymentRequestId]);
        const existing = rows[0];
        if (isIdenticalSnapshot(existing, producer, dto, seller, organizationId, expiresAt)) return { payment: existing, replayed: true };
        throw paymentError(409, 'payment_request_conflict', PAYMENT_MESSAGES.paymentRequestConflict);
      }
    });
  }

  async findById(id: string): Promise<PaymentRow | null> {
    const { rows } = await this.db.query<PaymentRow>('SELECT * FROM payment WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  /**
   * Producer-only cancellation (SDD section 5.1, 9.1 endpoint 9), exposed over HTTP (Stage 4): `POST
   * /payment/payments/{id}/cancel`, `Idempotency-Key` required (SDD section 6). Cancelling a payment with an open
   * collection path is refused — money may already be in flight and must be resolved first, never silently abandoned.
   */
  async cancel(id: string, callerId: string, idempotencyKey: string, ctx: EventContext = requestContext({ type: 'service', id: callerId })): Promise<CancelPaymentResult> {
    const requestHash = IdempotencyService.requestHash('cancel_payment', `/payment/payments/${id}/cancel`, {});
    return this.db.tx(async (q) => {
      const reserved = await this.idempotency.reserve(q, {
        caller: `service:${callerId}`,
        operation: 'cancel_payment',
        key: idempotencyKey,
        requestHash,
        responseStatus: 200,
        resourceType: 'payment',
        resourceId: id,
      });
      if (reserved.replay) {
        const { rows } = await q.query<PaymentRow>('SELECT * FROM payment WHERE id = $1', [reserved.resourceId]);
        const payment = rows[0];
        if (!payment) throw paymentError(404, 'not_found', PAYMENT_MESSAGES.notFound);
        return { payment, replayed: true };
      }

      const { rows } = await q.query<PaymentRow>('SELECT * FROM payment WHERE id = $1 FOR UPDATE', [id]);
      const payment = rows[0];
      if (!payment) throw paymentError(404, 'not_found', PAYMENT_MESSAGES.notFound);
      // Core V2 S4c (F-1, F-7): a payment already closing answers its closing state again (no second side effect)
      if (payment.status === 'closing') return { payment, replayed: false };
      if (isTerminalPaymentStatus(payment.status) || !canTransitionPayment(payment.status, 'cancelled')) {
        throw paymentError(409, 'invalid_state_transition', PAYMENT_MESSAGES.cannotCancelInStatus, { status: payment.status });
      }
      // Core V2 S4c (F-1): while an attempt may still settle it, the cancel is recorded as closing (the controller answers 202); it ends
      // cancelled — or succeeded — only when the provider's evidence resolves every such attempt. No event until then (F-7).
      if (await isPaymentUncertain(q, id)) {
        const { rows: closing } = await q.query<PaymentRow>(`UPDATE payment SET status = 'closing', "closingReason" = 'cancel' WHERE id = $1 RETURNING *`, [id]);
        return { payment: closing[0], replayed: false };
      }
      const { rows: updated } = await q.query<PaymentRow>(
        `UPDATE payment SET status = 'cancelled', "closedAt" = now() WHERE id = $1 RETURNING *`,
        [id],
      );
      await this.outbox.enqueue(q, paymentEvent('payment.cancelled', updated[0], ctx));
      await this.audit.record(q, 'payment.cancelled', updated[0], ctx);
      return { payment: updated[0], replayed: false };
    });
  }
}

/**
 * Core V2 S4a (ADR-0044 B2 and B7; DB-15; the Owner's P-1, P-3, P-5, P-7): the payer and beneficiary each accepted purpose admits, checked
 * here and again by the database. An Organization never pays these purposes (DB-15); an Organization subscription and a direct purchase
 * are paid by a user; `non_entitlement` by a user or a Company. A direct purchase names its beneficiary, who is the payer; no other
 * accepted purpose names one. A payer that does not fit the purpose is `422 payer_purpose_mismatch`; a missing or extra field is `400`.
 */
function assertPurposePairing(purpose: PaymentPurpose, payer: { type: string; id: string }, beneficiaryUserId: string | undefined): void {
  const mismatch = () => paymentError(422, 'payer_purpose_mismatch', PAYMENT_MESSAGES.payerPurposeMismatch, { purpose });
  if (payer.type === 'organization') throw mismatch(); // DB-15: an Organization pays only assisted or recovery settlements (not accepted yet, P-5)
  if ((purpose === 'organization_subscription' || purpose === 'direct_purchase') && payer.type !== 'user') throw mismatch();
  if (purpose === 'direct_purchase') {
    if (beneficiaryUserId === undefined) throw paymentError(400, 'invalid_payment_request', PAYMENT_MESSAGES.beneficiaryRequired, { purpose });
    if (beneficiaryUserId !== payer.id) throw mismatch(); // the buyer pays for themself; a beneficiary is never another payer
  } else if (beneficiaryUserId !== undefined) {
    throw paymentError(400, 'invalid_payment_request', PAYMENT_MESSAGES.beneficiaryNotAllowed, { purpose });
  }
}

function isIdenticalSnapshot(
  existing: PaymentRow,
  producer: string,
  dto: CreatePaymentDto,
  seller: { type: string; id: string },
  organizationId: string | null,
  expiresAt: Date | null,
): boolean {
  if (existing.producer !== producer) return false;
  const candidate: Record<string, unknown> = {
    sourceType: dto.sourceType,
    sourceId: dto.sourceId,
    payerType: dto.payer.type,
    payerId: dto.payer.id,
    sellerType: seller.type,
    sellerId: seller.id,
    organizationId,
    amount: String(dto.amount),
    currency: dto.currency,
    description: dto.description ?? null,
    reference: dto.reference ?? null,
    purpose: dto.purpose ?? null,
    beneficiaryUserId: dto.beneficiaryUserId ?? null,
  };
  for (const field of SNAPSHOT_FIELDS) if (existing[field] !== candidate[field]) return false;
  const existingExpiry = existing.expiresAt ? new Date(existing.expiresAt).getTime() : null;
  const candidateExpiry = expiresAt ? expiresAt.getTime() : null;
  return existingExpiry === candidateExpiry;
}
