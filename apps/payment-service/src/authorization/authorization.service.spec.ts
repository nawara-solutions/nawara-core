import { describe, expect, it } from 'vitest';
import { HierarchyUnavailableError, type AuthIdentity, type AuthMembership, type Caller, type OrganizationReferenceResolver } from '@nawara/service-kit';
import { AuthorizationService } from './authorization.service.js';

/**
 * Core V2 DO-28 (B-026; the Owner's decision of 2026-11-14): an `organization_subscription` attempt is started only by its named user payer
 * while Auth's live answer shows them as an active administrator of the payment's exact Organization, anchored to its authoritative Platform.
 */
const P1 = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const P2 = 'aaaaaaaa-0000-4000-8000-0000000000f2';
const ORG_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const ORG_B = '0b0b0b0b-0000-4000-8000-00000000000b'; // same Platform and Company as ORG_A
const ORG_X = '0e0e0e0e-0000-4000-8000-00000000000e'; // another Company's Organization
const PAYER = '1a1a1a1a-0000-4000-8000-0000000000a1';

const reference = (down = false): OrganizationReferenceResolver & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (organizationId) => {
      calls.push(organizationId);
      if (down) throw new HierarchyUnavailableError();
      const anchors: Record<string, { platformId: string; companyId: string }> = { [ORG_A]: { platformId: P1, companyId: 'c1' }, [ORG_B]: { platformId: P1, companyId: 'c1' }, [ORG_X]: { platformId: P2, companyId: 'c2' } };
      return anchors[organizationId] ? { organizationId, ...anchors[organizationId] } : null;
    },
  };
};
const membership = (organization: string, o: Partial<AuthMembership> = {}): AuthMembership =>
  ({ id: crypto.randomUUID(), organization: { id: organization }, platform: { id: organization === ORG_X ? P2 : P1 }, status: 'active', isOrganizationAdmin: true, ...o });
const user = (memberships: unknown[], id = PAYER): Caller => ({ kind: 'user', identity: { id, adminTier: null, isActive: true, memberships } as AuthIdentity });
const payment = (o: Record<string, unknown> = {}) =>
  ({ producer: 'billing-service', payerType: 'user', payerId: PAYER, organizationId: ORG_A, purpose: 'organization_subscription', ...o }) as never;

const start = (caller: Caller, p = payment(), ref = reference()) => new AuthorizationService(ref).assertCanStartAttempt(p, caller);
const refused = async (caller: Caller, p = payment(), ref = reference()) => {
  const e = await start(caller, p, ref).then(() => null, (x: unknown) => x as { getStatus(): number; getResponse(): { code: string } });
  expect(e, 'expected a refusal').not.toBeNull();
  return [e!.getStatus(), e!.getResponse().code];
};

describe('DO-28: who may start an Organization subscription attempt', () => {
  it('A: the named payer who is an active administrator of exactly that Organization, on its Platform', async () => {
    await expect(start(user([membership(ORG_A)]))).resolves.toBeUndefined();
    await expect(start(user([membership(ORG_B, { isOrganizationAdmin: false }), membership(ORG_A)]))).resolves.toBeUndefined();
  });

  it('B, C, D: an ordinary, pending, rejected or revoked member, or a former administrator, is refused (403)', async () => {
    for (const o of [{ isOrganizationAdmin: false }, { status: 'pending' as const }, { status: 'rejected' as const }, { status: 'revoked' as const }, { status: 'revoked' as const, isOrganizationAdmin: false }]) {
      expect(await refused(user([membership(ORG_A, o)]))).toEqual([403, 'operation_not_permitted']);
    }
    expect(await refused(user([]))).toEqual([403, 'operation_not_permitted']); // no membership at all
  });

  it('E, F, G: another Organization\'s administrator (same Company or another Company) is refused; as a non-payer they have no relation (404)', async () => {
    expect(await refused(user([membership(ORG_B)]))).toEqual([403, 'operation_not_permitted']);
    expect(await refused(user([membership(ORG_X)]))).toEqual([403, 'operation_not_permitted']);
    expect(await refused(user([membership(ORG_A)], crypto.randomUUID()))).toEqual([404, 'not_found']); // an admin of ORG_A who is not the named payer
  });

  it('a membership whose Platform is not the Organization\'s authoritative Platform, or an unknown Organization, is refused', async () => {
    expect(await refused(user([membership(ORG_A, { platform: { id: P2 } })]))).toEqual([403, 'operation_not_permitted']);
    expect(await refused(user([membership(ORG_A)]), payment({ organizationId: '0f0f0f0f-0000-4000-8000-00000000000f' }))).toEqual([403, 'operation_not_permitted']);
  });

  it('I: missing, malformed or duplicated membership evidence never qualifies, and a payment with no Organization is refused', async () => {
    const malformed: unknown[] = [
      { ...membership(ORG_A), isOrganizationAdmin: 'true' },
      { ...membership(ORG_A), status: 'ACTIVE' },
      { ...membership(ORG_A), platform: null },
      { ...membership(ORG_A), platform: { id: 7 } },
      { ...membership(ORG_A), id: undefined },
      { organization: { id: ORG_A } },
    ];
    for (const m of malformed) expect(await refused(user([m]))).toEqual([403, 'operation_not_permitted']);
    expect(await refused(user([membership(ORG_A), membership(ORG_A)]))).toEqual([403, 'operation_not_permitted']); // Auth holds one per Organization
    expect(await refused(user([membership(ORG_A), membership(ORG_A, { status: 'revoked', isOrganizationAdmin: false })]))).toEqual([403, 'operation_not_permitted']);
    expect(await refused(user(null as unknown as unknown[]))).toEqual([403, 'operation_not_permitted']);
    await expect(start(user([null, 'x', { organization: null }, membership(ORG_A)]))).resolves.toBeUndefined(); // junk for no Organization is not evidence for this one
  });

  it('H: the Organization reference unable to answer fails closed (503), and a caller who cannot qualify never triggers the read', async () => {
    const down = reference(true);
    await expect(start(user([membership(ORG_A)]), payment(), down)).rejects.toBeInstanceOf(HierarchyUnavailableError);
    const r = reference();
    await refused(user([membership(ORG_A, { isOrganizationAdmin: false })]), payment(), r);
    expect(r.calls).toEqual([]);
  });

  it('a request-supplied caller is never a source: a service caller, even the producer, cannot start an attempt', async () => {
    expect(await refused({ kind: 'service', service: 'billing-service' })).toEqual([403, 'operation_not_permitted']);
    expect(await refused({ kind: 'service', service: 'other' })).toEqual([404, 'not_found']);
  });

  it('N: every other purpose is unchanged: the user payer starts an attempt with no membership at all', async () => {
    for (const purpose of ['direct_purchase', 'non_entitlement', null]) {
      const ref = reference();
      await expect(start(user([]), payment({ purpose, organizationId: null }), ref)).resolves.toBeUndefined();
      expect(ref.calls).toEqual([]);
    }
  });
});
