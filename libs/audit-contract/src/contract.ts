/**
 * The canonical audit payload, version 1 (ADR-0049 A14, SDD §4). It travels as the `payload` of an ordinary kit event whose name is
 * `audit.<action>`; the kit envelope already carries `eventId`, `occurredAt`, `correlationId`, `source` and `version`, so none of those
 * is repeated here. `category` is not a payload field either: the catalog owns it.
 */

/** The contract version this package implements; it is the kit envelope `version` of every audit event. */
export const AUDIT_CONTRACT_VERSION = 1;
/** The envelope versions a consumer accepts. An event with any other version is refused (`unsupported_version`), never reinterpreted. */
export const SUPPORTED_AUDIT_VERSIONS: readonly number[] = Object.freeze([1]);

/** A52: the four frozen categories. */
export const AUDIT_CATEGORIES = ['security', 'business', 'commercial', 'administrative'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** A9: operator and owner are not actor types; they are user kinds. */
export const ACTOR_TYPES = ['user', 'service', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export const USER_KINDS = ['member', 'owner', 'operator'] as const;
export type UserKind = (typeof USER_KINDS)[number];

export const AUDIT_OUTCOMES = ['succeeded', 'denied'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** A verified Auth user (UUID), with the kind it had when acting. */
export interface UserActor {
  type: 'user';
  id: string;
  userKind: UserKind;
}
/** A trusted Core or product service (its service-token caller name), acting when no user was verified by the producer. */
export interface ServiceActor {
  type: 'service';
  id: string;
}
/** An automated process of the producer; `id` is one of the action's cataloged process codes. */
export interface SystemActor {
  type: 'system';
  id: string;
}
export type AuditActor = UserActor | ServiceActor | SystemActor;

/** An opaque producer identifier (a lowercase UUID in every Core domain) and a type fixed by the catalog. */
export interface AuditReference {
  type: string;
  id: string;
}

export type ChangeScalar = string | number | boolean;
export type ChangeValue = ChangeScalar | { from: ChangeScalar; to: ChangeScalar };

export interface AuditPayload {
  action: string;
  actor: AuditActor;
  /** The organization recorded on the affected resource in the producer's own database; `null` = platform-level, never "all". */
  organizationId: string | null;
  resource: AuditReference;
  /** At most one affected party distinct from the resource. Absent (never `null`) when there is none. */
  subject?: AuditReference;
  outcome: AuditOutcome;
  /** Cataloged change facts only. Absent (never `{}` or `null`) when there are none. */
  changes?: Readonly<Record<string, ChangeValue>>;
  /** The `eventId` of the event that caused this action, when a consumer-driven step records it. */
  causationId?: string;
}
