/**
 * The pure transition tables of SDD section 17. The services use them, and a test proves they agree with the database triggers
 * on EVERY (from, to) pair, so code and database cannot drift.
 */

// ---------------------------------------------------------------------------------------------------------------- invoice
export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

// `open -> void` is NOT here: whether an issued invoice may be voided at all is B-015 (a migration and this table gain it together).
// `partially_paid` (B-010) and `uncollectible` (B-014) are reserved and do not exist. `overdue` is derived, never a state.
const INVOICE_ALLOWED: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ['open', 'void'],
  open: ['paid'],
  paid: [],
  void: [],
};

export function canTransitionInvoice(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_ALLOWED[from].includes(to);
}

export function isTerminalInvoiceStatus(s: InvoiceStatus): boolean {
  return INVOICE_ALLOWED[s].length === 0;
}

/** Overdue is DERIVED (SDD 17.1): an open invoice whose due date has passed. `now` must be the database clock. */
export function isOverdue(invoice: { status: InvoiceStatus; dueAt: Date | null }, now: Date): boolean {
  return invoice.status === 'open' && invoice.dueAt !== null && invoice.dueAt.getTime() <= now.getTime();
}

// ------------------------------------------------------------------------------------------------------- payment request
export const PAYMENT_REQUEST_STATUSES = ['created', 'sending', 'requested', 'paid', 'failed', 'cancelled', 'expired', 'rejected'] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

const REQUEST_ALLOWED: Record<PaymentRequestStatus, readonly PaymentRequestStatus[]> = {
  created: ['sending', 'cancelled'],
  sending: ['requested', 'rejected'],
  requested: ['paid', 'failed', 'expired', 'cancelled'],
  paid: [],
  failed: [],
  cancelled: [],
  expired: [],
  rejected: [],
};

export function canTransitionPaymentRequest(from: PaymentRequestStatus, to: PaymentRequestStatus): boolean {
  return REQUEST_ALLOWED[from].includes(to);
}

export function isTerminalPaymentRequestStatus(s: PaymentRequestStatus): boolean {
  return REQUEST_ALLOWED[s].length === 0;
}

/** BI-13: at most one request in these states per invoice. */
export const ACTIVE_PAYMENT_REQUEST_STATUSES: readonly PaymentRequestStatus[] = ['created', 'sending', 'requested'];
