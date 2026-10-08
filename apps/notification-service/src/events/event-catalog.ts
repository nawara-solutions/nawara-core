import { EVENT_MAP, type FieldType } from '../intake/event-map.js';

/**
 * V2 A3M.2 (ADR-0057 §11, Proposed; A3M record §11): the events notification-service consumes, as a contract. There is no second
 * definition: every entry is rendered from the intake's `EVENT_MAP` (the source, name, version and required payload fields the intake
 * validates). `contracts/events.json` is this rendering (`event-catalog.spec.ts` fails if they differ), and `npm run check:repo` checks
 * each entry against the producer's own artifact (auth-service). Notification publishes no domain event. The types are local on
 * purpose (no shared event-contract library, no domain contract in the kit).
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
export interface ConsumedEvent {
  readonly source: string;
  readonly name: string;
  readonly version: number;
  readonly requires: Readonly<Record<string, EventField>>;
}

export const EVENT_SOURCE = 'notification-service';

/** How the intake's field validation reads as a contract field (`intake/event-map.ts`, `FieldType`). */
const AS_CONTRACT: Readonly<Record<FieldType, EventField>> = {
  id: { type: 'id' },
  uuid: { type: 'uuid' },
  channel: { type: 'enum', values: ['email', 'phone'] },
  // the intake accepts null (the event then has no destination and is refused), so a nullable producer field is compatible
  destination: { type: 'string', nullable: true },
  string: { type: 'string' },
  datetime: { type: 'datetime' },
};

export const CONSUMED_EVENTS: readonly ConsumedEvent[] = EVENT_MAP.map((m) => ({
  source: m.source,
  name: m.name,
  version: m.version,
  requires: Object.fromEntries(Object.entries(m.payload).map(([k, t]) => [k, AS_CONTRACT[t]])),
}));

const field = (f: EventField) => ({ type: f.type, ...(f.values ? { values: [...f.values] } : {}), ...(f.nullable ? { nullable: true } : {}), ...(f.optional ? { optional: true } : {}) });
const fields = (r: Readonly<Record<string, EventField>>) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, field(r[k])]));

/** The committed contract artifact's content: sorted, so the file is stable. */
export function renderEventContract(): string {
  const contract = {
    service: EVENT_SOURCE,
    produces: [],
    consumes: [...CONSUMED_EVENTS].sort((a, b) => `${a.source}|${a.name}`.localeCompare(`${b.source}|${b.name}`)).map((c) => ({ source: c.source, name: c.name, version: c.version, requires: fields(c.requires) })),
  };
  return `${JSON.stringify(contract, null, 2)}\n`;
}
