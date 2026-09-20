import type { AuthGrantFacts } from './auth-grants-client.js';

export type AdminAuthority = 'owner' | 'operator' | 'org_admin' | null;

/**
 * ADR-0042 Amendment 1 A.2: deterministic evaluation of human administrative authority, from
 * server-derived facts (Auth) against server-owned anchors (this service's own hierarchy). Pure
 * functions, no I/O — everything they need is already resolved by the caller. Mirrors the shape of
 * auth-service's own `platform-access.service.ts` (owner/operator/org_admin), which this restates for
 * Organization Service's own anchors rather than duplicating a second copy of the logic.
 *
 *   owner     : the target Platform's companyId equals the caller's own companyId
 *   operator  : the target Platform's id is among the caller's active PlatformAssignments
 *   org_admin : the target Organization's id is among the caller's active org-admin memberships
 *               (organization metadata only — org_admin never creates)
 */

/** Authority over a Platform (its own creation/update, or as the parent of an Organization). */
export function platformAuthority(facts: AuthGrantFacts, platform: { companyId: string }): AdminAuthority {
  if (facts.kind === 'owner' && facts.companyId === platform.companyId) return 'owner';
  return null;
}

/** Authority to CREATE a Platform under a Company: owner of that company only (ADR-0042 table). */
export function canCreatePlatform(facts: AuthGrantFacts, company: { id: string }): AdminAuthority {
  return facts.kind === 'owner' && facts.companyId === company.id ? 'owner' : null;
}

/** Authority to CREATE an Organization under a Platform: owner of the company, or an operator assigned to that platform. */
export function canCreateOrganization(facts: AuthGrantFacts, platform: { id: string; companyId: string }): AdminAuthority {
  if (facts.kind === 'owner' && facts.companyId === platform.companyId) return 'owner';
  if (facts.kind === 'operator' && facts.platformAssignments.includes(platform.id)) return 'operator';
  return null;
}

/** Authority to UPDATE an Organization's metadata: owner, assigned operator, or an org-admin of that organization. */
export function canUpdateOrganization(facts: AuthGrantFacts, organization: { id: string; platformId: string }, platform: { companyId: string }): AdminAuthority {
  if (facts.kind === 'owner' && facts.companyId === platform.companyId) return 'owner';
  if (facts.kind === 'operator' && facts.platformAssignments.includes(organization.platformId)) return 'operator';
  if (facts.kind === 'member' && facts.organizationAdminMemberships.includes(organization.id)) return 'org_admin';
  return null;
}

/** Authority to UPDATE a Platform's name: owner only (OPEN-3 default: not sensitive, no step-up, ADR-0042 Amendment 1 A.2). */
export function canUpdatePlatform(facts: AuthGrantFacts, platform: { companyId: string }): AdminAuthority {
  return platformAuthority(facts, platform);
}
