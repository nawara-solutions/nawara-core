import { AUDIT_CATALOG, AuditContractError, type CatalogEntry } from '../src/index.js';
import { validateAuditPayloadWith } from '../src/validate.js';

/**
 * Core V2 S0-C10 item 7 (register BIL-33 L; the Owner's O-5, 2026-11-05): `reconciliation_case.opened` gains the case type
 * `chargeback_loss_review`. It is an additional value of an existing action's enumerated change, not a new action, so an audit-service
 * still running the previous catalog refuses it as `invalid_changes` (not the replayable `unknown_action`): the audit-service upgrade
 * must precede a Billing that opens this case type. Both answers are pinned here.
 */
const ACTION = 'reconciliation_case.opened';
const payload = (caseType: string) => ({
  action: ACTION, actor: { type: 'system', id: 'reconciliation_worker' }, organizationId: '33333333-3333-4333-8333-333333333333',
  resource: { type: 'reconciliation_case', id: '44444444-4444-4444-8444-444444444444' }, outcome: 'succeeded',
  changes: { case_type: caseType, evidence_id: '55555555-5555-4555-8555-555555555555', amount: 6500 },
});
const code = (f: () => unknown) => {
  try { f(); } catch (e) { return e instanceof AuditContractError ? e.code : `unexpected ${String(e)}`; }
  return 'accepted';
};
const current = AUDIT_CATALOG.get(ACTION as never)!;
/** The catalog as it was before S0-C10: the same entry, without the new value. */
const previous: CatalogEntry = (() => {
  const spec = current.changes.case_type as { values: readonly string[] };
  return { ...current, changes: { ...current.changes, case_type: { ...spec, values: spec.values.filter((v) => v !== 'chargeback_loss_review') } as never } };
})();
const withCatalog = (entry: CatalogEntry, caseType: string) =>
  code(() => validateAuditPayloadWith((a) => (a === ACTION ? entry : undefined), payload(caseType), 'billing-service', 1));

describe('S0-C10: the chargeback_loss_review case type in reconciliation_case.opened', () => {
  it('the current catalog accepts it, alongside the case types it already had', () => {
    expect(withCatalog(current, 'chargeback_loss_review')).toBe('accepted');
    expect(withCatalog(current, 'capture_contradiction')).toBe('accepted');
  });

  it('an audit-service on the previous catalog refuses it as invalid_changes, not unknown_action; earlier case types are unaffected', () => {
    expect(withCatalog(previous, 'chargeback_loss_review')).toBe('invalid_changes');
    expect(withCatalog(previous, 'capture_contradiction')).toBe('accepted');
  });
});
