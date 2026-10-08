/**
 * V2 A3M.2 (ADR-0057 §11, Proposed; A3M record §11): the domain events auth-service publishes (when `AUTH_EVENTS=on`), with their
 * version and payload contract. `DomainEvents.emit` is typed from this catalog, so an emit site cannot use a name or a payload field
 * that is not declared here (compile-time only: nothing changes at runtime). `contracts/events.json` is this catalog rendered by
 * `renderEventContract()` (`event-catalog.spec.ts` fails if they differ), and `npm run check:repo` checks every consumer's
 * requirements (notification-service) against it. Audit events are not here: they belong to `@nawara/audit-contract` (ADR-0049).
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
  /** Carries a one-time code for delivery (ADR-0052 decision 5): exactly `CODE_BEARING_EVENTS`, whose outbox rows are purged. */
  readonly codeBearing?: true;
  readonly payload: Readonly<Record<string, EventField>>;
}
export interface ConsumedEvent {
  readonly source: string;
  readonly name: string;
  readonly version: number;
  readonly requires: Readonly<Record<string, EventField>>;
}

export const EVENT_SOURCE = 'auth-service';

const CHANNEL = { type: 'enum', values: ['email', 'phone'] } as const;
/** The user's email or phone for the channel; null when the user has neither. */
const DESTINATION = { type: 'string', nullable: true } as const;

/** Every event is version 1 (`AUTH_EVENT_VERSION`, Stage 16.2, ADR-0046 rule 17). */
export const PRODUCED_EVENTS = {
  'user.registered': { version: 1, payload: { userId: { type: 'uuid' }, role: { type: 'string' }, organizationId: { type: 'uuid' }, timestamp: { type: 'datetime' } } },
  'membership.requested': { version: 1, payload: { userId: { type: 'uuid' }, organizationId: { type: 'uuid' }, audience: { type: 'string' }, timestamp: { type: 'datetime' } } },
  'membership.approved': { version: 1, payload: { userId: { type: 'uuid' }, organizationId: { type: 'uuid' }, channel: CHANNEL, destination: DESTINATION, timestamp: { type: 'datetime' } } },
  'membership.rejected': { version: 1, payload: { userId: { type: 'uuid' }, organizationId: { type: 'uuid' }, channel: CHANNEL, destination: DESTINATION, timestamp: { type: 'datetime' } } },
  'membership.revoked': { version: 1, payload: { userId: { type: 'uuid' }, organizationId: { type: 'uuid' }, channel: CHANNEL, destination: DESTINATION, timestamp: { type: 'datetime' } } },
  'membership.admin_provisioned': { version: 1, payload: { userId: { type: 'uuid' }, organizationId: { type: 'uuid' }, invitationType: { type: 'string' }, timestamp: { type: 'datetime' } } },
  'member.contact_verification_requested': {
    version: 1, codeBearing: true,
    payload: { userId: { type: 'uuid' }, channel: CHANNEL, destination: DESTINATION, code: { type: 'string' }, expiresAt: { type: 'datetime' } },
  },
  'admin.operator_code_issued': {
    version: 1, codeBearing: true,
    payload: { userId: { type: 'uuid' }, channel: CHANNEL, destination: DESTINATION, code: { type: 'string' }, expiresAt: { type: 'datetime' }, timestamp: { type: 'datetime' } },
  },
  'admin.operator_confirmation_code_issued': {
    version: 1, codeBearing: true,
    payload: { userId: { type: 'uuid' }, channel: CHANNEL, destination: DESTINATION, code: { type: 'string' }, expiresAt: { type: 'datetime' }, timestamp: { type: 'datetime' } },
  },
  'admin.owner_login_from_new_device': { version: 1, payload: { userId: { type: 'uuid' }, channel: CHANNEL, destination: DESTINATION, ipAddress: { type: 'string' }, timestamp: { type: 'datetime' } } },
  'admin.owner_recovery_requested': {
    version: 1,
    payload: { userId: { type: 'uuid' }, channel: CHANNEL, destination: DESTINATION, availableAt: { type: 'datetime' }, ipAddress: { type: 'string' }, timestamp: { type: 'datetime' } },
  },
  'admin.owner_recovery_completed': { version: 1, payload: { userId: { type: 'uuid' }, channel: CHANNEL, destination: DESTINATION, ipAddress: { type: 'string' }, timestamp: { type: 'datetime' } } },
} as const satisfies Readonly<Record<string, ProducedEvent>>;

export const CONSUMED_EVENTS = [] as const satisfies readonly ConsumedEvent[];

type Catalog = typeof PRODUCED_EVENTS;
export type AuthEventName = keyof Catalog;
type ValueOf<F> = F extends { type: 'integer' } ? number
  : F extends { type: 'object' } ? Record<string, unknown>
  : F extends { type: 'array' } ? readonly unknown[]
  : F extends { type: 'enum'; values: readonly (infer V)[] } ? V
  : string;
type FieldValue<F> = F extends { nullable: true } ? ValueOf<F> | null : ValueOf<F>;
type Fields<N extends AuthEventName> = Catalog[N]['payload'];
/** The payload an emit site must pass for `N`: exactly the declared fields, with their types and nullability. */
export type AuthEventPayload<N extends AuthEventName> = { [K in keyof Fields<N>]: FieldValue<Fields<N>[K]> };

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
