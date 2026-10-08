/**
 * V2 A3M.2 (ADR-0057 §11, Proposed; A3M record §11): the events payment-service publishes, with their version and payload contract.
 * `contracts/events.json` is this catalog rendered by `renderEventContract()` (`event-catalog.spec.ts` fails if they differ), and
 * `npm run check:repo` compares every service's artifact: a consumer may only rely on what a producer declares here. Changing an entry
 * changes a published contract: an added optional field keeps the version, anything else is a new version (ADR-0057 §5).
 * The types are local on purpose (no shared event-contract library, no domain contract in the kit).
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

export const EVENT_SOURCE = 'payment-service';

/** The common payload of every payment event (SDD section 11), as `paymentEvent()` builds it. */
const COMMON = {
  paymentId: { type: 'uuid' },
  paymentRequestId: { type: 'string' },
  sourceType: { type: 'string' },
  sourceId: { type: 'string' },
  organizationId: { type: 'string', nullable: true },
  payer: { type: 'object' },
  seller: { type: 'object' },
  amount: { type: 'integer' },
  currency: { type: 'string' },
  status: { type: 'string' },
  revision: { type: 'integer' },
  actor: { type: 'object' },
  cause: { type: 'object' },
  producer: { type: 'string' },
} as const;

export const PRODUCED_EVENTS = {
  'payment.created': { version: 1, payload: COMMON },
  'payment.succeeded': { version: 1, payload: { ...COMMON, settledMethod: { type: 'string' }, succeededAt: { type: 'datetime', optional: true } } },
  'payment.failed': { version: 1, payload: { ...COMMON, failureCode: { type: 'string', nullable: true } } },
  'payment.cancelled': { version: 1, payload: COMMON },
  'payment.expired': { version: 1, payload: { ...COMMON, expiresAt: { type: 'datetime' } } },
} as const satisfies Readonly<Record<string, ProducedEvent>>;

export const CONSUMED_EVENTS = [] as const satisfies readonly ConsumedEvent[];

export type PaymentEventName = keyof typeof PRODUCED_EVENTS;

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
