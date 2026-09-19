import { Inject, Injectable } from '@nestjs/common';
import { DbService, OutboxService, isUniqueViolation } from '@nawara/service-kit';
import { deterministicEventId } from '../events/deterministic-id.js';
import { paymentError } from '../errors.js';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import type { PaymentConfig } from '../config/payment-config.js';
import { canTransitionPayment, isTerminalPaymentStatus } from './payment-state-machine.js';
import type { PaymentRow } from './payment.types.js';
import type { CreatePaymentDto } from './dto/create-payment.dto.js';

export interface CreatePaymentResult {
  payment: PaymentRow;
  replayed: boolean;
}

const SNAPSHOT_FIELDS = [
  'sourceType', 'sourceId', 'payerType', 'payerId', 'sellerType', 'sellerId', 'organizationId', 'amount', 'currency',
  'description', 'reference',
] as const;

@Injectable()
export class PaymentService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
  ) {}

  /** Creates a payment, or replays an identical one (SDD sections 3.1–3.3, 6). */
  async create(producer: string, dto: CreatePaymentDto): Promise<CreatePaymentResult> {
    if (!this.config.supportedCurrencies.includes(dto.currency)) {
      throw paymentError(422, 'unsupported_currency', `Currency ${dto.currency} is not supported.`);
    }
    if (dto.payer.type === dto.seller.type && dto.payer.id === dto.seller.id) {
      throw paymentError(400, 'invalid_payment_request', 'payer and seller must differ.');
    }
    let organizationId: string | null = dto.organizationId ?? null;
    if (dto.seller.type === 'organization') {
      if (organizationId && organizationId !== dto.seller.id) {
        throw paymentError(400, 'invalid_payment_request', 'organizationId must equal seller.id when seller.type is organization.');
      }
      organizationId = dto.seller.id;
    }
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    return this.db.tx(async (q) => {
      // A savepoint, not a bare try/catch: once a statement in a transaction errors, PostgreSQL aborts the whole
      // transaction (25P02) until a ROLLBACK — the recovery SELECT below needs the transaction usable again.
      await q.query('SAVEPOINT create_payment');
      try {
        const { rows } = await q.query<PaymentRow>(
          `INSERT INTO payment(
             producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId",
             "organizationId", amount, currency, description, reference, "expiresAt"
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING *`,
          [
            producer, dto.paymentRequestId, dto.sourceType, dto.sourceId, dto.payer.type, dto.payer.id, dto.seller.type,
            dto.seller.id, organizationId, dto.amount, dto.currency, dto.description ?? null, dto.reference ?? null, expiresAt,
          ],
        );
        const payment = rows[0];
        await this.outbox.enqueue(q, {
          id: deterministicEventId(payment.id, 'payment.created'),
          name: 'payment.created',
          payload: eventPayload(payment),
        });
        return { payment, replayed: false };
      } catch (e) {
        if (!isUniqueViolation(e, 'payment_request_id_unique')) throw e;
        await q.query('ROLLBACK TO SAVEPOINT create_payment');
        const { rows } = await q.query<PaymentRow>(`SELECT * FROM payment WHERE producer = $1 AND "paymentRequestId" = $2`, [producer, dto.paymentRequestId]);
        const existing = rows[0];
        if (isIdenticalSnapshot(existing, producer, dto, organizationId, expiresAt)) return { payment: existing, replayed: true };
        throw paymentError(409, 'payment_request_conflict', 'A payment already exists for this paymentRequestId with a different snapshot.');
      }
    });
  }

  async findById(id: string): Promise<PaymentRow | null> {
    const { rows } = await this.db.query<PaymentRow>('SELECT * FROM payment WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  /** Producer-only cancellation (SDD section 5.1, 9.1 endpoint 9). No HTTP route in this phase; kept for internal use
   * (expiry/cancellation share the same "no open collection" guard) and so the state machine is exercised end to end. */
  async cancel(id: string): Promise<PaymentRow> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<PaymentRow>('SELECT * FROM payment WHERE id = $1 FOR UPDATE', [id]);
      const payment = rows[0];
      if (!payment) throw paymentError(404, 'not_found', 'Not found.');
      if (isTerminalPaymentStatus(payment.status) || !canTransitionPayment(payment.status, 'cancelled')) {
        throw paymentError(409, 'invalid_state_transition', `Cannot cancel a payment in status ${payment.status}.`);
      }
      const { rows: openAttempts } = await q.query(
        `SELECT 1 FROM payment_attempt WHERE "paymentId" = $1 AND status IN ('initiated','submitted','unknown')`,
        [id],
      );
      if (openAttempts.length > 0) throw paymentError(409, 'payment_has_open_attempt', 'An attempt is still open.');
      const { rows: updated } = await q.query<PaymentRow>(
        `UPDATE payment SET status = 'cancelled', "closedAt" = now() WHERE id = $1 RETURNING *`,
        [id],
      );
      await this.outbox.enqueue(q, {
        id: deterministicEventId(id, 'payment.cancelled'),
        name: 'payment.cancelled',
        payload: eventPayload(updated[0]),
      });
      return updated[0];
    });
  }
}

function isIdenticalSnapshot(
  existing: PaymentRow,
  producer: string,
  dto: CreatePaymentDto,
  organizationId: string | null,
  expiresAt: Date | null,
): boolean {
  if (existing.producer !== producer) return false;
  const candidate: Record<string, unknown> = {
    sourceType: dto.sourceType,
    sourceId: dto.sourceId,
    payerType: dto.payer.type,
    payerId: dto.payer.id,
    sellerType: dto.seller.type,
    sellerId: dto.seller.id,
    organizationId,
    amount: String(dto.amount),
    currency: dto.currency,
    description: dto.description ?? null,
    reference: dto.reference ?? null,
  };
  for (const field of SNAPSHOT_FIELDS) if (existing[field] !== candidate[field]) return false;
  const existingExpiry = existing.expiresAt ? new Date(existing.expiresAt).getTime() : null;
  const candidateExpiry = expiresAt ? expiresAt.getTime() : null;
  return existingExpiry === candidateExpiry;
}

function eventPayload(payment: PaymentRow): Record<string, unknown> {
  return {
    paymentId: payment.id,
    paymentRequestId: payment.paymentRequestId,
    sourceType: payment.sourceType,
    sourceId: payment.sourceId,
    organizationId: payment.organizationId,
    payer: { type: payment.payerType, id: payment.payerId },
    seller: { type: payment.sellerType, id: payment.sellerId },
    amount: Number(payment.amount),
    currency: payment.currency,
    status: payment.status,
    revision: payment.revision,
  };
}
