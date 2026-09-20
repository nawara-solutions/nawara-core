import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { DbService } from '../db/db.service.js';

export interface GrantFacts {
  userId: string;
  kind: 'member' | 'owner' | 'operator';
  /** Owner only: the Company this owner belongs to. Never present for member/operator. */
  companyId: string | null;
  /** Operator only: platformIds of this operator's currently ACTIVE PlatformAssignment rows. Empty otherwise. */
  platformAssignments: string[];
  /** Member only: organizationIds where this member holds an ACTIVE, admin-flagged membership. Empty otherwise. */
  organizationAdminMemberships: string[];
}

/**
 * ADR-0042 decision 6 / Amendment 1 A.2: the server-derived authorization facts Organization Service
 * needs to evaluate human administrative authority. Deliberately narrow — NOT a generic user-profile
 * or identity API: it exposes only the three facts an authority evaluator needs (Company ownership,
 * active operator->Platform assignments, active organization-admin memberships), never credentials,
 * tokens, or any other User field. Read from CURRENT database state, same discipline as every other
 * authorization check in this service (platform-access.service.ts) — never cached, never a token claim.
 */
@Injectable()
export class GrantsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async forUser(userId: string): Promise<GrantFacts> {
    const { rows } = await this.db.query<{ id: string; kind: GrantFacts['kind']; companyId: string | null }>(
      `SELECT u.id, u.kind, o."companyId"
         FROM "user" u
         LEFT JOIN owner o ON o."userId" = u.id
        WHERE u.id = $1 AND u."isActive"`,
      [userId],
    );
    const u = rows[0];
    // Defense in depth only: AuthGuard already rejects an unknown or inactive caller before this
    // service ever runs. Fail closed rather than fabricate an empty-grants shape for a bad id.
    if (!u) throw new UnauthorizedException();

    let platformAssignments: string[] = [];
    if (u.kind === 'operator') {
      const { rows: a } = await this.db.query<{ platformId: string }>(
        `SELECT "platformId" FROM platform_assignment WHERE "operatorId" = $1 AND active`,
        [userId],
      );
      platformAssignments = a.map((r) => r.platformId);
    }

    let organizationAdminMemberships: string[] = [];
    if (u.kind === 'member') {
      const { rows: m } = await this.db.query<{ organizationId: string }>(
        `SELECT "organizationId" FROM organization_membership WHERE "userId" = $1 AND status = 'active' AND "isOrganizationAdmin"`,
        [userId],
      );
      organizationAdminMemberships = m.map((r) => r.organizationId);
    }

    return { userId: u.id, kind: u.kind, companyId: u.kind === 'owner' ? u.companyId : null, platformAssignments, organizationAdminMemberships };
  }
}
