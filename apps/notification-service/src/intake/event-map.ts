/**
 * The event intake mapping (SDD §7.1): DATA, not branches. Each entry declares, for one `(source, name, version)`, the payload contract
 * and how it becomes a notification intent: the template, the recipient reference, the organization, the channel and destination, the
 * template variables and the expiry. Only these events are bound to the queue; nothing else reaches the intake.
 *
 * Taken exactly from Auth's current publishers (Stage 16.2 inventory). Auth decides WHEN and WHY and supplies the destination and the
 * code; Notification never calls Auth. Not consumed (no destination in the payload, D8): `user.registered`, `membership.requested`,
 * `membership.admin_provisioned`.
 */

/** Runtime types of payload fields. Each is validated before anything else happens; unknown payload fields are ignored, never stored. */
export type FieldType =
  | 'id' // an opaque identifier: 1-128 of [A-Za-z0-9._:-]
  | 'uuid'
  | 'channel' // 'email' | 'phone'
  | 'destination' // a string of 1-320 characters, or null (then the event has no destination: refused)
  | 'string' // a string of 1-1024 characters (template variables bound it further)
  | 'datetime'; // ISO 8601 UTC

export interface EventMapping {
  source: string;
  name: string;
  version: number;
  /** The platform template key (published by migration). */
  template: string;
  category: 'SECURITY' | 'TRANSACTIONAL' | 'OPTIONAL';
  /** Required payload fields and their types. */
  payload: Record<string, FieldType>;
  recipient: { type: 'user'; idFrom: string };
  /** The payload field holding the organization id, or null for a platform-level notification. */
  organizationFrom: string | null;
  /** Payload field → template variable. */
  variables: Record<string, string>;
  /** The payload field holding the expiry (codes), or null. */
  expiresAtFrom: string | null;
}

const DEST = { userId: 'id', channel: 'channel', destination: 'destination' } as const;
const code = (name: string, template: string, withTimestamp: boolean): EventMapping => ({
  source: 'auth-service', name, version: 1, template, category: 'SECURITY',
  payload: { ...DEST, code: 'string', expiresAt: 'datetime', ...(withTimestamp ? { timestamp: 'datetime' } : {}) },
  recipient: { type: 'user', idFrom: 'userId' }, organizationFrom: null,
  variables: { code: 'code', expiresAt: 'expiresAt' }, expiresAtFrom: 'expiresAt',
});
const alert = (name: string, template: string, extra: Record<string, FieldType>, variables: Record<string, string>): EventMapping => ({
  source: 'auth-service', name, version: 1, template, category: 'SECURITY',
  payload: { ...DEST, ipAddress: 'string', timestamp: 'datetime', ...extra },
  recipient: { type: 'user', idFrom: 'userId' }, organizationFrom: null, variables, expiresAtFrom: null,
});
const membership = (name: string): EventMapping => ({
  source: 'auth-service', name, version: 1, template: name, category: 'TRANSACTIONAL',
  payload: { ...DEST, organizationId: 'uuid', timestamp: 'datetime' },
  recipient: { type: 'user', idFrom: 'userId' }, organizationFrom: 'organizationId', variables: {}, expiresAtFrom: null,
});

export const EVENT_MAP: readonly EventMapping[] = [
  code('member.contact_verification_requested', 'identity.contact_verification_code', false),
  code('admin.operator_code_issued', 'identity.operator_login_code', true),
  code('admin.operator_confirmation_code_issued', 'identity.operator_confirmation_code', true),
  alert('admin.owner_recovery_requested', 'identity.owner_recovery_requested', { availableAt: 'datetime' }, { availableAt: 'availableAt', ipAddress: 'ipAddress' }),
  alert('admin.owner_recovery_completed', 'identity.owner_recovery_completed', {}, { occurredAt: 'timestamp', ipAddress: 'ipAddress' }),
  alert('admin.owner_login_from_new_device', 'identity.owner_new_device_login', {}, { occurredAt: 'timestamp', ipAddress: 'ipAddress' }),
  membership('membership.approved'),
  membership('membership.rejected'),
  membership('membership.revoked'),
];

/** The durable queue this service owns (SDD §7.1), bound only to the mapped routing keys. */
export const INTAKE_QUEUE = 'notification.events';
export const INTAKE_BINDINGS: readonly string[] = [...new Set(EVENT_MAP.map((m) => m.name))];

const BY_KEY = new Map(EVENT_MAP.map((m) => [`${m.source}|${m.name}`, m]));
export function mappingFor(source: string, name: string): EventMapping | undefined {
  return BY_KEY.get(`${source}|${name}`);
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function fieldOk(type: FieldType, v: unknown): boolean {
  switch (type) {
    case 'id':
      return typeof v === 'string' && ID.test(v);
    case 'uuid':
      return typeof v === 'string' && UUID.test(v);
    case 'channel':
      return v === 'email' || v === 'phone';
    case 'destination':
      return v === null || (typeof v === 'string' && v.length >= 1 && v.length <= 320);
    case 'string':
      return typeof v === 'string' && v.length >= 1 && v.length <= 1024;
    case 'datetime':
      return typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
  }
}

/** The names of the payload fields that are missing or of the wrong type (never their values). Empty when the payload is valid. */
export function payloadProblems(m: EventMapping, payload: Record<string, unknown>): string[] {
  return Object.entries(m.payload).filter(([field, type]) => !(field in payload) || !fieldOk(type, payload[field])).map(([field]) => field);
}
