import { MAX_MINOR_UNITS, toJsonAmount } from './money.js';

/**
 * The pure mapping from an invoice and its payment request to the body of Payment's `POST /payment/payments` (SDD 13.2). It is a function
 * of two IMMUTABLE rows, so a retry after a crash builds a byte-for-byte identical request and Payment's natural-key replay
 * (`(billing-service, paymentRequestId)`) applies. Changing the mapping means a new version; requests already made keep theirs.
 *
 * The limits below MIRROR Payment's contract (its SDD 3.1 and `CreatePaymentDto`). They are copied, not imported: a service never imports
 * another's source. Billing's database CHECKs (BI-18) make a violating invoice impossible to store; this is the last line of defence.
 */
export const PAYMENT_MAPPING_VERSION = 1;

export const PAYMENT_CONTRACT = {
  partyTypes: ['user', 'organization', 'company'] as const,
  partyIdLength: { min: 1, max: 128 },
  sourceIdMax: 128,
  descriptionMax: 140,
  referenceMax: 64,
  currency: /^[A-Z]{3}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
} as const;

export class PaymentMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentMappingError';
  }
}

export interface InvoiceForMapping {
  id: string;
  /** Assigned at issue: a request exists only for an issued invoice. */
  number: string | null;
  payerType: string;
  payerId: string;
  sellerType: string;
  sellerId: string;
  organizationId: string | null;
  currency: string;
  description: string | null;
}

export interface RequestForMapping {
  id: string;
  amount: bigint;
  expiresAt: Date | null;
}

export interface PaymentCreateBody {
  paymentRequestId: string;
  sourceType: 'invoice';
  sourceId: string;
  payer: { type: string; id: string };
  seller: { type: string; id: string };
  organizationId?: string;
  amount: number;
  currency: string;
  expiresAt?: string;
  description?: string;
  reference: string;
}

export function buildPaymentRequestBody(invoice: InvoiceForMapping, request: RequestForMapping, version: number = PAYMENT_MAPPING_VERSION): PaymentCreateBody {
  if (version !== PAYMENT_MAPPING_VERSION) throw new PaymentMappingError(`unknown payment mapping version ${version}`);
  const c = PAYMENT_CONTRACT;
  const fail = (m: string): never => {
    throw new PaymentMappingError(m);
  };

  if (!invoice.number) fail('a payment request needs an issued invoice (it has no number yet)');
  if (invoice.number!.length > c.referenceMax) fail(`the invoice number is longer than ${c.referenceMax} characters`);
  if (invoice.description !== null && invoice.description.length > c.descriptionMax) fail(`the description is longer than ${c.descriptionMax} characters`);
  for (const [who, type, id] of [['payer', invoice.payerType, invoice.payerId], ['seller', invoice.sellerType, invoice.sellerId]] as const) {
    if (!(c.partyTypes as readonly string[]).includes(type)) fail(`${who} type is not one Payment accepts`);
    if (id.length < c.partyIdLength.min || id.length > c.partyIdLength.max) fail(`${who} id must be ${c.partyIdLength.min} to ${c.partyIdLength.max} characters`);
  }
  if (invoice.payerType === invoice.sellerType && invoice.payerId === invoice.sellerId) fail('payer and seller must differ');
  if (invoice.sellerType === 'organization') {
    // Payment rejects an organization seller whose id is not a uuid or whose organizationId differs (its own CHECK and DTO)
    if (!c.uuid.test(invoice.sellerId)) fail('an organization seller id must be a canonical lower-case uuid');
    if (invoice.organizationId !== invoice.sellerId) fail('an organization seller must name itself as the organization');
  }
  if (invoice.organizationId !== null && !c.uuid.test(invoice.organizationId)) fail('organizationId must be a canonical lower-case uuid');
  if (!c.currency.test(invoice.currency)) fail('currency must be three upper-case letters');
  if (request.amount < 1n || request.amount > MAX_MINOR_UNITS) fail('amount must be between 1 and 2^53-1');
  if (invoice.id.length > c.sourceIdMax) fail('sourceId is too long');

  const body: PaymentCreateBody = {
    paymentRequestId: request.id,
    sourceType: 'invoice', // Billing's OWN vocabulary: the payment's producer is Billing, not the invoice's source system
    sourceId: invoice.id,
    payer: { type: invoice.payerType, id: invoice.payerId },
    seller: { type: invoice.sellerType, id: invoice.sellerId },
    amount: toJsonAmount(request.amount),
    currency: invoice.currency,
    reference: invoice.number!,
  };
  if (invoice.organizationId !== null) body.organizationId = invoice.organizationId;
  if (request.expiresAt !== null) body.expiresAt = request.expiresAt.toISOString();
  if (invoice.description !== null) body.description = invoice.description;
  return body;
}
