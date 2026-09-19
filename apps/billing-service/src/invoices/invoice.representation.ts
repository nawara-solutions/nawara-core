import { fromDbAmount, toJsonAmount } from '../domain/money.js';
import type { InvoiceLineRow, InvoiceListRow, InvoiceRecord } from './invoice.types.js';

interface InvoiceLineRepresentation {
  id: string;
  lineNumber: number;
  productCode: string;
  description: string;
  quantity: number;
  unitAmount: number;
  lineTotal: number;
  taxAmount: number;
  currency: string;
  sourceType: string | null;
  sourceId: string | null;
}

interface ActivePaymentRequestRepresentation {
  id: string;
  status: string;
  paymentId: string | null;
}

/** The financial-history fields common to the detail and list representations (SDD section 9). Never `billing_transition`: that is internal audit history, not customer-facing billing history (section 8 of the Stage 3 brief). */
export interface InvoiceCommonRepresentation {
  id: string;
  invoiceRequestId: string;
  number: string | null;
  status: string;
  isOverdue: boolean;
  seller: { type: string; id: string };
  payer: { type: string; id: string };
  organizationId: string | null;
  sourceType: string;
  sourceId: string;
  description: string | null;
  currency: string;
  subtotal: number;
  taxTotal: number;
  total: number;
  amountPaid: number;
  amountDue: number;
  taxTreatment: string;
  dueAt: string | null;
  issuedAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  activePaymentRequest: ActivePaymentRequestRepresentation | null;
}

export interface InvoiceRepresentation extends InvoiceCommonRepresentation {
  lines: InvoiceLineRepresentation[];
}

export type InvoiceSummaryRepresentation = InvoiceCommonRepresentation;

function representLine(l: InvoiceLineRow): InvoiceLineRepresentation {
  return {
    id: l.id,
    lineNumber: l.lineNumber,
    productCode: l.productCode,
    description: l.description,
    quantity: l.quantity,
    unitAmount: toJsonAmount(fromDbAmount(l.unitAmount)),
    lineTotal: toJsonAmount(fromDbAmount(l.lineTotal)),
    taxAmount: toJsonAmount(fromDbAmount(l.taxAmount)),
    currency: l.currency,
    sourceType: l.sourceType,
    sourceId: l.sourceId,
  };
}

function common(
  row: Pick<
    InvoiceRecord,
    'id' | 'invoiceRequestId' | 'number' | 'status' | 'isOverdue' | 'sellerType' | 'sellerId' | 'payerType' | 'payerId' | 'organizationId' | 'sourceType' | 'sourceId' | 'description' |
    'currency' | 'subtotal' | 'taxTotal' | 'total' | 'taxTreatment' | 'dueAt' | 'issuedAt' | 'paidAt' | 'voidedAt' | 'createdAt' | 'updatedAt'
  >,
  activePaymentRequest: ActivePaymentRequestRepresentation | null,
): InvoiceCommonRepresentation {
  const total = fromDbAmount(row.total);
  // v1 restriction (BI-09, BI-14): at most one PAID request, and it always equals the full total — so "paid" is binary,
  // never a partial sum. Equivalent to `total - Σ paid requests` under that restriction; revisit if B-010 unlocks partial payments.
  const paid = row.status === 'paid';
  return {
    id: row.id,
    invoiceRequestId: row.invoiceRequestId,
    number: row.number,
    status: row.status,
    isOverdue: row.isOverdue,
    seller: { type: row.sellerType, id: row.sellerId },
    payer: { type: row.payerType, id: row.payerId },
    organizationId: row.organizationId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    description: row.description,
    currency: row.currency,
    subtotal: toJsonAmount(fromDbAmount(row.subtotal)),
    taxTotal: toJsonAmount(fromDbAmount(row.taxTotal)),
    total: toJsonAmount(total),
    amountPaid: toJsonAmount(paid ? total : 0n),
    amountDue: toJsonAmount(paid ? 0n : total),
    taxTreatment: row.taxTreatment,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    activePaymentRequest,
  };
}

/** The full detail representation (endpoint 8: `GET /billing/invoices/{id}`), with lines. */
export function representInvoice(invoice: InvoiceRecord, activePaymentRequest: ActivePaymentRequestRepresentation | null): InvoiceRepresentation {
  return { ...common(invoice, activePaymentRequest), lines: invoice.lines.map(representLine) };
}

/** The list-item representation (endpoint 9: `GET /billing/invoices`), without lines (unbounded for a page of up to 100). */
export function representInvoiceSummary(row: InvoiceListRow): InvoiceSummaryRepresentation {
  const activePaymentRequest = row.activePaymentRequestId
    ? { id: row.activePaymentRequestId, status: row.activePaymentRequestStatus!, paymentId: row.activePaymentRequestPaymentId }
    : null;
  return common(row, activePaymentRequest);
}
