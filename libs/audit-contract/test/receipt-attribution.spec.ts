import { AUDIT_CATALOG, AuditContractError, RECEIPT_OPERATIONS, validateAuditPayload } from '../src/index.js';
import { validateAuditEvent } from '../src/consumer.js';
import { SAMPLE_IDS, sampleAuditPayload } from '../src/testing.js';

/**
 * Core V2 F-22 / G6-B (DO-62; ADR-0070; the Owner's D-F22-2 to D-F22-4, 2026-11-22): the receipt attribution tuple of the three
 * `authorization_receipt.*` actions. Optional as a whole (a version-2 event written before it stays valid), complete and consistent
 * when present: a known operation, exactly its target type, a target id, and on the consumption the consumer's reference and the
 * operation's one audience as the actor.
 */
type P = Record<string, any>;
const ISSUED = 'authorization_receipt.issued';
const CONSUMED = 'authorization_receipt.consumed';
const VOIDED = 'authorization_receipt.voided';
const RECEIPTS = [ISSUED, CONSUMED, VOIDED] as const;
const OPS = Object.keys(RECEIPT_OPERATIONS) as Array<keyof typeof RECEIPT_OPERATIONS>;
const TARGET = '0d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f44';
const REF = '1e2f3a4b-5c6d-4e7f-9a8b-0c1d2e3f4a55';

const code = (f: () => unknown) => {
  try { f(); } catch (e) { return e instanceof AuditContractError ? e.code : `unexpected ${String(e)}`; }
  return 'accepted';
};
const v2 = (p: P, source = 'auth-service') => code(() => validateAuditPayload(p, source, 2));
/** The historical event: what Auth wrote before attribution (no `changes`). */
const historical = (a: (typeof RECEIPTS)[number]) => JSON.parse(JSON.stringify(sampleAuditPayload(a, 'minimal'))) as P;
const attribution = (op: keyof typeof RECEIPT_OPERATIONS, consumed: boolean): P => ({
  operation: op, target_type: RECEIPT_OPERATIONS[op].targetType, target_id: TARGET, ...(consumed ? { consume_ref: REF } : {}),
});
/** A complete, consistent attributed event of `a` for `op`. */
const attributed = (a: (typeof RECEIPTS)[number], op: keyof typeof RECEIPT_OPERATIONS): P => {
  const p = historical(a);
  p.changes = attribution(op, a === CONSUMED);
  if (a === CONSUMED) p.actor = { type: 'service', id: RECEIPT_OPERATIONS[op].audience };
  return p;
};

describe('receipt attribution: the operation matrix (D-F22-2)', () => {
  it('is exactly the ten Auth receipt operations, each with its one audience and target type', () => {
    expect(RECEIPT_OPERATIONS).toEqual({
      refund: { audience: 'payment-service', targetType: 'refund_case' },
      dispute_decision: { audience: 'payment-service', targetType: 'payment_dispute' },
      fraud_hold_place: { audience: 'billing-service', targetType: 'fraud_hold' },
      fraud_hold_release: { audience: 'billing-service', targetType: 'fraud_hold' },
      recovery_surplus_external: { audience: 'billing-service', targetType: 'recovery_surplus' },
      late_settlement_apply: { audience: 'billing-service', targetType: 'assistance_late_settlement' },
      provider_fact_associate: { audience: 'payment-service', targetType: 'provider_transaction_fact' },
      recovery_write_off: { audience: 'billing-service', targetType: 'recovery_obligation' },
      recovery_restriction_suspend: { audience: 'billing-service', targetType: 'recovery_restriction_suspension' },
      recovery_restriction_revoke: { audience: 'billing-service', targetType: 'recovery_restriction_suspension' },
    });
    expect(Object.isFrozen(AUDIT_CATALOG.get(CONSUMED)!.changes)).toBe(true);
  });

  it('only the receipt actions carry the rule; only the consumption names a consumer reference', () => {
    for (const [a, e] of AUDIT_CATALOG) {
      expect(e.attribution, a).toEqual(a === CONSUMED ? { consumeRef: true } : a === ISSUED || a === VOIDED ? { consumeRef: false } : undefined);
    }
    expect(Object.keys(AUDIT_CATALOG.get(ISSUED)!.changes)).toEqual(['operation', 'target_type', 'target_id']);
    expect(Object.keys(AUDIT_CATALOG.get(VOIDED)!.changes)).toEqual(['operation', 'target_type', 'target_id']);
    expect(Object.keys(AUDIT_CATALOG.get(CONSUMED)!.changes)).toEqual(['operation', 'target_type', 'target_id', 'consume_ref']);
    for (const a of RECEIPTS) for (const s of Object.values(AUDIT_CATALOG.get(a)!.changes)) expect(s.required, a).toBe(false);
  });
});

describe('receipt attribution: valid events', () => {
  it('NC-10: a historical version-2 event of each action, with no attribution, stays valid and is not upgraded', () => {
    for (const a of RECEIPTS) {
      expect(v2(historical(a)), a).toBe('accepted');
      expect(validateAuditPayload(historical(a), 'auth-service', 2).changes, a).toBeUndefined();
    }
  });

  it('every operation on every action, complete and consistent, is accepted and kept exactly', () => {
    for (const a of RECEIPTS) {
      for (const op of OPS) {
        expect(v2(attributed(a, op)), `${a} ${op}`).toBe('accepted');
        expect(validateAuditPayload(attributed(a, op), 'auth-service', 2).changes, `${a} ${op}`).toEqual(attribution(op, a === CONSUMED));
      }
    }
  });

  it('the complete sample of each action is one consistent tuple (table-driven suites stay valid)', () => {
    for (const a of RECEIPTS) expect(v2(JSON.parse(JSON.stringify(sampleAuditPayload(a, 'complete')))), a).toBe('accepted');
  });

  it('a relay-shaped version-2 envelope carries the attribution through the consumer validation; version 1 is still unsupported', () => {
    for (const a of RECEIPTS) {
      const env = (version: number) => ({
        id: SAMPLE_IDS.uuidA, name: `audit.${a}`, payload: attributed(a, 'refund'),
        headers: { eventId: SAMPLE_IDS.uuidA, occurredAt: '2026-11-22T10:00:00.000Z', source: 'auth-service', version },
      });
      expect(validateAuditEvent(env(2)).payload.changes).toEqual(attribution('refund', a === CONSUMED));
      expect(code(() => validateAuditEvent(env(1)))).toBe('unsupported_version');
    }
  });
});

describe('receipt attribution: negative controls', () => {
  it('NC-1: an unknown or malformed operation is refused', () => {
    for (const a of RECEIPTS) {
      for (const bad of ['payment_refund', 'Refund', 'refund ', '', 'constructor', '__proto__', 'hasOwnProperty', 1, null, true]) {
        const p = attributed(a, 'refund');
        p.changes.operation = bad;
        expect(v2(p), `${a} ${JSON.stringify(bad)}`).toBe('invalid_changes');
      }
    }
  });

  it('NC-2: every target type other than the operation\'s own is refused, for every operation', () => {
    const types = [...new Set(Object.values(RECEIPT_OPERATIONS).map((o) => o.targetType))];
    for (const a of RECEIPTS) {
      for (const op of OPS) {
        for (const t of types.filter((x) => x !== RECEIPT_OPERATIONS[op].targetType)) {
          const p = attributed(a, op);
          p.changes.target_type = t;
          expect(v2(p), `${a} ${op} ${t}`).toBe('invalid_changes');
        }
        for (const t of ['refund_attempt', 'authorization_receipt', 'payment', 'organization']) {
          const p = attributed(a, op);
          p.changes.target_type = t;
          expect(v2(p), `${a} ${op} ${t}`).toBe('invalid_changes');
        }
      }
    }
  });

  it('NC-3: partial attribution is refused: every proper non-empty subset of the tuple', () => {
    for (const a of RECEIPTS) {
      const full = attribution('fraud_hold_place', a === CONSUMED);
      const keys = Object.keys(full);
      for (let mask = 1; mask < (1 << keys.length) - 1; mask++) {
        const p = attributed(a, 'fraud_hold_place');
        p.changes = Object.fromEntries(keys.filter((_, i) => mask & (1 << i)).map((k) => [k, full[k]]));
        expect(v2(p), `${a} ${Object.keys(p.changes).join(',')}`).toBe('invalid_changes');
      }
    }
  });

  it('NC-4 / NC-5: a consumption whose service actor is not exactly the operation\'s audience is refused', () => {
    for (const op of OPS) {
      const own = RECEIPT_OPERATIONS[op].audience;
      for (const other of ['payment-service', 'billing-service', 'auth-service', 'audit-service', 'file-service', 'sample-caller'].filter((x) => x !== own)) {
        const p = attributed(CONSUMED, op);
        p.actor = { type: 'service', id: other };
        expect(v2(p), `${op} by ${other}`).toBe('invalid_changes');
      }
    }
    // the same consumption, unattributed (historical), keeps its earlier rule: any service actor
    expect(v2({ ...historical(CONSUMED), actor: { type: 'service', id: 'billing-service' } })).toBe('accepted');
  });

  it('NC-8: consume_ref on .issued or .voided is refused (it is not in their catalog changes)', () => {
    for (const a of [ISSUED, VOIDED] as const) {
      for (const op of OPS) {
        const p = attributed(a, op);
        p.changes.consume_ref = REF;
        expect(v2(p), `${a} ${op}`).toBe('invalid_changes');
      }
      expect(v2({ ...historical(a), changes: { consume_ref: REF } }), a).toBe('invalid_changes');
    }
  });

  it('malformed ids, extra keys, empty or non-object changes are refused', () => {
    for (const a of RECEIPTS) {
      for (const [k, bad] of [['target_id', 'not-a-uuid'], ['target_id', TARGET.toUpperCase()], ['target_id', null], ['consume_ref', 'x']] as const) {
        if (k === 'consume_ref' && a !== CONSUMED) continue;
        const p = attributed(a, 'refund');
        p.changes[k] = bad;
        expect(v2(p), `${a} ${k}=${String(bad)}`).toBe('invalid_changes');
      }
      for (const extra of [{ amount: 4900 }, { refund_case_id: TARGET }, { audience: 'payment-service' }, { company_id: SAMPLE_IDS.company }]) {
        const p = attributed(a, 'refund');
        Object.assign(p.changes, extra);
        expect(v2(p), `${a} ${JSON.stringify(extra)}`).toBe('invalid_changes');
      }
      for (const bad of [{}, [], 'refund', null]) expect(v2({ ...historical(a), changes: bad }), `${a} ${JSON.stringify(bad)}`).toBe('invalid_changes');
    }
  });

  it('NC-6 / NC-7 boundaries: attribution changes neither scope nor producer rules', () => {
    for (const a of RECEIPTS) {
      const { companyId: _c, ...noCompany } = attributed(a, 'refund');
      expect(v2(noCompany), a).toBe('invalid_scope');
      expect(v2({ ...attributed(a, 'refund'), platformId: SAMPLE_IDS.platform }), a).toBe('invalid_scope');
      expect(v2({ ...attributed(a, 'refund'), organizationId: SAMPLE_IDS.organization }), a).toBe('invalid_organization');
      for (const other of ['payment-service', 'billing-service', 'audit-service']) expect(v2(attributed(a, 'refund'), other), `${a} ${other}`).toBe('producer_not_admitted');
      expect(code(() => validateAuditPayload(attributed(a, 'refund'), 'auth-service', 1)), a).toBe('unknown_field'); // companyId is version-2 only
    }
  });
});
