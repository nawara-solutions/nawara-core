import type { InvoiceStatus, PaymentRequestStatus } from './state-machines.js';

/**
 * The pure DECISION half of consuming a Payment event (SDD 21.4). It reads facts and returns what to do; it does no I/O, so every case is
 * exhaustively testable, and the (later) consumer and reconciler apply the SAME function under the invoice lock.
 *
 * It follows Payment's own semantics and invents no payment state. Payment emits at most ONE terminal event per payment, so
 * `succeeded -> failed -> succeeded` and `failed -> succeeded` cannot be produced by Payment; if one ever arrived it is a recorded
 * `conflict`, never a transition.
 *
 * Above all: an event NEVER binds a `paymentId` to a request. Only Billing's own authenticated call (or the reconciler, reading
 * with Billing's service token) may record one. An event that arrives before that is `deferred`, and the reconciler completes the
 * request. Payment events now carry `producer` (Stage 4): checked below as ADDITIONAL, cheap-to-reject isolation evidence, never a
 * replacement for the full snapshot comparison that already independently closes the same gap (another producer reusing Billing's
 * `paymentRequestId` fails on `paymentId`/snapshot equality regardless of what `producer` says).
 */
export type PaymentEventName = 'payment.succeeded' | 'payment.failed' | 'payment.cancelled' | 'payment.expired';

/** This service's own name, as Payment's `producer` field must read for any event Billing may legitimately apply. */
export const EXPECTED_PRODUCER = 'billing-service';

export interface PaymentEventFacts {
  name: PaymentEventName;
  /** The `source` header of the message. */
  source: string;
  paymentId: string;
  /** Payment's own record of who created the payment (Stage 4). Additional evidence only — see the module doc comment. */
  producer: string;
  paymentRequestId: string;
  sourceType: string;
  sourceId: string;
  payer: { type: string; id: string };
  seller: { type: string; id: string };
  organizationId: string | null;
  /** A JSON number in the payload. */
  amount: unknown;
  currency: string;
  revision: number;
  /** Core V2 S4a (optional, added to version 1): absent on a payment created before S4a. */
  purpose?: string;
  beneficiaryUserId?: string;
  liveMode?: boolean;
}

export interface RequestFacts {
  id: string;
  status: PaymentRequestStatus;
  paymentId: string | null;
  amount: bigint;
  currency: string;
  /** Core V2 S4a: the mapping version the request pinned (2 sends the routing purpose and beneficiary; 1 sent neither). */
  mappingVersion?: number;
}

export interface InvoiceFacts {
  id: string;
  status: InvoiceStatus;
  payerType: string;
  payerId: string;
  sellerType: string;
  sellerId: string;
  organizationId: string | null;
  currency: string;
  total: bigint;
  /** Core V2 S4a: the routing record's purpose and beneficiary (null on an invoice issued before S3a). */
  purpose?: string | null;
  beneficiaryUserId?: string | null;
}

/** Core V2 S4a (FC-10): in production, Billing applies only LIVE financial events; Core V2 has none, so production applies nothing. */
export interface DecisionOptions {
  requireLive?: boolean;
}

export type Decision =
  | { outcome: 'ignored'; detail: 'unknown_payment_request' | 'already_applied' }
  | { outcome: 'deferred'; detail: 'payment_id_not_recorded' }
  | { outcome: 'conflict'; detail: 'wrong_source' | 'producer_mismatch' | 'payment_id_mismatch' | 'snapshot_mismatch' | 'amount_mismatch' | 'invalid_amount' | 'request_already_terminal' | 'invoice_not_open' | 'invoice_missing' | 'non_live_event' }
  | { outcome: 'applied'; requestTo: 'paid' | 'failed' | 'expired' | 'cancelled'; invoiceTo: 'paid' | null };

const TARGET: Record<PaymentEventName, 'paid' | 'failed' | 'expired' | 'cancelled'> = {
  'payment.succeeded': 'paid',
  'payment.failed': 'failed',
  'payment.expired': 'expired',
  'payment.cancelled': 'cancelled',
};

export function decidePaymentEvent(event: PaymentEventFacts, request: RequestFacts | null, invoice: InvoiceFacts | null, opts: DecisionOptions = {}): Decision {
  // No such request: someone else's payment (another producer may use the same source type), never an alert.
  if (request === null) return { outcome: 'ignored', detail: 'unknown_payment_request' };
  if (invoice === null) return { outcome: 'conflict', detail: 'invoice_missing' };
  // Core V2 S4a (FC-10, P-6): production never applies a simulation (or mode-less) event; recorded and alerted, never applied
  if (opts.requireLive && event.liveMode !== true) return { outcome: 'conflict', detail: 'non_live_event' };

  // The request has no paymentId yet (dispatch not recorded): NOTHING is applied and NOTHING is bound from this event.
  if (request.paymentId === null) return { outcome: 'deferred', detail: 'payment_id_not_recorded' };

  if (event.source !== 'payment-service') return { outcome: 'conflict', detail: 'wrong_source' };
  if (event.producer !== EXPECTED_PRODUCER) return { outcome: 'conflict', detail: 'producer_mismatch' };
  if (event.paymentId !== request.paymentId) return { outcome: 'conflict', detail: 'payment_id_mismatch' };

  if (typeof event.amount !== 'number' || !Number.isSafeInteger(event.amount) || event.amount < 1) return { outcome: 'conflict', detail: 'invalid_amount' };
  if (BigInt(event.amount) !== request.amount || event.currency !== request.currency) return { outcome: 'conflict', detail: 'amount_mismatch' };
  if (
    event.sourceType !== 'invoice' ||
    event.sourceId !== invoice.id ||
    event.payer.type !== invoice.payerType || event.payer.id !== invoice.payerId ||
    event.seller.type !== invoice.sellerType || event.seller.id !== invoice.sellerId ||
    event.organizationId !== invoice.organizationId
  ) {
    return { outcome: 'conflict', detail: 'snapshot_mismatch' };
  }
  // Core V2 S4a (P-1, P-2, S-6): a mapping-version-2 request was sent the routing record's purpose and beneficiary, so its payment must carry
  // exactly those; a version-1 request sent neither, so its payment carries neither. Anything else is not the payment Billing asked for.
  if (request.mappingVersion !== undefined) {
    const v2 = request.mappingVersion >= 2;
    if ((event.purpose ?? null) !== (v2 ? invoice.purpose ?? null : null) || (event.beneficiaryUserId ?? null) !== (v2 ? invoice.beneficiaryUserId ?? null : null)) {
      return { outcome: 'conflict', detail: 'snapshot_mismatch' };
    }
  }

  const target = TARGET[event.name];
  if (request.status === target) return { outcome: 'ignored', detail: 'already_applied' }; // a redelivery, or the reconciler got there first
  if (request.status !== 'requested') return { outcome: 'conflict', detail: 'request_already_terminal' }; // money may have moved: reconciliation

  if (target === 'paid') {
    // A void or already-paid invoice cannot be paid: recorded, alerted, never applied (reconciliation is out of scope [X])
    if (invoice.status !== 'open') return { outcome: 'conflict', detail: 'invoice_not_open' };
    return { outcome: 'applied', requestTo: 'paid', invoiceTo: 'paid' };
  }
  return { outcome: 'applied', requestTo: target, invoiceTo: null };
}
