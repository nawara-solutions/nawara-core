import { AUDIT_CATALOG, AuditContractError, type CatalogEntry } from '../src/index.js';
import { validateAuditPayloadWith } from '../src/validate.js';

/**
 * Core V2 S0-C14 WP A (S0 §1.5 S0-C14 items 10 to 12; register AUTH-01 H, BIL-33 M). Two new Billing actions, the Owner's T3 suspension
 * and its revocation (version 1, no trusted scope, the Organization required), and one new value, `chargeback_effect_waiting`, of
 * `reconciliation_case.opened`'s `case_type`. The resolution values are unchanged. An audit-service on the previous catalog refuses a new
 * action as the replayable `unknown_action`, and the new case type as `invalid_changes`: the audit-service upgrade and Billing's broker
 * permission must precede a Billing that emits either. Both answers are pinned here.
 */
const ORG = '33333333-3333-4333-8333-333333333333';
const OBLIGATION = '44444444-4444-4444-8444-444444444444';
const owner = { type: 'user', id: '11111111-1111-4111-8111-111111111111', userKind: 'owner' };
const suspended = (over: Record<string, unknown> = {}) => ({
  action: 'recovery_restriction.suspended', actor: owner, organizationId: ORG, resource: { type: 'recovery_obligation', id: OBLIGATION }, outcome: 'succeeded',
  changes: { suspension_id: '55555555-5555-4555-8555-555555555555', dispute_id: '66666666-6666-4666-8666-666666666666', refund_case_id: '77777777-7777-4777-8777-777777777777', reason_code: 'refund_chargeback_overlap' },
  ...over,
});
const revoked = (over: Record<string, unknown> = {}) => ({
  action: 'recovery_restriction.suspension_revoked', actor: owner, organizationId: ORG, resource: { type: 'recovery_obligation', id: OBLIGATION }, outcome: 'succeeded',
  changes: { suspension_id: '55555555-5555-4555-8555-555555555555', reason_code: 'owner_reinstated_restriction' }, ...over,
});
const opened = (caseType: string) => ({
  action: 'reconciliation_case.opened', actor: { type: 'system', id: 'reconciliation_worker' }, organizationId: ORG,
  resource: { type: 'reconciliation_case', id: '88888888-8888-4888-8888-888888888888' }, outcome: 'succeeded',
  changes: { case_type: caseType, evidence_id: '99999999-9999-4999-8999-999999999999', amount: 6500 },
});
const code = (f: () => unknown) => {
  try { f(); } catch (e) { return e instanceof AuditContractError ? e.code : `unexpected ${String(e)}`; }
  return 'accepted';
};
const current = (a: string) => AUDIT_CATALOG.get(a as never) as CatalogEntry | undefined;
const NEW_ACTIONS = ['recovery_restriction.suspended', 'recovery_restriction.suspension_revoked'];
/** The catalog as it was before S0-C14: without the two actions and without the new case type. */
const previous = (a: string): CatalogEntry | undefined => {
  if (NEW_ACTIONS.includes(a)) return undefined;
  const e = current(a);
  if (a !== 'reconciliation_case.opened' || !e) return e;
  const spec = e.changes.case_type as { values: readonly string[] };
  return { ...e, changes: { ...e.changes, case_type: { ...spec, values: spec.values.filter((v) => v !== 'chargeback_effect_waiting') } as never } };
};
const withCatalog = (lookup: (a: string) => CatalogEntry | undefined, p: unknown, producer = 'billing-service') => code(() => validateAuditPayloadWith(lookup as never, p, producer, 1));

describe('S0-C14 WP A: recovery-restriction actions and the chargeback_effect_waiting case type', () => {
  it('declares both actions exactly: billing-service, commercial, version 1, Owner only, Organization required, the obligation as resource', () => {
    for (const a of NEW_ACTIONS) {
      expect(current(a), a).toMatchObject({ producer: 'billing-service', category: 'commercial', since: 1, actors: { user: ['owner'] }, organization: 'required', resource: ['recovery_obligation'] });
    }
    expect(Object.keys(current(NEW_ACTIONS[0]!)!.changes).sort()).toEqual(['dispute_id', 'reason_code', 'refund_case_id', 'suspension_id']);
    expect(Object.keys(current(NEW_ACTIONS[1]!)!.changes).sort()).toEqual(['reason_code', 'suspension_id']);
    expect((current(NEW_ACTIONS[0]!)!.changes.reason_code as { values: readonly string[] }).values).toEqual(['refund_chargeback_overlap']);
    expect((current(NEW_ACTIONS[1]!)!.changes.reason_code as { values: readonly string[] }).values).toEqual(['owner_reinstated_restriction']);
  });

  it('the current catalog accepts both actions and the new case type, and refuses what they must not carry', () => {
    expect(withCatalog(current, suspended())).toBe('accepted');
    expect(withCatalog(current, revoked())).toBe('accepted');
    expect(withCatalog(current, opened('chargeback_effect_waiting'))).toBe('accepted');
    expect(withCatalog(current, opened('chargeback_loss_review'))).toBe('accepted');
    expect(withCatalog(current, suspended(), 'payment-service')).not.toBe('accepted');
    expect(withCatalog(current, suspended({ organizationId: undefined }))).not.toBe('accepted');
    expect(withCatalog(current, suspended({ actor: { type: 'system', id: 'recovery_worker' } }))).not.toBe('accepted');
    expect(withCatalog(current, suspended({ changes: { ...suspended().changes, amount: 100 } }))).not.toBe('accepted');
    expect(withCatalog(current, revoked({ changes: {} }))).not.toBe('accepted');
    for (const reason_code of ['owner_review', 'owner_reinstated_restriction', 'Owner forgives']) {
      expect(withCatalog(current, suspended({ changes: { ...suspended().changes, reason_code } })), reason_code).not.toBe('accepted');
    }
    expect(withCatalog(current, revoked({ changes: { ...revoked().changes, reason_code: 'refund_chargeback_overlap' } }))).not.toBe('accepted');
    expect(withCatalog(current, suspended({ changes: (({ reason_code: _r, ...c }) => c)(suspended().changes) }))).not.toBe('accepted');
  });

  it('no resolution value is added: effect_applied and refund_completed already exist', () => {
    const r = current('reconciliation_case.resolved')!.changes.resolution as { values: readonly string[] };
    expect(r.values).toEqual(['refund_completed', 'late_settlement_applied', 'surplus_refunded', 'surplus_repaid', 'recovery_counted', 'loss_recognized', 'effect_applied',
      'authorization_resolved', 'acknowledged', 'chargeback_returned']);
  });

  it('an audit-service on the previous catalog refuses the actions as unknown_action and the case type as invalid_changes; earlier values are unaffected', () => {
    expect(withCatalog(previous, suspended())).toBe('unknown_action');
    expect(withCatalog(previous, revoked())).toBe('unknown_action');
    expect(withCatalog(previous, opened('chargeback_effect_waiting'))).toBe('invalid_changes');
    expect(withCatalog(previous, opened('chargeback_loss_review'))).toBe('accepted');
  });
});
