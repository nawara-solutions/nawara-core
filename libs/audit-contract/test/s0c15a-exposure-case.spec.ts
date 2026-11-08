import { describe, expect, it } from 'vitest';
import { AUDIT_CATALOG, AuditContractError, type CatalogEntry } from '../src/index.js';
import { validateAuditPayloadWith } from '../src/validate.js';

/**
 * Core V2 S0-C15A item 4 (BIL-33 N, DO-72): one new value of `reconciliation_case.opened`'s `case_type`. No action, resolution value or field is added, so the
 * action count and Billing's topic grants are unchanged. An audit-service on the previous catalog refuses the value as `invalid_changes`: the audit-service
 * upgrade must precede a Billing that emits it. Both answers are pinned here.
 */
const code = (f: () => unknown) => {
  try { f(); } catch (e) { return e instanceof AuditContractError ? e.code : `unexpected ${String(e)}`; }
  return 'accepted';
};
const current = (a: string) => AUDIT_CATALOG.get(a as never) as CatalogEntry | undefined;
const previous = (a: string): CatalogEntry | undefined => {
  const e = current(a);
  if (a !== 'reconciliation_case.opened' || !e) return e;
  const spec = e.changes.case_type as { values: readonly string[] };
  return { ...e, changes: { ...e.changes, case_type: { ...spec, values: spec.values.filter((v) => v !== 'chargeback_refund_exposure') } as never } };
};
const opened = (caseType: string) => ({
  action: 'reconciliation_case.opened', actor: { type: 'system', id: 'reconciliation_worker' }, organizationId: '33333333-3333-4333-8333-333333333333',
  resource: { type: 'reconciliation_case', id: '88888888-8888-4888-8888-888888888888' }, outcome: 'succeeded',
  changes: { case_type: caseType, evidence_id: '99999999-9999-4999-8999-999999999999', amount: 70 },
});
const withCatalog = (lookup: (a: string) => CatalogEntry | undefined, p: unknown) => code(() => validateAuditPayloadWith(lookup as never, p, 'billing-service', 1));

describe('S0-C15A: the chargeback_refund_exposure case type', () => {
  it('the catalog accepts it; the resolved values and reasons are unchanged', () => {
    expect(withCatalog(current, opened('chargeback_refund_exposure'))).toBe('accepted');
    const resolved = current('reconciliation_case.resolved')!;
    expect((resolved.changes.resolution as { values: readonly string[] }).values).not.toContain('chargeback_refund_exposure');
    expect((resolved.changes.reason as { values: readonly string[] }).values).toEqual(['reviewed_no_financial_effect', 'provider_statement_reviewed', 'duplicate_evidence_reviewed']);
  });
  it('an audit-service on the previous catalog refuses it as invalid_changes; earlier values are accepted', () => {
    expect(withCatalog(previous, opened('chargeback_refund_exposure'))).toBe('invalid_changes');
    expect(withCatalog(previous, opened('chargeback_effect_waiting'))).toBe('accepted');
  });
});
