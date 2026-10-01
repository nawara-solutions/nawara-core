import type { MessageParams, MessageTexts } from '@nawara/service-kit';
import { billingError } from './errors.js';
import { validatePartySnapshot, SnapshotError, type PartySnapshot } from './snapshots.js';
import { MAX_LINES, MAX_QUANTITY } from './totals.js';
import { BILLING_MESSAGES } from '../messages.js';

/** What a producer asks for when it creates an invoice (SDD 18.1, endpoint 7). There is deliberately NO amount, total, tax, currency or status here. */
export interface RawCreateInvoiceInput {
  invoiceRequestId: unknown;
  seller: unknown;
  payer: unknown;
  organizationId?: unknown;
  sourceType: unknown;
  sourceId: unknown;
  description?: unknown;
  dueAt?: unknown;
  issuerSnapshot: unknown;
  billToSnapshot: unknown;
  lines: unknown;
}

export interface NormalisedLineInput {
  priceId: string;
  quantity: number;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
}

export interface NormalisedCreateInvoiceInput {
  invoiceRequestId: string;
  seller: { type: string; id: string };
  payer: { type: string; id: string };
  organizationId: string | null;
  sourceType: string;
  sourceId: string;
  description: string | null;
  dueAt: Date | null;
  issuerSnapshot: PartySnapshot;
  billToSnapshot: PartySnapshot;
  lines: NormalisedLineInput[];
}

const PARTY_TYPES = ['user', 'organization', 'company'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_TYPE = /^[a-z][a-z0-9_]{1,62}$/;
const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ALLOWED_TOP = new Set(['invoiceRequestId', 'seller', 'payer', 'organizationId', 'sourceType', 'sourceId', 'description', 'dueAt', 'issuerSnapshot', 'billToSnapshot', 'lines']);
const ALLOWED_LINE = new Set(['priceId', 'quantity', 'description', 'sourceType', 'sourceId']);

const bad = (message: string | MessageTexts, params?: MessageParams) => billingError(400, 'invalid_invoice_request', message, params);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates and NORMALISES a create request. An unknown field is a 400 (mass assignment: a client can never smuggle a total, a currency or
 * a status in); identifiers are lower-cased to the canonical form Payment stores and echoes; nothing is trusted. Throws 400
 * `invalid_invoice_request`. The result is what gets hashed for idempotency and what the repository stores.
 */
export function normaliseCreateInvoiceInput(raw: unknown): NormalisedCreateInvoiceInput {
  if (!isObject(raw)) throw bad(BILLING_MESSAGES.requestMustBeObject);
  for (const k of Object.keys(raw)) if (!ALLOWED_TOP.has(k)) throw bad(BILLING_MESSAGES.unknownField, { name: k });

  const uuid = (v: unknown, field: string): string => {
    if (typeof v !== 'string' || !UUID.test(v)) throw bad(BILLING_MESSAGES.mustBeUuid, { field });
    return v.toLowerCase();
  };
  const party = (v: unknown, field: string): { type: string; id: string } => {
    if (!isObject(v)) throw bad(BILLING_MESSAGES.mustBeObject, { field });
    for (const k of Object.keys(v)) if (k !== 'type' && k !== 'id') throw bad(BILLING_MESSAGES.unknownField, { name: `${field}.${k}` });
    if (typeof v.type !== 'string' || !PARTY_TYPES.includes(v.type)) throw bad(BILLING_MESSAGES.partyTypeValues, { field: `${field}.type` });
    if (typeof v.id !== 'string' || v.id.length < 1 || v.id.length > 128) throw bad(BILLING_MESSAGES.lengthRange, { field: `${field}.id`, max: 128 });
    return { type: v.type, id: v.id };
  };

  const invoiceRequestId = uuid(raw.invoiceRequestId, 'invoiceRequestId');
  let seller = party(raw.seller, 'seller');
  const payer = party(raw.payer, 'payer');
  if (seller.type === payer.type && seller.id === payer.id) throw bad(BILLING_MESSAGES.payerSellerDiffer);

  let organizationId: string | null = raw.organizationId === undefined || raw.organizationId === null ? null : uuid(raw.organizationId, 'organizationId');
  if (seller.type === 'organization') {
    // An organization seller names itself as the organization (Payment's contract, BI-18); its id is therefore a uuid, in canonical form.
    seller = { type: seller.type, id: uuid(seller.id, 'seller.id') };
    if (organizationId !== null && organizationId !== seller.id) throw bad(BILLING_MESSAGES.organizationIdEqualsSeller);
    organizationId = seller.id;
  }

  if (typeof raw.sourceType !== 'string' || !SOURCE_TYPE.test(raw.sourceType)) throw bad(BILLING_MESSAGES.patternMatch, { field: 'sourceType', pattern: '^[a-z][a-z0-9_]{1,62}$' });
  if (typeof raw.sourceId !== 'string' || raw.sourceId.length < 1 || raw.sourceId.length > 128) throw bad(BILLING_MESSAGES.lengthRange, { field: 'sourceId', max: 128 });

  let description: string | null = null;
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== 'string' || raw.description.trim() === '' || raw.description.length > 140) throw bad(BILLING_MESSAGES.lengthRange, { field: 'description', max: 140 });
    description = raw.description;
  }

  // Billing computes no payment terms (B-008): the due date is an explicit instant or absent. Absent is "no due date", never overdue.
  let dueAt: Date | null = null;
  if (raw.dueAt !== undefined && raw.dueAt !== null) {
    const d = raw.dueAt instanceof Date ? raw.dueAt : typeof raw.dueAt === 'string' && OFFSET_TIMESTAMP.test(raw.dueAt) ? new Date(raw.dueAt) : null;
    if (d === null || Number.isNaN(d.getTime())) throw bad(BILLING_MESSAGES.timestampWithOffset, { field: 'dueAt' });
    dueAt = d;
  }

  let issuerSnapshot: PartySnapshot;
  let billToSnapshot: PartySnapshot;
  try {
    issuerSnapshot = validatePartySnapshot(raw.issuerSnapshot, 'issuerSnapshot');
    billToSnapshot = validatePartySnapshot(raw.billToSnapshot, 'billToSnapshot');
  } catch (e) {
    if (e instanceof SnapshotError) throw bad(e.message);
    throw e;
  }

  if (!Array.isArray(raw.lines) || raw.lines.length < 1 || raw.lines.length > MAX_LINES) throw bad(BILLING_MESSAGES.linesCount, { max: MAX_LINES });
  const lines = raw.lines.map((l: unknown, i: number): NormalisedLineInput => {
    if (!isObject(l)) throw bad(BILLING_MESSAGES.mustBeObject, { field: `lines[${i}]` });
    for (const k of Object.keys(l)) if (!ALLOWED_LINE.has(k)) throw bad(BILLING_MESSAGES.unknownField, { name: `lines[${i}].${k}` }); // no unitAmount, lineTotal, currency or tax: prices come from the catalog
    if (typeof l.quantity !== 'number' || !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QUANTITY) throw bad(BILLING_MESSAGES.integerRange, { field: `lines[${i}].quantity`, max: MAX_QUANTITY });
    let lineDescription: string | null = null;
    if (l.description !== undefined && l.description !== null) {
      if (typeof l.description !== 'string' || l.description.trim() === '' || l.description.length > 140) throw bad(BILLING_MESSAGES.lengthRange, { field: `lines[${i}].description`, max: 140 });
      lineDescription = l.description;
    }
    const hasType = l.sourceType !== undefined && l.sourceType !== null;
    const hasId = l.sourceId !== undefined && l.sourceId !== null;
    if (hasType !== hasId) throw bad(BILLING_MESSAGES.sourcePair, { field: `lines[${i}]` });
    if (hasType && (typeof l.sourceType !== 'string' || !SOURCE_TYPE.test(l.sourceType))) throw bad(BILLING_MESSAGES.notValid, { field: `lines[${i}].sourceType` });
    if (hasId && (typeof l.sourceId !== 'string' || l.sourceId.length < 1 || l.sourceId.length > 128)) throw bad(BILLING_MESSAGES.notValid, { field: `lines[${i}].sourceId` });
    return {
      priceId: uuid(l.priceId, `lines[${i}].priceId`),
      quantity: l.quantity,
      description: lineDescription,
      sourceType: hasType ? (l.sourceType as string) : null,
      sourceId: hasId ? (l.sourceId as string) : null,
    };
  });

  return { invoiceRequestId, seller, payer, organizationId, sourceType: raw.sourceType, sourceId: raw.sourceId, description, dueAt, issuerSnapshot, billToSnapshot, lines };
}

const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
/** No producer-configured allow-list exists yet (SDD section 36: deferred to a later stage); this is a plain technical default, not a business choice. */
export const DEFAULT_INVOICE_LOCALE = 'en';

export interface NormalisedIssueInvoiceInput {
  locale: string;
}

/**
 * Validates the OPTIONAL body of endpoint 10 (`POST .../issue`). The SDD's own text says the endpoint takes "no body"
 * (section 18.1) while the presentation snapshot needs a locale (section 9, BI-20); its TDD note (billing-service-domain-schema,
 * "Notes for the SDD owner" #2) leaves the resolution to Stage 3: "the repository takes them as a parameter; Stage 3 must
 * decide where they come from (service default or an optional body)". This is that Stage 3 decision, and it is [T], not
 * [B]: no business policy is chosen — a producer that cares may name its own locale; one that does not gets the default.
 * The TEMPLATE is never client-supplied: the presentation designer is deferred (section 36), so only the frozen built-in
 * default (`SYSTEM_TEMPLATE_V1`) is ever used in this phase.
 */
export function normaliseIssueInvoiceInput(raw: unknown): NormalisedIssueInvoiceInput {
  if (raw === undefined || raw === null) return { locale: DEFAULT_INVOICE_LOCALE };
  if (!isObject(raw)) throw bad(BILLING_MESSAGES.requestMustBeObject);
  for (const k of Object.keys(raw)) if (k !== 'locale') throw bad(BILLING_MESSAGES.unknownField, { name: k });
  if (raw.locale === undefined) return { locale: DEFAULT_INVOICE_LOCALE };
  if (typeof raw.locale !== 'string' || !LOCALE.test(raw.locale)) throw bad(BILLING_MESSAGES.localeTag);
  return { locale: raw.locale };
}

export interface NormalisedInvoiceListFilters {
  status?: string;
  sourceType?: string;
  sourceId?: string;
  payerType?: string;
  payerId?: string;
  dueBefore?: Date;
}

const INVOICE_STATUS = new Set(['draft', 'open', 'paid', 'void']);

/**
 * Validates the OPTIONAL query filters of endpoint 9 (`?status=&sourceType=&sourceId=&payerType=&payerId=&dueBefore=`).
 * These narrow the caller's own scope; they never widen it (the repository ANDs them onto the scope clause, section 18.1).
 * An invalid value is a 400: a filter is never silently ignored, which could otherwise make a caller believe a filter
 * excluded rows that a typo actually let through.
 */
export function normaliseInvoiceListFilters(raw: Record<string, unknown>): NormalisedInvoiceListFilters {
  const out: NormalisedInvoiceListFilters = {};
  if (raw.status !== undefined) {
    if (typeof raw.status !== 'string' || !INVOICE_STATUS.has(raw.status)) throw bad(BILLING_MESSAGES.invoiceStatusValues);
    out.status = raw.status;
  }
  if (raw.sourceType !== undefined) {
    if (typeof raw.sourceType !== 'string' || !SOURCE_TYPE.test(raw.sourceType)) throw bad(BILLING_MESSAGES.patternMatch, { field: 'sourceType', pattern: '^[a-z][a-z0-9_]{1,62}$' });
    out.sourceType = raw.sourceType;
  }
  if (raw.sourceId !== undefined) {
    if (typeof raw.sourceId !== 'string' || raw.sourceId.length < 1 || raw.sourceId.length > 128) throw bad(BILLING_MESSAGES.lengthRange, { field: 'sourceId', max: 128 });
    out.sourceId = raw.sourceId;
  }
  if (raw.payerType !== undefined) {
    if (typeof raw.payerType !== 'string' || !PARTY_TYPES.includes(raw.payerType)) throw bad(BILLING_MESSAGES.partyTypeValues, { field: 'payerType' });
    out.payerType = raw.payerType;
  }
  if (raw.payerId !== undefined) {
    if (typeof raw.payerId !== 'string' || raw.payerId.length < 1 || raw.payerId.length > 128) throw bad(BILLING_MESSAGES.lengthRange, { field: 'payerId', max: 128 });
    out.payerId = raw.payerId;
  }
  if (raw.dueBefore !== undefined) {
    if (typeof raw.dueBefore !== 'string' || !OFFSET_TIMESTAMP.test(raw.dueBefore)) throw bad(BILLING_MESSAGES.timestampWithOffset, { field: 'dueBefore' });
    const d = new Date(raw.dueBefore);
    if (Number.isNaN(d.getTime())) throw bad(BILLING_MESSAGES.timestampWithOffset, { field: 'dueBefore' });
    out.dueBefore = d;
  }
  return out;
}
