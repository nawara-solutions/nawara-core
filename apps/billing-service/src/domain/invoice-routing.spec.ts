import { describe, expect, it } from 'vitest';
import { decideRouting, type RoutingLine } from './invoice-routing.js';

const P = '33333333-3333-4333-8333-333333333333';
const ORG = '22222222-2222-4222-8222-222222222222';
const line = (subscriptionTarget: RoutingLine['subscriptionTarget'], productId = randomish()): RoutingLine =>
  ({ productId, subscriptionTarget, platformId: subscriptionTarget === 'none' ? null : P });
let n = 0;
function randomish(): string {
  n += 1;
  return `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
}

/** Core V2 S3a (ADR-0044 B2, Owner decision Option C): the server's routing of an invoice as it leaves draft. */
describe('decideRouting', () => {
  it('no subscription line at all: non_entitlement, target none, no beneficiary or reference, for a user or a Company payer', () => {
    for (const payerType of ['user', 'company']) {
      expect(decideRouting({ payerType, payerId: 'p', organizationId: ORG, lines: [line('none'), line('none')] })).toEqual({
        routed: { purpose: 'non_entitlement', target: 'none', beneficiaryUserId: null, organizationId: null, productId: null, platformId: null },
      });
    }
  });

  it('Core V2 S4a (P-1, the prospective B2 narrowing; B7, DB-15): an Organization never pays an ordinary invoice', () => {
    expect(decideRouting({ payerType: 'organization', payerId: ORG, organizationId: ORG, lines: [line('none')] })).toEqual({ refused: 'organization_payer' });
  });

  it('one organization line, a user payer and an Organization: organization_subscription for THAT Organization and product', () => {
    const l = line('organization');
    expect(decideRouting({ payerType: 'user', payerId: 'u-1', organizationId: ORG, lines: [line('none'), l] })).toEqual({
      routed: { purpose: 'organization_subscription', target: 'organization', beneficiaryUserId: null, organizationId: ORG, productId: l.productId, platformId: P },
    });
  });

  it('one personal line and a user payer: direct_purchase, the payer IS the beneficiary; the invoice\'s Organization is not recorded', () => {
    const l = line('personal');
    expect(decideRouting({ payerType: 'user', payerId: 'u-1', organizationId: ORG, lines: [l] })).toEqual({
      routed: { purpose: 'direct_purchase', target: 'personal', beneficiaryUserId: 'u-1', organizationId: null, productId: l.productId, platformId: P },
    });
  });

  it.each([
    ['two subscription lines', { payerType: 'user', organizationId: ORG, lines: [line('organization'), line('personal')] }, 'multiple_subscription_lines'],
    ['two organization lines', { payerType: 'user', organizationId: ORG, lines: [line('organization'), line('organization')] }, 'multiple_subscription_lines'],
    ['an Organization paying an Organization subscription (B7)', { payerType: 'organization', organizationId: ORG, lines: [line('organization')] }, 'organization_payer'],
    ['a company paying an Organization subscription', { payerType: 'company', organizationId: ORG, lines: [line('organization')] }, 'organization_payer'],
    ['an Organization subscription without its Organization', { payerType: 'user', organizationId: null, lines: [line('organization')] }, 'organization_missing'],
    ['an Organization paying a personal product (assisted settlement, S5a)', { payerType: 'organization', organizationId: ORG, lines: [line('personal')] }, 'assisted_settlement_unavailable'],
    ['a company paying a personal product', { payerType: 'company', organizationId: null, lines: [line('personal')] }, 'payer_not_user'],
  ])('refuses %s', (_label, input, reason) => {
    expect(decideRouting({ payerId: 'p', ...input })).toEqual({ refused: reason });
  });

  it('never reads entitlementKind: only the product target decides (a legacy organization_license line with target none is ordinary)', () => {
    const legacy = { ...line('none'), entitlementKind: 'organization_license', interval: 'recurring' } as RoutingLine;
    expect(decideRouting({ payerType: 'user', payerId: 'u-1', organizationId: ORG, lines: [legacy] })).toMatchObject({ routed: { purpose: 'non_entitlement' } });
  });
});
