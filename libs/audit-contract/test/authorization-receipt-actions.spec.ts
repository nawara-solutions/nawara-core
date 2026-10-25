import { AUDIT_CATALOG, AuditContractError, AuditEventWriter, CORE_PRODUCERS, validateAuditPayload, type AuditOutboxEvent } from '../src/index.js';
import { validateAuditEvent } from '../src/consumer.js';
import { SAMPLE_IDS, sampleAuditPayload } from '../src/testing.js';

/**
 * Core V2 S2-Audit.2 (ADR-0067 decision 7, ADR-0069 decisions 2 and 3; Owner decisions D1 to D5): the three authorization receipt actions.
 */
type P = Record<string, any>;
const ISSUED = 'authorization_receipt.issued';
const CONSUMED = 'authorization_receipt.consumed';
const VOIDED = 'authorization_receipt.voided';
const RECEIPTS = [ISSUED, CONSUMED, VOIDED] as const;
const OWNER = { type: 'user', id: SAMPLE_IDS.user, userKind: 'owner' };
const base = (a: (typeof RECEIPTS)[number]) => JSON.parse(JSON.stringify(sampleAuditPayload(a, 'complete'))) as P;
const code = (f: () => unknown) => {
  try { f(); } catch (e) { return e instanceof AuditContractError ? e.code : `unexpected ${String(e)}`; }
  return 'accepted';
};
const v2 = (p: P, source = 'auth-service') => code(() => validateAuditPayload(p, source, 2));

describe('authorization receipt actions (S2-Audit.2)', () => {
  it('exactly three, owned by auth-service only, version 2, Company scope required, no Platform', () => {
    for (const a of RECEIPTS) {
      const e = AUDIT_CATALOG.get(a)!;
      expect([e.producer, e.since, e.organization, e.resource, e.outcomes, e.scope]).toEqual(['auth-service', 2, 'none', ['authorization_receipt'], ['succeeded'], { company: 'required' }]);
      for (const other of CORE_PRODUCERS.filter((x) => x !== 'auth-service')) expect(v2(base(a), other), `${a} ${other}`).toBe('producer_not_admitted');
    }
    expect([...AUDIT_CATALOG.keys()].filter((a) => a.startsWith('authorization_receipt.')).sort()).toEqual([CONSUMED, ISSUED, VOIDED]);
  });

  it('a valid event of each carries exactly: actor, the receipt, the Company, and approvedBy only on .consumed', () => {
    for (const a of RECEIPTS) expect(v2(base(a))).toBe('accepted');
    expect(Object.keys(validateAuditPayload(sampleAuditPayload(CONSUMED, 'minimal'), 'auth-service', 2)).sort()).toEqual(['action', 'actor', 'approvedBy', 'companyId', 'organizationId', 'outcome', 'resource']);
    expect(Object.keys(validateAuditPayload(sampleAuditPayload(ISSUED, 'minimal'), 'auth-service', 2)).sort()).toEqual(['action', 'actor', 'companyId', 'organizationId', 'outcome', 'resource']);
  });

  it('companyId is required on all three; Platform and an Organization are refused', () => {
    for (const a of RECEIPTS) {
      const { companyId: _c, ...noCompany } = base(a);
      expect(v2(noCompany), a).toBe('invalid_scope');
      expect(v2({ ...base(a), platformId: SAMPLE_IDS.platform }), a).toBe('invalid_scope');
      expect(v2({ ...base(a), organizationId: SAMPLE_IDS.organization }), a).toBe('invalid_organization');
      expect(v2({ ...base(a), companyId: 'not-a-uuid' }), a).toBe('invalid_scope');
    }
  });

  it('actors (D4): .issued only the Owner; .consumed only a service; .voided only the replay process, never the Owner', () => {
    expect(v2({ ...base(ISSUED), actor: { type: 'service', id: 'payment-service' } })).toBe('invalid_actor');
    expect(v2({ ...base(ISSUED), actor: { ...OWNER, userKind: 'operator' } })).toBe('invalid_actor');
    expect(v2({ ...base(CONSUMED), actor: OWNER })).toBe('invalid_actor');
    expect(v2({ ...base(CONSUMED), actor: { type: 'service', id: 'payment-service' } })).toBe('accepted');
    expect(v2({ ...base(VOIDED), actor: OWNER })).toBe('invalid_actor'); // an automatic void is never attributed to the Owner
    expect(v2({ ...base(VOIDED), actor: { type: 'system', id: 'authorization_receipt_replay' } })).toBe('accepted');
    expect(v2({ ...base(VOIDED), actor: { type: 'system', id: 'refresh_reuse_detection' } })).toBe('invalid_actor');
  });

  it('approvedBy (D5): required on .consumed, exactly {type:user, id, userKind:owner}; refused anywhere else', () => {
    const { approvedBy: _a, ...none } = base(CONSUMED);
    expect(v2(none)).toBe('invalid_approval');
    for (const bad of [
      { type: 'user', id: SAMPLE_IDS.user, userKind: 'operator' }, { type: 'user', id: SAMPLE_IDS.user, userKind: 'member' },
      { type: 'service', id: 'payment-service' }, { type: 'user', id: 'u1', userKind: 'owner' }, { type: 'user', id: SAMPLE_IDS.user },
      { ...OWNER, extra: 1 }, 'owner', null,
    ]) expect(v2({ ...base(CONSUMED), approvedBy: bad }), JSON.stringify(bad)).toBe('invalid_approval');
    expect(v2({ ...base(ISSUED), approvedBy: OWNER })).toBe('invalid_approval');
    expect(v2({ ...base(VOIDED), approvedBy: OWNER })).toBe('invalid_approval');
  });

  it('no receipt secret, digest, proof, binding or amount can travel (D4): every such field is refused', () => {
    const forbidden: Array<[P, string]> = [
      [{ secret: 'x' }, 'sensitive_field'], [{ secretDigest: 'a'.repeat(64) }, 'sensitive_field'], [{ stepUpToken: SAMPLE_IDS.uuidA }, 'sensitive_field'],
      [{ bindingDigest: 'a'.repeat(64) }, 'sensitive_value'], [{ binding: { amount: 1 } }, 'unknown_field'], [{ amount: 4900 }, 'unknown_field'],
      [{ changes: { amount: 4900 } }, 'invalid_changes'], [{ verifiedBy: { service: 'auth-service', mechanism: 'authorization_receipt', ref: SAMPLE_IDS.uuidA } }, 'unknown_field'],
      [{ requestedBy: OWNER }, 'unknown_field'], [{ via: 'payment-service' }, 'unknown_field'],
    ];
    for (const [extra, expected] of forbidden) expect(v2({ ...base(CONSUMED), ...extra }), JSON.stringify(extra)).toBe(expected);
  });

  it('a relay-shaped version-2 envelope of each validates; a version-1 one is unsupported_version', () => {
    for (const a of RECEIPTS) {
      const env = (version: number) => ({
        id: SAMPLE_IDS.uuidA, name: `audit.${a}`, payload: base(a),
        headers: { eventId: SAMPLE_IDS.uuidA, occurredAt: '2026-10-25T10:00:00.000Z', source: 'auth-service', version },
      });
      expect(validateAuditEvent(env(2)).schemaVersion).toBe(2);
      expect(code(() => validateAuditEvent(env(1)))).toBe('unsupported_version');
    }
  });
});

describe('AuditEventWriter: the envelope version is the action\'s own (S2-Audit.2)', () => {
  const capture = () => {
    const events: AuditOutboxEvent[] = [];
    const writer = new AuditEventWriter({ sourceService: 'auth-service', outbox: { enqueue: async (_q: unknown, e: AuditOutboxEvent) => { events.push(e); return SAMPLE_IDS.uuidB; } } });
    const tx = { query: async () => ({}) };
    return { events, writer, tx };
  };

  it('writes version 2 for a receipt action and version 1 for every earlier action', async () => {
    const { events, writer, tx } = capture();
    await writer.write(tx, base(ISSUED) as never);
    await writer.write(tx, JSON.parse(JSON.stringify(sampleAuditPayload('session.refresh_reuse_detected'))) as never);
    expect(events.map((e) => [e.name, e.version])).toEqual([[`audit.${ISSUED}`, 2], ['audit.session.refresh_reuse_detected', 1]]);
    expect(events[0]!.payload).toEqual(base(ISSUED));
  });

  it('a version-1 action still cannot carry a version-2 field through the writer', async () => {
    const { writer, tx } = capture();
    await expect(writer.write(tx, { ...JSON.parse(JSON.stringify(sampleAuditPayload('session.refresh_reuse_detected'))), companyId: SAMPLE_IDS.company } as never)).rejects.toThrow('unknown_field');
  });
});
