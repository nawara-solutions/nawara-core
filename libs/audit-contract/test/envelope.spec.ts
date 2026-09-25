import { validateAuditEvent } from '../src/consumer.js';
import { AUDIT_CATALOG, AUDIT_ACTIONS, type AuditAction } from '../src/index.js';
import { SAMPLE_IDS, sampleAuditPayload } from '../src/testing.js';

const EVENT_ID = '5f0c2d1e-8a7b-4c6d-9e5f-4a3b2c1d0e99';

/** An envelope exactly as the kit relay builds it (OutboxRelay.drainOnce) and the RabbitMQ bus hands it to a consumer. */
function envelope(action: AuditAction, overrides: { name?: unknown; payload?: unknown; headers?: Record<string, unknown>; id?: unknown } = {}) {
  const id = overrides.id ?? EVENT_ID;
  return {
    id,
    name: overrides.name ?? `audit.${action}`,
    payload: overrides.payload ?? JSON.parse(JSON.stringify(sampleAuditPayload(action, 'complete'))),
    headers: {
      eventId: id,
      occurredAt: '2026-09-25T10:00:00.123Z',
      correlationId: 'corr-0001-abcd',
      source: AUDIT_CATALOG.get(action)!.producer,
      version: 1,
      ...overrides.headers,
    },
  };
}

describe('validateAuditEvent (consumer side, the input of 18.5)', () => {
  it.each(AUDIT_ACTIONS)('%s: a relay-shaped envelope validates, carrying category, version, time and correlation unchanged', (action) => {
    const v = validateAuditEvent(envelope(action));
    const e = AUDIT_CATALOG.get(action)!;
    expect(v).toEqual({
      eventId: EVENT_ID,
      eventType: `audit.${action}`,
      sourceService: e.producer,
      category: e.category,
      schemaVersion: 1,
      occurredAt: '2026-09-25T10:00:00.123Z',
      correlationId: 'corr-0001-abcd',
      payload: sampleAuditPayload(action, 'complete'),
    });
  });

  it('refuses an event type that does not match the payload action', () => {
    expect(() => validateAuditEvent(envelope('membership.revoked', { name: 'audit.membership.approved' }))).toThrow('event_type_mismatch');
    expect(() => validateAuditEvent(envelope('subscription.renewed', { name: 'audit.membership.revoked' }))).toThrow('event_type_mismatch');
    expect(() => validateAuditEvent(envelope('file.deleted', { name: 'file.deleted' }))).toThrow('event_type_mismatch');
    expect(() => validateAuditEvent(envelope('file.deleted', { name: 'audit.audit.file.deleted' }))).toThrow('event_type_mismatch');
    expect(() => validateAuditEvent(envelope('file.deleted', { name: 42 }))).toThrow('event_type_mismatch');
  });

  it('refuses a source that does not own the action (impersonation on the bus)', () => {
    expect(() => validateAuditEvent(envelope('membership.revoked', { headers: { source: 'billing-service' } }))).toThrow('producer_not_admitted');
    expect(() => validateAuditEvent(envelope('file.deleted', { headers: { source: 'Payment_Service' } }))).toThrow('invalid_envelope');
    expect(() => validateAuditEvent(envelope('file.deleted', { headers: { source: undefined } }))).toThrow('invalid_envelope');
  });

  it('refuses an unsupported or malformed version (never read as version 1)', () => {
    for (const version of [0, 2, 1000, 1.5, '1', null, undefined]) {
      expect(() => validateAuditEvent(envelope('file.deleted', { headers: { version } })), String(version)).toThrow('unsupported_version');
    }
  });

  it('refuses an envelope whose id is not the canonical UUID or differs from headers.eventId', () => {
    expect(() => validateAuditEvent(envelope('file.deleted', { id: EVENT_ID.toUpperCase() }))).toThrow('invalid_envelope');
    expect(() => validateAuditEvent(envelope('file.deleted', { headers: { eventId: SAMPLE_IDS.uuidA } }))).toThrow('invalid_envelope');
    expect(() => validateAuditEvent(envelope('file.deleted', { id: 'evt-1' }))).toThrow('invalid_envelope');
    expect(() => validateAuditEvent({ ...envelope('file.deleted'), headers: null })).toThrow('invalid_envelope');
  });

  it('refuses an unusable occurredAt, but keeps a far-past or future instant exactly as sent', () => {
    for (const occurredAt of ['', 'yesterday', 'infinity', '2026-02-30T10:00:00.000Z', '2026-09-25 10:00:00', '2026-09-25T10:00:00.000+02:00', 1727258400000]) {
      expect(() => validateAuditEvent(envelope('file.deleted', { headers: { occurredAt } })), String(occurredAt)).toThrow('invalid_envelope');
    }
    for (const occurredAt of ['1999-01-01T00:00:00.000Z', '2099-12-31T23:59:59.999Z', '2026-09-25T10:00:00Z']) {
      expect(validateAuditEvent(envelope('file.deleted', { headers: { occurredAt } })).occurredAt).toBe(occurredAt);
    }
  });

  it('correlation is optional, preserved when present, and bounded by the kit grammar', () => {
    expect(validateAuditEvent(envelope('file.deleted', { headers: { correlationId: undefined } })).correlationId).toBeNull();
    for (const correlationId of ['short', 'has space inside', 'x'.repeat(129), 'a\nb-c-d-e-f', 7]) {
      expect(() => validateAuditEvent(envelope('file.deleted', { headers: { correlationId } }))).toThrow('invalid_correlation');
    }
  });

  it('refuses a causation id equal to the event id', () => {
    const payload = { ...sampleAuditPayload('file.deleted', 'complete'), causationId: EVENT_ID };
    expect(() => validateAuditEvent(envelope('file.deleted', { payload }))).toThrow('invalid_causation');
  });

  it('ignores the consumer-set delivery headers (retryCount, replayCount) and never lets them reach the record', () => {
    const v = validateAuditEvent(envelope('file.deleted', { headers: { retryCount: 2, replayCount: 1 } }));
    expect(Object.keys(v).sort()).toEqual(['category', 'correlationId', 'eventId', 'eventType', 'occurredAt', 'payload', 'schemaVersion', 'sourceService']);
  });

  it('applies the whole payload contract (an unknown field in a relayed payload is refused)', () => {
    const payload = { ...sampleAuditPayload('file.deleted'), category: 'security' };
    expect(() => validateAuditEvent(envelope('file.deleted', { payload }))).toThrow('unknown_field');
    expect(() => validateAuditEvent(envelope('file.deleted', { payload: '{"action":"file.deleted"}' }))).toThrow('invalid_payload');
  });
});
