import type { Queryable } from '@nawara/service-kit';
import type { PaymentRow } from './payment.types.js';

interface AttemptRepresentation {
  id: string;
  attemptNumber: number;
  provider: string;
  status: string;
  failureCode: string | null;
  createdAt: string;
}

/** The API representation of a payment (SDD section 9.2). No cash and no refunds exist yet in this phase. */
export interface PaymentRepresentation {
  id: string;
  paymentRequestId: string;
  sourceType: string;
  sourceId: string;
  payer: { type: string; id: string };
  seller: { type: string; id: string };
  organizationId: string | null;
  amount: number;
  currency: string;
  description: string | null;
  reference: string | null;
  expiresAt: string | null;
  status: string;
  statusReason: string | null;
  settledMethod: string | null;
  refundedAmount: number;
  refundableAmount: number;
  attempts: AttemptRepresentation[];
  cash: null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export async function representPayment(q: Queryable, payment: PaymentRow): Promise<PaymentRepresentation> {
  const { rows } = await q.query<{ id: string; attemptNumber: number; provider: string; status: string; failureCode: string | null; createdAt: Date }>(
    `SELECT id, "attemptNumber", provider, status, "failureCode", "initiatedAt" AS "createdAt"
     FROM payment_attempt WHERE "paymentId" = $1 ORDER BY "attemptNumber" DESC`,
    [payment.id],
  );
  return {
    id: payment.id,
    paymentRequestId: payment.paymentRequestId,
    sourceType: payment.sourceType,
    sourceId: payment.sourceId,
    payer: { type: payment.payerType, id: payment.payerId },
    seller: { type: payment.sellerType, id: payment.sellerId },
    organizationId: payment.organizationId,
    amount: Number(payment.amount),
    currency: payment.currency,
    description: payment.description,
    reference: payment.reference,
    expiresAt: payment.expiresAt ? payment.expiresAt.toISOString() : null,
    status: payment.status,
    statusReason: payment.statusReason,
    settledMethod: payment.settledMethod,
    refundedAmount: 0, // no refunds exist yet in this phase
    refundableAmount: payment.status === 'succeeded' ? Number(payment.amount) : 0,
    attempts: rows.map((r) => ({
      id: r.id,
      attemptNumber: r.attemptNumber,
      provider: r.provider,
      status: r.status,
      failureCode: r.failureCode,
      createdAt: r.createdAt.toISOString(),
    })),
    cash: null, // no cash workflow exists yet in this phase (blocked by O-4/O-5)
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
    closedAt: payment.closedAt ? payment.closedAt.toISOString() : null,
  };
}
