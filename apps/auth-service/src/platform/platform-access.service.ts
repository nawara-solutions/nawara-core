import { Inject, Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '../db/db.service.js';

export type AccessReason =
  | 'ALLOW_OWNER'
  | 'ALLOW_OPERATOR'
  | 'DENY_PLATFORM_NOT_FOUND'
  | 'DENY_NOT_MANAGEMENT_IDENTITY'
  | 'DENY_ACCOUNT_INACTIVE'
  | 'DENY_OTHER_COMPANY'
  | 'DENY_NO_ACTIVE_ASSIGNMENT';

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
  constructor(@Inject(DbService) private readonly db: DbService) {}

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

  /** Member tenancy: a member reaches only their own organization. */
  async memberBelongsTo(memberId: string, organizationId: string, q: Queryable = this.db): Promise<boolean> {
    const { rowCount } = await q.query(`SELECT 1 FROM "user" WHERE id=$1 AND kind='member' AND "organizationId"=$2 AND "isActive"`, [memberId, organizationId]);
    return (rowCount ?? 0) > 0;
  }
}
