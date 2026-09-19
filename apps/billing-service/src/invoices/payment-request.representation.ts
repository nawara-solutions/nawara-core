import { fromDbAmount, toJsonAmount } from '../domain/money.js';
import type { PaymentRequestRow } from './invoice.types.js';

/** The API representation of a payment request (SDD endpoint 14: `{ id, invoiceId, status, amount, currency, paymentId }`). */
export interface PaymentRequestRepresentation {
  id: string;
  invoiceId: string;
  status: string;
  amount: number;
  currency: string;
  paymentId: string | null;
}

export function representPaymentRequest(row: PaymentRequestRow): PaymentRequestRepresentation {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    status: row.status,
    amount: toJsonAmount(fromDbAmount(row.amount)),
    currency: row.currency,
    paymentId: row.paymentId,
  };
}
