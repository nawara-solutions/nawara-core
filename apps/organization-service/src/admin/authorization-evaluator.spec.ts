import { describe, expect, it } from 'vitest';
import type { AuthGrantFacts } from './auth-grants-client.js';
import { canCreateOrganization, canCreatePlatform, canUpdateOrganization, canUpdatePlatform, platformAuthority } from './authorization-evaluator.js';

const owner = (companyId: string | null): AuthGrantFacts => ({ userId: 'u-owner', kind: 'owner', companyId, platformAssignments: [], organizationAdminMemberships: [] });
const operator = (platformAssignments: string[]): AuthGrantFacts => ({ userId: 'u-op', kind: 'operator', companyId: null, platformAssignments, organizationAdminMemberships: [] });
const member = (organizationAdminMemberships: string[]): AuthGrantFacts => ({ userId: 'u-mem', kind: 'member', companyId: null, platformAssignments: [], organizationAdminMemberships });

describe('authorization-evaluator (ADR-0042 Amendment 1 A.2)', () => {
  describe('platformAuthority / canUpdatePlatform', () => {
    it('grants owner when the platform belongs to the owner\'s own company', () => {
      expect(platformAuthority(owner('co-1'), { companyId: 'co-1' })).toBe('owner');
      expect(canUpdatePlatform(owner('co-1'), { companyId: 'co-1' })).toBe('owner');
    });
    it('denies owner of a different company', () => {
      expect(platformAuthority(owner('co-1'), { companyId: 'co-2' })).toBeNull();
    });
    it('denies an owner with no company (should not happen, but must not silently grant)', () => {
      expect(platformAuthority(owner(null), { companyId: 'co-1' })).toBeNull();
    });
    it('never grants an operator or member Platform authority', () => {
      expect(platformAuthority(operator(['p-1']), { companyId: 'co-1' })).toBeNull();
      expect(platformAuthority(member(['o-1']), { companyId: 'co-1' })).toBeNull();
    });
  });

  describe('canCreatePlatform', () => {
    it('grants only the owner of the target company', () => {
      expect(canCreatePlatform(owner('co-1'), { id: 'co-1' })).toBe('owner');
      expect(canCreatePlatform(owner('co-2'), { id: 'co-1' })).toBeNull();
    });
    it('an operator can never create a Platform, even if somehow platform-assigned (Platform creation is owner-only)', () => {
      expect(canCreatePlatform(operator(['p-1']), { id: 'co-1' })).toBeNull();
    });
  });

  describe('canCreateOrganization', () => {
    it('grants the owner of the platform\'s company', () => {
      expect(canCreateOrganization(owner('co-1'), { id: 'p-1', companyId: 'co-1' })).toBe('owner');
    });
    it('grants an operator assigned to that exact platform', () => {
      expect(canCreateOrganization(operator(['p-1']), { id: 'p-1', companyId: 'co-1' })).toBe('operator');
    });
    it('denies an operator assigned to a DIFFERENT platform', () => {
      expect(canCreateOrganization(operator(['p-2']), { id: 'p-1', companyId: 'co-1' })).toBeNull();
    });
    it('denies an operator with no assignments at all', () => {
      expect(canCreateOrganization(operator([]), { id: 'p-1', companyId: 'co-1' })).toBeNull();
    });
    it('denies the owner of a different company', () => {
      expect(canCreateOrganization(owner('co-2'), { id: 'p-1', companyId: 'co-1' })).toBeNull();
    });
    it('a member (even an org-admin of some organization) can never create an Organization', () => {
      expect(canCreateOrganization(member(['o-1']), { id: 'p-1', companyId: 'co-1' })).toBeNull();
    });
  });

  describe('canUpdateOrganization', () => {
    const org = { id: 'o-1', platformId: 'p-1' };
    const platform = { companyId: 'co-1' };
    it('grants the owner of the platform\'s company', () => {
      expect(canUpdateOrganization(owner('co-1'), org, platform)).toBe('owner');
    });
    it('grants an operator assigned to the organization\'s platform', () => {
      expect(canUpdateOrganization(operator(['p-1']), org, platform)).toBe('operator');
    });
    it('denies an operator assigned to a different platform', () => {
      expect(canUpdateOrganization(operator(['p-9']), org, platform)).toBeNull();
    });
    it('grants a member who is an active org-admin of THIS organization', () => {
      expect(canUpdateOrganization(member(['o-1']), org, platform)).toBe('org_admin');
    });
    it('denies a member who is org-admin of a DIFFERENT organization', () => {
      expect(canUpdateOrganization(member(['o-2']), org, platform)).toBeNull();
    });
    it('denies a member with no org-admin memberships at all', () => {
      expect(canUpdateOrganization(member([]), org, platform)).toBeNull();
    });
    it('denies the owner of a different company', () => {
      expect(canUpdateOrganization(owner('co-9'), org, platform)).toBeNull();
    });
  });

  describe('never trusts client-supplied facts (structural: every function only reads AuthGrantFacts and server-resolved target rows)', () => {
    it('changing which fields exist on the facts object cannot forge authority — only companyId/platformAssignments/organizationAdminMemberships are read', () => {
      const forged = { userId: 'x', kind: 'member', companyId: 'co-1', platformAssignments: ['p-1'], organizationAdminMemberships: [], role: 'admin', isOrganizationAdmin: true } as unknown as AuthGrantFacts;
      // Even with extra, forged-looking fields, a member with no organizationAdminMemberships entry for this org is denied.
      expect(canUpdateOrganization(forged, { id: 'o-1', platformId: 'p-1' }, { companyId: 'co-1' })).toBeNull();
    });
  });
});
