import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, EVENT_BUS, type Clock, type EventBus } from '../common/ports.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { StepUpService } from '../owner/step-up.service.js';
import { PlatformAccessService } from '../platform/platform-access.service.js';
import { ThrottleService } from '../throttle/throttle.service.js';
import type { OrgActor } from '../onboarding/onboarding.service.js';

export type MembershipStatus = 'pending' | 'active' | 'rejected';

/**
 * Organization membership (ADR-0028): the relationship between a member and their organization, kept
 * SEPARATE from "user"."isActive". `isActive = true` + `status = pending` means "a valid account the
 * organization has not accepted yet".
 *
 * The state machine is enforced twice: here (conditional UPDATEs) and by the database trigger
 * membership_guard(), which only allows pending -> active | rejected.
 *
 *   approve / reject : authorized against the membership's OWN organization (derived from the row,
 *                      never from the request), decided in one transaction with a row lock plus a
 *                      conditional UPDATE, so two simultaneous decisions leave exactly one winner and a
 *                      clean 409 for the loser.
 */
@Injectable()
export class MembershipService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StepUpService) private readonly stepUp: StepUpService,
    @Inject(PlatformAccessService) private readonly access: PlatformAccessService,
  ) {}

  /** Called by registration inside ITS transaction. `pending` needs an organization decision. */
  async createForRegistration(
    q: Queryable, a: { userId: string; organizationId: string; joinCodeId: string; requiresApproval: boolean },
  ): Promise<MembershipStatus> {
    const now = this.clock.now();
    const status: MembershipStatus = a.requiresApproval ? 'pending' : 'active';
    await q.query(
      `INSERT INTO organization_membership("userId","organizationId",status,"joinCodeId","requestedAt","approvedAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$5,$5)`,
      [a.userId, a.organizationId, status, a.joinCodeId, now, status === 'active' ? now : null],
    );
    return status;
  }

  /** The caller's own membership, for "your request is waiting for approval" screens. */
  async mine(userId: string) {
    const { rows } = await this.db.query(
      `SELECT m."organizationId", m.status, m."isOrganizationAdmin", (u."contactVerifiedAt" IS NOT NULL) AS "contactVerified"
         FROM "user" u LEFT JOIN organization_membership m ON m."userId" = u.id AND m."organizationId" = u."organizationId"
        WHERE u.id = $1`,
      [userId],
    );
    const r = rows[0];
    if (!r || !r.status) return null;
    return {
      organizationId: r.organizationId as string,
      status: r.status as MembershipStatus,
      isOrganizationAdmin: r.isOrganizationAdmin as boolean,
      contactVerified: r.contactVerified as boolean,
      contactVerificationRequired: this.cfg.onboarding.requireContactVerification,
    };
  }

  private async authorize(q: Queryable, actor: OrgActor, organizationId: string) {
    const authority = await this.access.organizationAuthority(actor.userId, organizationId, q);
    if (!authority) throw new NotFoundException(); // collapsed 404
    return authority;
  }

  async listByStatus(actor: OrgActor, organizationId: string, status: MembershipStatus) {
    await this.authorize(this.db, actor, organizationId);
    const { rows } = await this.db.query(
      `SELECT m.id, m."userId", m.status, m."requestedAt", m."approvedAt", m."rejectedAt", m."isOrganizationAdmin",
              u.email, u.phone, u.role AS audience, (u."contactVerifiedAt" IS NOT NULL) AS "contactVerified"
         FROM organization_membership m JOIN "user" u ON u.id = m."userId"
        WHERE m."organizationId" = $1 AND m.status = $2 ORDER BY m."requestedAt"`,
      [organizationId, status],
    );
    return rows;
  }

  /** pending -> active | rejected, atomically. */
  async decide(actor: OrgActor, organizationId: string, membershipId: string, decision: 'approve' | 'reject', ip: string) {
    await this.throttle.hit('membership_op_actor', actor.userId);
    const outcome = await this.db.tx(async (q) => {
      // Lock the row first: a concurrent decision on the same membership queues behind us and then finds it resolved.
      const { rows } = await q.query(
        `SELECT m.id, m."userId", m."organizationId", m.status, u.email, u.phone, u."contactVerifiedAt"
           FROM organization_membership m JOIN "user" u ON u.id = m."userId"
          WHERE m.id = $1 AND m."organizationId" = $2 FOR UPDATE OF m`,
        [membershipId, organizationId],
      );
      const m = rows[0];
      // The organization is checked from the ROW, and must equal the one in the URL: an id from another
      // organization is indistinguishable from a missing one.
      if (!m) throw new NotFoundException();
      const authority = await this.authorize(q, actor, m.organizationId);
      if (m.userId === actor.userId) throw new NotFoundException(); // nobody decides their own membership
      if (m.status !== 'pending') throw new ConflictException('This request has already been decided.');
      if (decision === 'approve' && this.cfg.onboarding.requireContactVerification && !m.contactVerifiedAt) {
        throw new ConflictException('The applicant has not verified their contact yet.');
      }
      const now = this.clock.now();
      const { rowCount } = await q.query(
        decision === 'approve'
          ? `UPDATE organization_membership SET status='active', "approvedAt"=$3, "approvedBy"=$4, "updatedAt"=$3
              WHERE id=$1 AND "organizationId"=$2 AND status='pending'`
          : `UPDATE organization_membership SET status='rejected', "rejectedAt"=$3, "rejectedBy"=$4, "updatedAt"=$3
              WHERE id=$1 AND "organizationId"=$2 AND status='pending'`,
        [membershipId, m.organizationId, now, actor.userId],
      );
      if (rowCount !== 1) throw new ConflictException('This request has already been decided.');
      await this.audit.record({
        type: decision === 'approve' ? 'membership.approved' : 'membership.rejected', outcome: 'success',
        actorId: actor.userId, targetId: m.userId, sessionFamilyId: actor.sid, ip, metadata: { organizationId: m.organizationId, authority },
      }, q);
      return { userId: m.userId as string, email: m.email as string | null, phone: m.phone as string | null };
    });
    // Event after commit; nothing delivers it until notification-service and a broker exist (ADR-0028).
    this.bus.publish(decision === 'approve' ? 'membership.approved' : 'membership.rejected', {
      userId: outcome.userId, organizationId, channel: outcome.email ? 'email' : 'phone', destination: outcome.email ?? outcome.phone,
      timestamp: this.clock.now().toISOString(),
    });
    return { id: membershipId, status: decision === 'approve' ? 'active' : 'rejected' };
  }

  /** Owner-only, with step-up: minting an organization administrator is a privilege grant. */
  async setAdmin(actor: OrgActor, organizationId: string, membershipId: string, admin: boolean, stepUpToken: string | undefined, ip: string) {
    await this.throttle.hit('membership_op_actor', actor.userId);
    await this.db.tx(async (q) => {
      const authority = await this.authorize(q, actor, organizationId);
      if (authority !== 'owner') throw new NotFoundException(); // operators and org admins cannot mint admins
      await this.stepUp.consume(q, {
        ownerId: actor.userId, sid: actor.sid, purpose: admin ? 'organization.admin.grant' : 'organization.admin.revoke', token: stepUpToken,
      });
      const { rows } = await q.query(
        `UPDATE organization_membership SET "isOrganizationAdmin"=$3, "updatedAt"=$4
          WHERE id=$1 AND "organizationId"=$2 AND status='active' AND "isOrganizationAdmin" <> $3 RETURNING "userId"`,
        [membershipId, organizationId, admin, this.clock.now()],
      );
      if (!rows[0]) throw new NotFoundException(); // rolls back: the step-up is not burned
      await this.audit.record({
        type: admin ? 'organization.admin.granted' : 'organization.admin.revoked', outcome: 'success',
        actorId: actor.userId, targetId: rows[0].userId, sessionFamilyId: actor.sid, ip, metadata: { organizationId },
      }, q);
    });
  }
}
