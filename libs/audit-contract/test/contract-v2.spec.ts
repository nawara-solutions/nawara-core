import { AUDIT_ACTIONS, AUDIT_CATALOG, AUDIT_CONTRACT_VERSION, AuditContractError, SUPPORTED_AUDIT_VERSIONS, emittedVersion, type AuditAction, type CatalogEntry } from '../src/index.js';
import { mayRetainRefusedAuditBody, validateAuditEvent } from '../src/consumer.js';
import { SAMPLE_IDS, sampleAuditPayload } from '../src/testing.js';
import { validateAuditPayloadWith } from '../src/validate.js';

/**
 * Core V2 S2-Audit.1 (ADR-0069 decision 2 and 4; register AUD-01): the additive contract version 2 — `companyId`, `platformId`,
 * `liveMode` — its version gating, the catalog `scope` rule and the scope contradictions, and the frozen fields this slice leaves refused.
 */
type P = Record<string, any>;
const EVENT_ID = '6f6f6f6f-0000-4000-8000-000000000002';
const COMPANY = '11111111-1111-4111-8111-111111111111';
const PLATFORM = '22222222-2222-4222-8222-222222222222';
const envelope = (a: AuditAction, payload: P, headers: P = {}) => ({
  id: EVENT_ID, name: `audit.${a}`, payload,
  headers: { eventId: EVENT_ID, occurredAt: '2026-10-25T10:00:00.000Z', source: AUDIT_CATALOG.get(a)!.producer, version: 2, correlationId: 'corr-0002-abcd', ...headers },
});
const base = (a: AuditAction, v: 'minimal' | 'complete' = 'complete') => JSON.parse(JSON.stringify(sampleAuditPayload(a, v))) as P;
const code = (f: () => unknown) => {
  try { f(); } catch (e) { return e instanceof AuditContractError ? e.code : `unexpected ${String(e)}`; }
  return 'accepted';
};

/** A catalog lookup with ONE test-only action allowing scope, for the rules no production entry uses yet. */
const scoped = (scope: CatalogEntry['scope'], resource: string[] = ['payment']): ((a: string) => CatalogEntry | undefined) => {
  const entry: CatalogEntry = {
    producer: 'payment-service', category: 'commercial', since: 1, actors: { service: true }, organization: 'optional', resource,
    subject: { rule: 'forbidden' }, outcomes: ['succeeded'], changes: {}, purpose: 'test only', ...(scope ? { scope } : {}),
  };
  return (a) => (a === 'test.scoped_fact' ? entry : undefined);
};
const scopedPayload = (over: P = {}): P => ({
  action: 'test.scoped_fact', actor: { type: 'service', id: 'billing-service' }, organizationId: null,
  resource: { type: 'payment', id: SAMPLE_IDS.uuidA }, outcome: 'succeeded', ...over,
});
const withScope = (scope: CatalogEntry['scope'], over: P = {}, resource?: string[]) =>
  code(() => validateAuditPayloadWith(scoped(scope, resource), scopedPayload(over), 'payment-service', 2));

describe('audit contract version 2 (S2-Audit.1)', () => {
  it('versions 1 and 2 are accepted; producers still emit version 1', () => {
    expect(SUPPORTED_AUDIT_VERSIONS).toEqual([1, 2]);
    expect(AUDIT_CONTRACT_VERSION).toBe(1);
  });

  it.each(AUDIT_ACTIONS.flatMap((a) => [[a, 'minimal'], [a, 'complete']] as const))('%s (%s): a version-2 event with no new field is valid and stored as version 2', (a, v) => {
    const e = validateAuditEvent(envelope(a, base(a, v)));
    expect(e.schemaVersion).toBe(2);
    expect(e.payload).toEqual(sampleAuditPayload(a, v));
  });

  it('liveMode: a boolean in version 2 (true and false both valid at the contract; production refusal is ingestion\'s), anything else refused', () => {
    for (const liveMode of [true, false]) expect(validateAuditEvent(envelope('membership.revoked', { ...base('membership.revoked'), liveMode })).payload.liveMode).toBe(liveMode);
    for (const liveMode of ['true', 1, null, {}]) expect(code(() => validateAuditEvent(envelope('membership.revoked', { ...base('membership.revoked'), liveMode }))), JSON.stringify(liveMode)).toBe('invalid_live_mode');
  });

  it('a version-1 event carrying a version-2 field is refused (unknown_field): the fields exist only in version 2', () => {
    for (const extra of [{ companyId: COMPANY }, { platformId: PLATFORM }, { liveMode: true }]) {
      expect(code(() => validateAuditEvent(envelope('membership.revoked', { ...base('membership.revoked'), ...extra }, { version: 1 }))), JSON.stringify(extra)).toBe('unknown_field');
    }
  });

  it('the fields without an approved encoding (requestedBy, verifiedBy, via; D6, D7) are refused in every version; approvedBy outside its action too', () => {
    const extras = [
      { requestedBy: { type: 'user', id: SAMPLE_IDS.uuidA, userKind: 'owner' } },
      { verifiedBy: { service: 'auth-service', mechanism: 'authorization_receipt', ref: SAMPLE_IDS.uuidB } }, { via: 'billing-service' },
    ];
    for (const version of [1, 2]) for (const extra of extras) {
      expect(code(() => validateAuditEvent(envelope('membership.revoked', { ...base('membership.revoked'), ...extra }, { version }))), `${version} ${Object.keys(extra)[0]}`).toBe('unknown_field');
    }
    const approver = { approvedBy: { type: 'user', id: SAMPLE_IDS.uuidA, userKind: 'owner' } };
    expect(code(() => validateAuditEvent(envelope('membership.revoked', { ...base('membership.revoked'), ...approver }, { version: 1 })))).toBe('unknown_field');
    expect(code(() => validateAuditEvent(envelope('membership.revoked', { ...base('membership.revoked'), ...approver })))).toBe('invalid_approval');
  });

  // Core V2 G6-C (DO-59; the Owner's G6-C GO, 2026-11-20): the reviewed matrix. Company only, never a Platform; nothing else gains scope.
  const RECEIPTS = ['authorization_receipt.consumed', 'authorization_receipt.issued', 'authorization_receipt.voided'];
  const G6C = [
    'fee_cap.set', 'fee_delegation.granted', 'fee_delegation.revoked', 'fee_proposal.approved', 'fee_proposal.created', 'fee_proposal.rejected', 'fee_proposal.withdrawn',
    'fraud_hold.expired', 'fraud_hold.placed', 'fraud_hold.released',
    'refund_attempt.authorized', 'refund_attempt.failed', 'refund_attempt.succeeded', 'refund_authorization.completed',
    'refund_case.authorization_relayed', 'refund_case.cancelled', 'refund_case.completed', 'refund_case.opened',
  ];

  it('scope is granted ONLY to the receipts (D3) and the G6-C matrix, Company only: a forged companyId or platformId is refused for every other action', () => {
    expect(AUDIT_ACTIONS.filter((a) => AUDIT_CATALOG.get(a)!.scope !== undefined).sort()).toEqual([...RECEIPTS, ...G6C].sort());
    for (const a of [...RECEIPTS, ...G6C]) expect(AUDIT_CATALOG.get(a as AuditAction)!.scope, a).toEqual({ company: 'required' });
    for (const a of AUDIT_ACTIONS.filter((x) => !RECEIPTS.includes(x) && !G6C.includes(x))) {
      expect(code(() => validateAuditEvent(envelope(a, { ...base(a), companyId: COMPANY }))), a).toBe('invalid_scope');
      expect(code(() => validateAuditEvent(envelope(a, { ...base(a), platformId: PLATFORM }))), a).toBe('invalid_scope');
    }
  });

  it('G6-C: a scoped action is written as version 2 with its Company; a missing Company or ANY Platform in version 2 is refused', () => {
    for (const a of G6C as AuditAction[]) {
      expect(emittedVersion(a), a).toBe(2);
      expect(AUDIT_CATALOG.get(a)!.since, a).toBe(1); // the action keeps its own version: its earlier events stay valid
      expect(validateAuditEvent(envelope(a, { ...base(a), companyId: COMPANY })).payload.companyId, a).toBe(COMPANY);
      const { companyId: _c, ...unscoped } = base(a);
      expect(code(() => validateAuditEvent(envelope(a, unscoped))), a).toBe('invalid_scope');
      expect(code(() => validateAuditEvent(envelope(a, { ...base(a), companyId: COMPANY, platformId: PLATFORM }))), a).toBe('invalid_scope');
      expect(code(() => validateAuditEvent(envelope(a, { ...base(a), companyId: 'not-a-uuid' }))), a).toBe('invalid_scope');
    }
    // every unscoped action still writes its own version (1, or 2 for the receipts)
    for (const a of AUDIT_ACTIONS.filter((x) => !G6C.includes(x))) expect(emittedVersion(a), a).toBe(AUDIT_CATALOG.get(a)!.since);
  });

  it('G6-C version-1 compatibility: an earlier version-1 event of a scoped action stays valid with NO scope; it can never carry one', () => {
    for (const a of G6C as AuditAction[]) {
      const { companyId: _c, ...v1 } = base(a);
      const e = validateAuditEvent(envelope(a, v1, { version: 1 }));
      expect([e.schemaVersion, e.payload.companyId, e.payload.platformId], a).toEqual([1, undefined, undefined]);
      expect(code(() => validateAuditEvent(envelope(a, { ...v1, companyId: COMPANY }, { version: 1 }))), a).toBe('unknown_field');
    }
  });

  it('exactly the three authorization receipt actions are version-2 actions; a version-1 event of one is refused', () => {
    expect(AUDIT_ACTIONS.filter((a) => AUDIT_CATALOG.get(a)!.since !== 1).sort()).toEqual(['authorization_receipt.consumed', 'authorization_receipt.issued', 'authorization_receipt.voided']);
    for (const a of ['authorization_receipt.issued', 'authorization_receipt.consumed', 'authorization_receipt.voided'] as const) {
      // refused for its version (`since` = 2) before its payload is judged, with or without the version-2 fields
      expect(code(() => validateAuditEvent(envelope(a, base(a), { version: 1 }))), a).toBe('unsupported_version');
      const { companyId: _c, approvedBy: _a, ...v1shaped } = base(a);
      expect(code(() => validateAuditEvent(envelope(a, v1shaped, { version: 1 }))), a).toBe('unsupported_version');
    }
  });
});

describe('the catalog scope rule (S2-Audit.1; exercised through a test-only entry)', () => {
  it('an allowed assertion is kept exactly; absent fields stay absent', () => {
    const p = validateAuditPayloadWith(scoped({ company: 'optional', platform: 'optional' }), scopedPayload({ companyId: COMPANY, platformId: PLATFORM }), 'payment-service', 2);
    expect([p.companyId, p.platformId]).toEqual([COMPANY, PLATFORM]);
    const none = validateAuditPayloadWith(scoped({ company: 'optional' }), scopedPayload(), 'payment-service', 2);
    expect('companyId' in none || 'platformId' in none).toBe(false);
  });

  it('refuses what the entry does not allow, a missing required level, and malformed ids', () => {
    expect(withScope({ company: 'optional' }, { platformId: PLATFORM })).toBe('invalid_scope'); // no inference: a Company rule allows no Platform
    expect(withScope({ platform: 'optional' }, { companyId: COMPANY })).toBe('invalid_scope');
    expect(withScope(undefined, { companyId: COMPANY })).toBe('invalid_scope');
    expect(withScope({ company: 'required' }, {})).toBe('invalid_scope');
    expect(withScope({ company: 'required', platform: 'required' }, { companyId: COMPANY })).toBe('invalid_scope');
    for (const bad of ['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'c1', '', null, 7, { id: COMPANY }]) {
      expect(withScope({ company: 'optional' }, { companyId: bad }), JSON.stringify(bad)).toBe('invalid_scope');
    }
  });

  it('refuses contradictory scope: the resource is another Company / Platform; one id at two levels', () => {
    expect(withScope({ company: 'optional' }, { resource: { type: 'company', id: SAMPLE_IDS.uuidA }, companyId: COMPANY }, ['company'])).toBe('invalid_scope');
    expect(withScope({ company: 'optional' }, { resource: { type: 'company', id: COMPANY }, companyId: COMPANY }, ['company'])).toBe('accepted');
    expect(withScope({ platform: 'optional' }, { resource: { type: 'platform', id: SAMPLE_IDS.uuidA }, platformId: PLATFORM }, ['platform'])).toBe('invalid_scope');
    expect(withScope({ company: 'optional', platform: 'optional' }, { companyId: COMPANY, platformId: COMPANY })).toBe('invalid_scope');
    expect(withScope({ company: 'optional' }, { companyId: COMPANY, organizationId: COMPANY })).toBe('invalid_scope');
  });

  it('version gating applies to the test entry too: a version-1 payload cannot assert scope', () => {
    expect(code(() => validateAuditPayloadWith(scoped({ company: 'optional' }), scopedPayload({ companyId: COMPANY }), 'payment-service', 1))).toBe('unknown_field');
  });

  it('sensitive data stays out: a credential-named key or a secret-shaped value is refused before any scope rule', () => {
    expect(withScope({ company: 'optional' }, { companyId: COMPANY, token: 'x' })).toBe('sensitive_field');
    expect(withScope({ company: 'optional' }, { companyId: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlc2lnbmF0dXJl' })).toBe('sensitive_value');
  });
});

describe('the dead-letter screen knows the version-2 tokens (S2-Audit.1)', () => {
  it('a valid version-2 event keeps its body; a malformed version-2 value is not kept', () => {
    const ok = envelope('membership.revoked', { ...base('membership.revoked'), liveMode: false });
    expect(mayRetainRefusedAuditBody(ok)).toBe(true);
    // refused by the catalog (scope not allowed) but token-shaped: kept, so a later catalog decision can replay it (A50)
    expect(mayRetainRefusedAuditBody(envelope('membership.revoked', { ...base('membership.revoked'), companyId: COMPANY }))).toBe(true);
    for (const extra of [{ companyId: 'Acme Corp' }, { platformId: 'x' }, { liveMode: 'yes' }, { via: 'billing-service' }]) {
      expect(mayRetainRefusedAuditBody(envelope('membership.revoked', { ...base('membership.revoked'), ...extra })), JSON.stringify(extra)).toBe(false);
    }
  });
});
