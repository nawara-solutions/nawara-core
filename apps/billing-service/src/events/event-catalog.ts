/**
 * V2 A3M.2 (ADR-0057 §11, Proposed; A3M record §11): the events billing-service publishes and the events it consumes, with their
 * versions and payload contracts. `contracts/events.json` is this catalog rendered by `renderEventContract()` (`event-catalog.spec.ts`
 * fails if they differ), and `npm run check:repo` checks every consumed entry against the producer's own artifact (payment-service):
 * each field Billing requires must be declared there with a compatible type and nullability. The types are local on purpose (no shared
 * event-contract library, no domain contract in the kit).
 */
export type EventFieldType = 'id' | 'uuid' | 'string' | 'datetime' | 'integer' | 'object' | 'array' | 'enum';
export interface EventField {
  readonly type: EventFieldType;
  /** `enum` only: the allowed values. */
  readonly values?: readonly string[];
  /** The field is present and may be null. */
  readonly nullable?: true;
  /** The field may be absent. */
  readonly optional?: true;
}
export interface ProducedEvent {
  readonly version: number;
  readonly codeBearing?: true;
  readonly payload: Readonly<Record<string, EventField>>;
}
export interface ConsumedEvent {
  readonly source: string;
  readonly name: string;
  readonly version: number;
  readonly requires: Readonly<Record<string, EventField>>;
}

export const EVENT_SOURCE = 'billing-service';

export const PRODUCED_EVENTS = {
  /** SDD 23, R-3: emitted only on `draft -> open` (`invoices/billing-events.ts`). No Core consumer yet. */
  'invoice.created': {
    version: 1,
    payload: {
      aggregateType: { type: 'string' },
      invoiceId: { type: 'uuid' },
      invoiceNumber: { type: 'string', nullable: true },
      sourceType: { type: 'string' },
      sourceId: { type: 'string' },
      organizationId: { type: 'string', nullable: true },
      payer: { type: 'object' },
      seller: { type: 'object' },
      currency: { type: 'string' },
      subtotal: { type: 'integer' },
      taxTotal: { type: 'integer' },
      total: { type: 'integer' },
      taxTreatment: { type: 'string' },
      status: { type: 'string' },
      revision: { type: 'integer' },
      dueAt: { type: 'datetime', nullable: true },
      issuedAt: { type: 'datetime', nullable: true },
      actor: { type: 'object' },
      cause: { type: 'object' },
      lines: { type: 'array' },
    },
  },
} as const satisfies Readonly<Record<string, ProducedEvent>>;

/** What `payment-integration/payment-event-consumer.ts` (`parseFacts`) requires of a payment outcome; its `occurredAt` header too. */
const PAYMENT_OUTCOME = {
  paymentId: { type: 'string' },
  producer: { type: 'string' },
  paymentRequestId: { type: 'string' },
  sourceType: { type: 'string' },
  sourceId: { type: 'string' },
  payer: { type: 'object' },
  seller: { type: 'object' },
  organizationId: { type: 'string', nullable: true },
  currency: { type: 'string' },
  revision: { type: 'integer' },
  amount: { type: 'integer' },
} as const;

export const CONSUMED_EVENTS = [
  { source: 'payment-service', name: 'payment.succeeded', version: 1, requires: PAYMENT_OUTCOME },
  { source: 'payment-service', name: 'payment.failed', version: 1, requires: PAYMENT_OUTCOME },
  { source: 'payment-service', name: 'payment.cancelled', version: 1, requires: PAYMENT_OUTCOME },
  { source: 'payment-service', name: 'payment.expired', version: 1, requires: PAYMENT_OUTCOME },
] as const satisfies readonly ConsumedEvent[];

export type BillingEventName = keyof typeof PRODUCED_EVENTS;

const field = (f: EventField) => ({ type: f.type, ...(f.values ? { values: [...f.values] } : {}), ...(f.nullable ? { nullable: true } : {}), ...(f.optional ? { optional: true } : {}) });
const fields = (r: Readonly<Record<string, EventField>>) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, field(r[k])]));

/** The committed contract artifact's content: sorted, so the file is stable. */
export function renderEventContract(): string {
  const produced: Readonly<Record<string, ProducedEvent>> = PRODUCED_EVENTS;
  const consumed: readonly ConsumedEvent[] = CONSUMED_EVENTS;
  const contract = {
    service: EVENT_SOURCE,
    produces: Object.keys(produced).sort().map((name) => ({ name, version: produced[name].version, ...(produced[name].codeBearing ? { codeBearing: true } : {}), payload: fields(produced[name].payload) })),
    consumes: [...consumed].sort((a, b) => `${a.source}|${a.name}`.localeCompare(`${b.source}|${b.name}`)).map((c) => ({ source: c.source, name: c.name, version: c.version, requires: fields(c.requires) })),
  };
  return `${JSON.stringify(contract, null, 2)}\n`;
}
