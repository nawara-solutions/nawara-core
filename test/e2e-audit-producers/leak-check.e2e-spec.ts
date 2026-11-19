import { describe, expect, it } from 'vitest';
import { AUDIT_RECORD_IDENTIFIERS, privateValueLeaks } from './support/leaks.js';

/**
 * Negative controls of the structural audit confidentiality check (support/leaks.ts) used by release.e2e-spec.ts. Pure: no service, broker or database.
 * The record below has the exact shape of a stored release.registered `audit_record` row (the CI run 44488646992 row, with its random ids).
 */
const PRIVATE = ['1.4.0', '1400', 'a1b2c3d4e5f6', 'notes.example', 'drive-ci-token-0000000000000000000000000000'];
const IDS = { ...AUDIT_RECORD_IDENTIFIERS, 'changes.product_id': 'uuid', 'changes.component_id': 'uuid' } as const;
const record = (over: Record<string, unknown> = {}, changes: Record<string, unknown> = {}) => ({
  id: '1', eventId: '5ffd048d-5114-5022-9c05-9a3b5c211362', sourceService: 'release-service', action: 'release.registered', category: 'administrative', schemaVersion: 1,
  actorType: 'service', actorId: 'drive-ci', userKind: null, organizationId: null, resourceType: 'release', resourceId: '81400639-58ef-477a-9f5d-4de28d342b8c',
  subjectType: null, subjectId: null, outcome: 'succeeded',
  changes: { kind: 'mobile_ios', product_id: '8041f0c9-1cd1-4af0-9e78-e4c9fb9c4190', component_id: '77426003-8c85-431c-908a-7c96d59e95a9', ...changes },
  correlationId: 'release-e2e-corr-01', causationId: null, occurredAt: '2026-11-19T08:39:23.196Z', recordedAt: new Date('2026-11-19T08:39:24.235Z'),
  companyId: null, platformId: null, liveMode: null, producerIdentityVerified: false, replayed: false, approvedByUserId: null, approvedByUserKind: null, ...over,
});

describe('structural audit confidentiality check (negative controls)', () => {
  it('a legitimate record passes although its random UUID (and a large sequence id) contains a private value as a substring', () => {
    expect(JSON.stringify(record())).toContain('1400'); // the CI false positive: '81400639-…'
    expect(privateValueLeaks(record(), PRIVATE, IDS)).toEqual([]);
    expect(privateValueLeaks(record({ id: '1400', eventId: '14000000-1400-4140-8140-140014001400' }), PRIVATE, IDS)).toEqual([]);
  });

  it('a private value in a prohibited top-level field fails', () => {
    expect(privateValueLeaks(record({ correlationId: 'build-1400' }), PRIVATE, IDS)).toEqual(['correlationId contains a private value']);
    expect(privateValueLeaks(record({ actorId: PRIVATE[4] }), PRIVATE, IDS)).toEqual(['actorId contains a private value']);
    expect(privateValueLeaks(record({ outcome: 'see https://notes.example/1.4.0' }), PRIVATE, IDS)).toEqual(['outcome contains a private value', 'outcome contains a private value']);
  });

  it('a private value in a nested changes field, as text, a number, a nested object or a key, fails', () => {
    expect(privateValueLeaks(record({}, { version: '1.4.0' }), PRIVATE, IDS)).toEqual(['changes.version contains a private value']);
    expect(privateValueLeaks(record({}, { build_id: 1400 }), PRIVATE, IDS)).toEqual(['changes.build_id contains a private value']);
    expect(privateValueLeaks(record({}, { source: { revision: 'a1b2c3d4e5f6' } }), PRIVATE, IDS)).toEqual(['changes.source.revision contains a private value']);
    expect(privateValueLeaks(record({}, { notes: ['x', 'https://notes.example/x'] }), PRIVATE, IDS)).toEqual(['changes.notes[1] contains a private value']);
    expect(privateValueLeaks(record({}, { 'build_1400': true }), PRIVATE, IDS)).toEqual(['changes.build_1400 (key) contains a private value']);
  });

  it('identifier fields are exempt only while they hold their exact grammar: free text in one fails', () => {
    expect(privateValueLeaks(record({ resourceId: 'release-1400' }), PRIVATE, IDS)).toEqual(['resourceId does not match the uuid grammar']);
    expect(privateValueLeaks(record({}, { product_id: 'notes.example' }), PRIVATE, IDS)).toEqual(['changes.product_id does not match the uuid grammar']);
    expect(privateValueLeaks(record({ id: '1.4.0' }), PRIVATE, IDS)).toEqual(['id does not match the integer grammar']);
    expect(privateValueLeaks(record({ occurredAt: '1.4.0' }), PRIVATE, IDS)).toEqual(['occurredAt does not match the timestamp grammar']);
  });

  it('the permitted release metadata (kind, ids, actor, correlation id, timestamps, nulls and booleans) is accepted; an empty private value is refused', () => {
    expect(privateValueLeaks(record({ organizationId: '00000000-0000-4000-8000-000000000001' }, { kind: 'web' }), PRIVATE, IDS)).toEqual([]);
    expect(() => privateValueLeaks(record(), ['1400', ''], IDS)).toThrow(/empty private value/);
  });
});
