import type { InvoiceStatus, PaymentRequestStatus } from '../domain/state-machines.js';

/** Shapes of the Billing tables as `pg` returns them: a `bigint` column arrives as a decimal STRING and is converted with `fromDbAmount`. */
export interface InvoiceRow {
  id: string;
  producer: string;
  invoiceRequestId: string;
  requestHash: string;
  sellerType: string;
  sellerId: string;
  payerType: string;
  payerId: string;
  organizationId: string | null;
  sourceType: string;
  sourceId: string;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  taxTreatment: string;
  description: string | null;
  dueAt: Date | null;
  number: string | null;
  status: InvoiceStatus;
  revision: number;
  createdAt: Date;
  issuedAt: Date | null;
  paidAt: Date | null;
  voidedAt: Date | null;
  overdueAt: Date | null;
  updatedAt: Date;
  voidReasonCode: string | null;
  issuerSnapshot: Record<string, unknown>;
  billToSnapshot: Record<string, unknown>;
  presentation: Record<string, unknown> | null;
  /** Derived by the DATABASE clock (SDD 17.1): open and past due. Never stored. */
  isOverdue: boolean;
}

export interface InvoiceLineRow {
  id: string;
  invoiceId: string;
  currency: string;
  lineNumber: number;
  priceId: string;
  productId: string;
  productCode: string;
  description: string;
  quantity: number;
  unitAmount: string;
  lineTotal: string;
  taxAmount: string;
  entitlementKind: string;
  interval: string;
  intervalUnit: string | null;
  intervalCount: number | null;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: Date;
}

export interface InvoiceRecord extends InvoiceRow {
  lines: InvoiceLineRow[];
}

export interface PaymentRequestRow {
  id: string;
  invoiceId: string;
  amount: string;
  currency: string;
  status: PaymentRequestStatus;
  paymentId: string | null;
  expiresAt: Date | null;
  mappingVersion: number;
  sendAttempts: number;
  sendingSince: Date | null;
  cancelRequestedAt: Date | null;
  failureCode: string | null;
  createdByType: string;
  createdById: string | null;
  revision: number;
  createdAt: Date;
  closedAt: Date | null;
  updatedAt: Date;
}

export interface InvoiceListFilters {
  status?: string;
  sourceType?: string;
  sourceId?: string;
  payerType?: string;
  payerId?: string;
  dueBefore?: Date;
}

export interface InvoiceListRow extends InvoiceRow {
  activePaymentRequestId: string | null;
  activePaymentRequestStatus: string | null;
  activePaymentRequestPaymentId: string | null;
}

export interface PriceForInvoice {
  priceId: string;
  productId: string;
  productCode: string;
  productName: string;
  sellerType: string;
  sellerId: string;
  entitlementKind: string;
  currency: string;
  unitAmount: string;
  interval: string;
  intervalUnit: string | null;
  intervalCount: number | null;
  available: boolean;
}

/** SELECT list for an invoice, adding the database-clock overdue flag. */
export const INVOICE_COLUMNS = `*, (status = 'open' AND "dueAt" IS NOT NULL AND "dueAt" <= now()) AS "isOverdue"`;
