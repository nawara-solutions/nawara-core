import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DbService, type Queryable } from '../db/db.service.js';

export type AccessReason =
  | 'ALLOW_OWNER'
  | 'ALLOW_OPERATOR'
  | 'DENY_PLATFORM_NOT_FOUND'
  | 'DENY_NOT_MANAGEMENT_IDENTITY'
  | 'DENY_ACCOUNT_INACTIVE'
  | 'DENY_OTHER_COMPANY'
  | 'DENY_NO_ACTIVE_ASSIGNMENT';

/** Why a caller may administer an organization (join codes, membership decisions). */
export type OrganizationAuthority = 'owner' | 'operator' | 'org_admin';

export const isAllowed = (r: AccessReason) => r === 'ALLOW_OWNER' || r === 'ALLOW_OPERATOR';

/**
 * THE authorization decision for management identities. Always evaluated against CURRENT database
 * state — never from a token claim — so revoking a PlatformAssignment (or blocking an account) takes
 * effect on the very next request, even if the caller still holds an unexpired access token.
 *
 *   owner    : ALLOW iff Owner.companyId = Platform.companyId          (no PlatformAssignment)
 *   operator : ALLOW iff active account AND an ACTIVE PlatformAssignment(operator, platform) exists
 *              (the composite FKs already guarantee it is in the operator's own company)
 *   member   : never (members are scoped by Organization, not by this check)
 *
 * The platform is passed in by the caller, which MUST have derived it server-side from the requested
 * resource (resource -> organization -> platform), never from a client-supplied id it trusts.
 * Reasons are distinct here for logging and collapse to one external answer.
 */
@Injectable()
export class PlatformAccessService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async check(actorId: string, platformId: string, q: Queryable = this.db): Promise<AccessReason> {
    const { rows } = await q.query<{ reason: AccessReason }>(
      `SELECT CASE
         WHEN p.id IS NULL                      THEN 'DENY_PLATFORM_NOT_FOUND'
         WHEN u.id IS NULL OR u.kind = 'member' THEN 'DENY_NOT_MANAGEMENT_IDENTITY'
         WHEN NOT u."isActive"                  THEN 'DENY_ACCOUNT_INACTIVE'
         WHEN u.kind = 'owner'                  THEN CASE WHEN o."companyId" = p."companyId" THEN 'ALLOW_OWNER' ELSE 'DENY_OTHER_COMPANY' END
         WHEN a.id IS NOT NULL                  THEN 'ALLOW_OPERATOR'
         ELSE 'DENY_NO_ACTIVE_ASSIGNMENT'
       END AS reason
       FROM (SELECT $2::uuid AS pid) req
       LEFT JOIN platform p ON p.id = req.pid
       LEFT JOIN "user" u ON u.id = $1::uuid
       LEFT JOIN owner o ON o."userId" = u.id
       LEFT JOIN platform_assignment a ON a."operatorId" = u.id AND a."platformId" = p.id AND a.active`,
      [actorId, platformId],
    );
    return rows[0].reason;
  }

  /** resource's organization -> its platform (the only way a platform is ever derived). */
  async platformOfOrganization(organizationId: string, q: Queryable = this.db): Promise<{ platformId: string; companyId: string } | null> {
    const { rows } = await q.query(
      `SELECT o."platformId", p."companyId" FROM organization o JOIN platform p ON p.id = o."platformId" WHERE o.id = $1`,
      [organizationId],
    );
    return rows[0] ?? null;
  }

  /**
   * Member tenancy: a member reaches only their own organization, and only through an ACTIVE membership.
   * `pending` and `rejected` are authenticated-but-not-admitted: the account is valid ("isActive") yet the
   * organization has not accepted the person. Decided from current rows on every call, never from a token
   * claim. When contact verification is enforced, an unverified contact is also not admitted.
   */
  async memberBelongsTo(memberId: string, organizationId: string, q: Queryable = this.db): Promise<boolean> {
    const { rowCount } = await q.query(
      `SELECT 1 FROM "user" u
         JOIN organization_membership m ON m."userId" = u.id AND m."organizationId" = u."organizationId"
        WHERE u.id = $1 AND u.kind = 'member' AND u."isActive" AND u."organizationId" = $2 AND m.status = 'active'
          AND ($3::boolean = false OR u."contactVerifiedAt" IS NOT NULL)`,
      [memberId, organizationId, this.cfg.onboarding.requireContactVerification],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * THE authorization decision for organization administration (ADR-0028), from CURRENT state:
   *   owner     : the organization's platform is in the owner's company
   *   operator  : an ACTIVE PlatformAssignment on the organization's platform (existing check())
   *   org_admin : an ACTIVE membership of THIS organization with isOrganizationAdmin
   * The organization is the resource in the URL; the platform and company are derived from it, never
   * accepted from the client. `null` collapses "no such organization", "not yours" and "not allowed".
   */
  async organizationAuthority(actorId: string, organizationId: string, q: Queryable = this.db): Promise<OrganizationAuthority | null> {
    const p = await this.platformOfOrganization(organizationId, q);
    if (!p) return null;
    const reason = await this.check(actorId, p.platformId, q);
    if (reason === 'ALLOW_OWNER') return 'owner';
    if (reason === 'ALLOW_OPERATOR') return 'operator';
    const { rowCount } = await q.query(
      `SELECT 1 FROM "user" u
         JOIN organization_membership m ON m."userId" = u.id AND m."organizationId" = u."organizationId"
        WHERE u.id = $1 AND u.kind = 'member' AND u."isActive" AND u."organizationId" = $2
          AND m.status = 'active' AND m."isOrganizationAdmin"
          AND ($3::boolean = false OR u."contactVerifiedAt" IS NOT NULL)`,
      [actorId, organizationId, this.cfg.onboarding.requireContactVerification],
    );
    return rowCount ? 'org_admin' : null;
  }
}
