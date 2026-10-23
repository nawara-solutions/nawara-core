import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PermanentEventFailure, type EventEnvelope, type HandlerTrust } from '@nawara/service-kit';
import { notificationDeadLetterPolicy } from './dead-letter-policy.js';
import { CODE_BEARING_EVENTS, EVENT_MAP } from './event-map.js';
import { TRUST_REFUSALS, trustedIntakeEvent } from './trusted-event.js';

/** Core V2 S1e-4 (ADR-0057 "S0-C6" Notification, ADR-0052 decision 5): the dead-letter policy, the code-bearing set and the trusted envelope. */
const CODE = '730591';
const EMAIL = 'unit@example.test';
const envelope = (name: string, payload: Record<string, unknown>, headers: Record<string, unknown> = {}): EventEnvelope => {
  const id = randomUUID();
  return { id, name, payload, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'auth-service', version: 1, correlationId: `corr-${id.slice(0, 8)}`, ...headers } as EventEnvelope['headers'] };
};
const codePayload = () => ({ userId: 'u-1', channel: 'email', destination: EMAIL, code: CODE, expiresAt: new Date(Date.now() + 600_000).toISOString(), timestamp: new Date().toISOString() });
const membershipPayload = () => ({ userId: 'u-1', channel: 'email', destination: EMAIL, organizationId: randomUUID(), timestamp: new Date().toISOString() });
const body = (e: EventEnvelope) => Buffer.from(JSON.stringify(e.payload));
const FAILURES = ['permanent', 'retries_exhausted', 'malformed'] as const;

describe('the code-bearing events', () => {
  it('are exactly the Auth contract\'s `codeBearing` events Notification consumes (the contract is the authority)', () => {
    const auth = JSON.parse(readFileSync(new URL('../../../auth-service/contracts/events.json', import.meta.url), 'utf8')) as { produces: Array<{ name: string; codeBearing?: boolean }> };
    const ours = JSON.parse(readFileSync(new URL('../../contracts/events.json', import.meta.url), 'utf8')) as { consumes: Array<{ source: string; name: string }> };
    const consumed = new Set(ours.consumes.filter((c) => c.source === 'auth-service').map((c) => c.name));
    const contractCodeBearing = auth.produces.filter((p) => p.codeBearing === true && consumed.has(p.name)).map((p) => p.name).sort();
    expect([...CODE_BEARING_EVENTS].sort()).toEqual(contractCodeBearing);
    expect(contractCodeBearing).toEqual(['admin.operator_code_issued', 'admin.operator_confirmation_code_issued', 'member.contact_verification_requested']);
    for (const m of EVENT_MAP) expect('code' in m.payload).toBe(CODE_BEARING_EVENTS.has(m.name));
  });
});

describe('notificationDeadLetterPolicy', () => {
  it('a code-bearing event is ALWAYS redacted, whatever the failure and reason (a refusal, an intake refusal, an exhausted retry)', () => {
    for (const name of CODE_BEARING_EVENTS) {
      const e = envelope(name, codePayload());
      for (const failure of FAILURES) {
        for (const reason of [undefined, 'untrusted_unverified_original', 'untrusted_replay_unverifiable', 'malformed_payload']) {
          expect(notificationDeadLetterPolicy({ event: e, failure, reason, body: body(e) }).body, `${name} ${failure} ${reason}`).toBe('redacted');
        }
      }
    }
  });

  it('a mapped, code-free event with canonical bytes keeps its body (replayable); only the validated headers survive', () => {
    const e = envelope('membership.approved', membershipPayload(), { correlationId: 'bad id with spaces', 'x-contact': '+21620000009' });
    const d = notificationDeadLetterPolicy({ event: e, failure: 'permanent', reason: 'untrusted_unverified_original', body: body(e) });
    expect(d.body).toBe('original');
    expect(d.headers).toEqual({ eventId: e.id, source: 'auth-service', occurredAt: e.headers.occurredAt, version: 1 });
  });

  it('anything that could hide a code is redacted: non-canonical bytes, a duplicate key, a nested `code`, an unmapped source or name, no body, no event', () => {
    const e = envelope('membership.approved', membershipPayload());
    const canonical = JSON.stringify(e.payload);
    const cases: Array<[string, EventEnvelope | undefined, Buffer | undefined]> = [
      ['whitespace', e, Buffer.from(JSON.stringify(e.payload, null, 1))],
      ['a duplicate key hiding a code', e, Buffer.from(`{"code":"${CODE}",${canonical.slice(1)}`)],
      ['an escaped key', e, Buffer.from(canonical.replace('"userId"', '"\\u0075serId"'))],
      ['not JSON', e, Buffer.from('not json')],
      ['no body', e, undefined],
      ['no event', undefined, Buffer.from(canonical)],
    ];
    const nested = envelope('membership.approved', { ...membershipPayload(), extra: { deep: [{ code: CODE }] } });
    cases.push(['a nested code', nested, body(nested)]);
    const unmappedSource = envelope('membership.approved', membershipPayload(), { source: 'evil-service' });
    cases.push(['an unmapped source', unmappedSource, body(unmappedSource)]);
    const unknownName = envelope('membership.teleported', membershipPayload());
    cases.push(['an unknown name', unknownName, body(unknownName)]);
    const relabelled = envelope('membership.approved', codePayload()); // a code-bearing body under a code-free name
    cases.push(['a code under a code-free name', relabelled, body(relabelled)]);
    for (const [label, event, b] of cases) expect(notificationDeadLetterPolicy({ event, failure: 'permanent', body: b }).body, label).toBe('redacted');
  });

  it('never throws, and never returns a value it did not validate', () => {
    const hostile = { id: 'x\ny', name: 'membership.approved', payload: {}, headers: { source: 'auth-service\nX', occurredAt: 'yesterday', version: 1.5, correlationId: 'c\r\nX' } } as unknown as EventEnvelope;
    const d = notificationDeadLetterPolicy({ event: hostile, failure: 'malformed', body: Buffer.from('{}') });
    expect(d).toEqual({ body: 'redacted', headers: {} });
  });
});

describe('trustedIntakeEvent (the handler\'s own check)', () => {
  const field = <T>(value: T) => ({ available: true, value, from: 'verified_delivery' } as const);
  const notStored = { available: false, reason: 'not_stored' } as const;
  const original = (e: EventEnvelope, over: Record<string, unknown> = {}): HandlerTrust => ({
    decision: 'accept', basis: 'verified_original',
    origin: { from: 'verified_delivery', source: 'auth-service', eventId: e.id, name: e.name, routingKey: e.name, producerUserId: 'auth-service', occurredAt: field(e.headers.occurredAt), version: field(1), correlationId: field(e.headers.correlationId!), ...over },
  });
  const replay = (e: EventEnvelope): HandlerTrust => ({
    decision: 'accept', basis: 'verified_replay',
    origin: { from: 'stored_verified_observation', source: 'auth-service', eventId: e.id, name: e.name, routingKey: e.name, producerUserId: 'auth-service', occurredAt: notStored, version: notStored, correlationId: notStored },
  });
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof PermanentEventFailure ? e.reason : 'other';
    }
    return undefined;
  };

  it('refuses without an ACCEPTED decision: none, compatibility (strict only), anything else', () => {
    const e = envelope('membership.approved', membershipPayload());
    expect(refusal(() => trustedIntakeEvent(e, undefined))).toBe('untrusted_no_decision');
    expect(refusal(() => trustedIntakeEvent(e, { decision: 'compatibility', basis: 'unverified_original', verified: false }))).toBe('untrusted_no_decision');
    expect(refusal(() => trustedIntakeEvent(e, { decision: 'refuse', basis: 'unknown_path' } as unknown as HandlerTrust))).toBe('untrusted_no_decision');
    expect(TRUST_REFUSALS).toEqual(['untrusted_no_decision', 'untrusted_origin_mismatch']);
  });

  it('refuses an accepted origin that is not this delivery\'s event (id, name or source)', () => {
    const e = envelope('membership.approved', membershipPayload());
    for (const over of [{ eventId: randomUUID() }, { name: 'membership.revoked' }, { source: 'billing-service' }]) {
      expect(refusal(() => trustedIntakeEvent(e, original(e, over))), JSON.stringify(over)).toBe('untrusted_origin_mismatch');
    }
  });

  it('a verified original keeps its own version and correlation id', () => {
    const e = envelope('membership.approved', membershipPayload());
    expect(trustedIntakeEvent(e, original(e)).headers).toMatchObject({ eventId: e.id, source: 'auth-service', version: 1, correlationId: e.headers.correlationId });
  });

  it('a verified REPLAY never carries its own correlation header (not stored, never trusted); its version header only gates the mapping', () => {
    const e = envelope('membership.approved', membershipPayload(), { correlationId: 'forged-correlation-0001' });
    const t = trustedIntakeEvent(e, replay(e));
    expect(t.headers.correlationId).toBeUndefined();
    expect(JSON.stringify(t)).not.toContain('forged-correlation-0001');
    expect(t.headers.version).toBe(1);
    expect(t.payload).toBe(e.payload);
  });
});
