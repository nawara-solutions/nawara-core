import { AUDIT_ACTIONS, type AuditAction } from '../src/index.js';
import { mayRetainRefusedAuditBody, validateAuditEvent } from '../src/consumer.js';
import { SAMPLE_IDS, sampleAuditPayload } from '../src/testing.js';
import { AUDIT_CATALOG } from '../src/catalog.js';

/**
 * Stage 18.8 (18.5 F3): the dead-letter screen. Refused bodies are kept only when every value is a grammar token, so the DLQ can never
 * become a store of what an untrusted publisher sent, while a refusal that a later catalog could reverse (A50) stays replayable.
 */
type P = Record<string, any>;
const EVENT_ID = '5e5e5e5e-0000-4000-8000-000000000001';
const envelope = (a: AuditAction, payload: P = sampleAuditPayload(a, 'complete'), headers: P = {}) => ({
  id: EVENT_ID, name: `audit.${payload.action ?? a}`, payload,
  headers: { eventId: EVENT_ID, occurredAt: '2026-09-26T10:00:00.000Z', source: AUDIT_CATALOG.get(a)!.producer, version: 1, correlationId: 'corr-0001-abcd', ...headers },
});
const base = (a: AuditAction = 'membership.revoked') => JSON.parse(JSON.stringify(sampleAuditPayload(a, 'complete'))) as P;
const MARKERS = ['STAGE18_SECRET_MARKER', 'STAGE18_TOKEN_MARKER', 'privacy-marker@example.invalid', '+99912345678'];

describe('mayRetainRefusedAuditBody (Stage 18.8 dead-letter screen)', () => {
  it.each(AUDIT_ACTIONS.flatMap((a) => [[a, 'minimal'], [a, 'complete']] as const))('%s (%s): every VALID event keeps its body (duplicates, conflicts, transient failures)', (a, v) => {
    const e = envelope(a, sampleAuditPayload(a, v));
    expect(() => validateAuditEvent(e)).not.toThrow();
    expect(mayRetainRefusedAuditBody(e)).toBe(true);
  });

  it('refusals a catalog upgrade can reverse keep their body (A50 replay): unknown action, unsupported version, a rule a correction widens, another producer', () => {
    const unknown = { ...base(), action: 'membership.future_thing' };
    const cases = [
      envelope('membership.revoked', unknown),
      envelope('membership.revoked', base(), { version: 2 }),
      envelope('membership.revoked', { ...base(), actor: { type: 'system', id: 'some_future_process' } }),
      envelope('membership.revoked', { ...base(), organizationId: null }),
      envelope('membership.revoked', base(), { source: 'billing-service' }),
    ];
    for (const e of cases) {
      expect(() => validateAuditEvent(e)).toThrow();
      expect(mayRetainRefusedAuditBody(e)).toBe(true);
    }
  });

  it.each([
    ['a credential-named field', (p: P) => ({ ...p, changes: { ...p.changes, password: 'STAGE18_SECRET_MARKER' } })],
    ['a nested credential field', (p: P) => ({ ...p, actor: { ...p.actor, token: 'STAGE18_TOKEN_MARKER' } })],
    ['a secret-shaped value', (p: P) => ({ ...p, changes: { authority: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.STAGE18_TOKEN_MARKER' } })],
    ['an email as an actor id', (p: P) => ({ ...p, actor: { type: 'user', id: 'privacy-marker@example.invalid', userKind: 'member' } })],
    ['a phone number in changes', (p: P) => ({ ...p, changes: { authority: '+99912345678' } })],
    ['free text in a resource id', (p: P) => ({ ...p, resource: { type: 'membership', id: 'Ahmed Ben Ali STAGE18_SECRET_MARKER' } })],
    ['an unknown top-level field', (p: P) => ({ ...p, note: 'STAGE18_SECRET_MARKER' })],
    ['an unknown reference field', (p: P) => ({ ...p, resource: { ...p.resource, name: 'STAGE18_SECRET_MARKER' } })],
    ['a nested object as a change value', (p: P) => ({ ...p, changes: { authority: { deep: { deeper: 'STAGE18_SECRET_MARKER' } } } })],
    ['an array', (p: P) => ({ ...p, changes: { authority: ['STAGE18_SECRET_MARKER'] } })],
    ['a huge value', (p: P) => ({ ...p, changes: { authority: 'a'.repeat(5000) } })],
    ['a prototype-like key', (p: P) => JSON.parse(JSON.stringify(p).replace('"outcome"', '"__proto__":{"polluted":"STAGE18_SECRET_MARKER"},"outcome"'))],
    ['a non-string action', (p: P) => ({ ...p, action: { STAGE18_SECRET_MARKER: 1 } })],
  ])('%s: the body is NOT kept', (_label, mutate) => {
    expect(mayRetainRefusedAuditBody(envelope('membership.revoked', mutate(base())))).toBe(false);
  });

  it('an envelope that is not grammar tokens is not kept (free text in a header, a non-UUID id, a malformed / missing event)', () => {
    expect(mayRetainRefusedAuditBody(envelope('membership.revoked', base(), { correlationId: 'privacy-marker@example.invalid' }))).toBe(false);
    expect(mayRetainRefusedAuditBody(envelope('membership.revoked', base(), { source: 'STAGE18 SECRET' }))).toBe(false);
    expect(mayRetainRefusedAuditBody({ ...envelope('membership.revoked'), id: 'STAGE18_SECRET_MARKER' })).toBe(false);
    expect(mayRetainRefusedAuditBody({ ...envelope('membership.revoked'), name: 'audit.Has Spaces' })).toBe(false);
    for (const bad of [undefined, null, 42, 'text', [], { id: EVENT_ID }]) expect(mayRetainRefusedAuditBody(bad as never)).toBe(false);
  });

  it('never throws, and never keeps a body carrying a marker, over 5 000 random mutations (seed 1808)', () => {
    let seed = 1808;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const values = [...MARKERS, SAMPLE_IDS.user, 'member', null, true, 7, -1.5, [], {}, { password: MARKERS[0] }, 'x'.repeat(300)];
    const paths = [['changes', 'authority'], ['actor', 'id'], ['resource', 'id'], ['subject', 'id'], ['organizationId'], ['outcome'], ['causationId'], ['extra']];
    for (let i = 0; i < 5000; i++) {
      const p = base();
      const path = paths[Math.floor(rnd() * paths.length)]!;
      const v = values[Math.floor(rnd() * values.length)];
      let target: P = p;
      for (const k of path.slice(0, -1)) target = (target[k] ??= {});
      target[path[path.length - 1]!] = v;
      const e = envelope('membership.revoked', p);
      let kept = false;
      expect(() => (kept = mayRetainRefusedAuditBody(e))).not.toThrow();
      if (kept) for (const m of MARKERS) expect(JSON.stringify(e.payload)).not.toContain(m);
    }
  });
});
