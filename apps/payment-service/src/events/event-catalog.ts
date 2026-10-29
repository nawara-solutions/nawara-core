/**
 * V2 A3M.2 (ADR-0057 §11, Proposed; A3M record §11): the events payment-service publishes, with their version and payload contract.
 * `contracts/events.json` is this catalog rendered by `renderEventContract()` (`event-catalog.spec.ts` fails if they differ), and
 * `npm run check:repo` compares every service's artifact: a consumer may only rely on what a producer declares here. Changing an entry
 * changes a published contract: an added optional field keeps the version, anything else is a new version (ADR-0057 §5).
 * The types are local on purpose (no shared event-contract library, no domain contract in the kit).
 */
export type EventFieldType = 'id' | 'uuid' | 'string' | 'datetime' | 'integer' | 'boolean' | 'object' | 'array' | 'enum';
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
  // Core V2 S4a (additive, optional: version 1 unchanged): absent on a payment created before S4a
  purpose: { type: 'enum', values: ['organization_subscription', 'direct_purchase', 'assisted_settlement', 'recovery_settlement', 'non_entitlement'], optional: true },
  beneficiaryUserId: { type: 'string', optional: true },
  liveMode: { type: 'boolean', optional: true },
} as const;

export const PRODUCED_EVENTS = {
  'payment.created': { version: 1, payload: COMMON },
  'payment.succeeded': { version: 1, payload: { ...COMMON, settledMethod: { type: 'string' }, succeededAt: { type: 'datetime', optional: true } } },
  'payment.failed': { version: 1, payload: { ...COMMON, failureCode: { type: 'string', nullable: true } } },
  'payment.cancelled': { version: 1, payload: COMMON },
  'payment.expired': { version: 1, payload: { ...COMMON, expiresAt: { type: 'datetime' } } },
  /**
   * Core V2 S6c (register EVT-02; S0 FC-3; the Owner's R6C-8): the refund case's financial completion, once, when the cumulative verified
   * allocation of its authorization reaches the approved full amount. Written to the outbox in the completion transaction; its id is
   * derived from the authorization. Development and simulation only (`liveMode` false); Billing's verified consumer completes its case.
   */
  'refund.case_completed': {
    version: 1,
    payload: {
      refundCaseId: { type: 'uuid' },
      refundAuthorizationId: { type: 'uuid' },
      refundAttemptId: { type: 'uuid' },
      paymentId: { type: 'uuid' },
      paymentRequestId: { type: 'string' },
      producer: { type: 'string' },
      approvedAmount: { type: 'integer' },
      currency: { type: 'string' },
      completedAt: { type: 'datetime' },
      liveMode: { type: 'boolean' },
      organizationId: { type: 'string', nullable: true },
      purpose: { type: 'enum', values: ['direct_purchase', 'assisted_settlement', 'non_entitlement'] },
    },
  },
  /**
   * Core V2 S6e-D (register EVT-03; ADR-0044 B10; the Owner's R6E-6): a verified provider dispute, as Payment recorded it. `amount` is the
   * exposure the PROVIDER states (never the capture inferred). Written to the outbox in the transaction that records the dispute; its id is
   * derived from the dispute. Development and simulation only (`liveMode` false). No evidence content, no provider data beyond the reason code.
   */
  'payment.dispute.opened': {
    version: 1,
    payload: {
      disputeId: { type: 'uuid' },
      paymentId: { type: 'uuid' },
      paymentRequestId: { type: 'string' },
      producer: { type: 'string' },
      organizationId: { type: 'string', nullable: true },
      purpose: { type: 'enum', values: ['organization_subscription', 'direct_purchase', 'assisted_settlement', 'recovery_settlement', 'non_entitlement'], nullable: true },
      amount: { type: 'integer' },
      currency: { type: 'string' },
      reason: { type: 'string', nullable: true },
      openedAt: { type: 'datetime' },
      liveMode: { type: 'boolean' },
    },
  },
  /**
   * Core V2 S6e-D (EVT-03; R6E-5, R6E-6): the provider's final `lost` outcome, once per dispute. `chargeback` is the VERIFIED chargeback fact
   * linked to the dispute when the provider reported one with the loss, else null: a loss alone never implies money moved. A chargeback
   * reported after the loss is read through `GET /payment/disputes/losses` (no second event).
   */
  'payment.dispute.lost': {
    version: 1,
    payload: {
      disputeId: { type: 'uuid' },
      paymentId: { type: 'uuid' },
      paymentRequestId: { type: 'string' },
      producer: { type: 'string' },
      organizationId: { type: 'string', nullable: true },
      purpose: { type: 'enum', values: ['organization_subscription', 'direct_purchase', 'assisted_settlement', 'recovery_settlement', 'non_entitlement'], nullable: true },
      amount: { type: 'integer' },
      currency: { type: 'string' },
      lostAt: { type: 'datetime' },
      chargeback: { type: 'object', nullable: true },
      liveMode: { type: 'boolean' },
    },
  },
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
