import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CentralAudit, userActor } from '../audit/central-audit.js';
import { SessionService } from '../auth/session.service.js';
import type { ClientInfo } from '../common/client-info.js';
import { CLOCK, EVENT_BUS, type Clock, type EventBus } from '../common/ports.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { generateInvitationCode, hashInvitationCode, hashInviteeContact, normalizeInvitationCode } from '../crypto/join-code.js';
import { PasswordService, assertPasswordPolicy } from '../crypto/password.js';
import { DbService, isUniqueViolation, type Queryable } from '../db/db.service.js';
import { authError, notFound } from '../errors.js';
import { StepUpService } from '../owner/step-up.service.js';
import { PlatformAccessService } from '../platform/platform-access.service.js';
import { ThrottleService } from '../throttle/throttle.service.js';
import { PHONE_RE, UsersService, normalizeEmail, normalizePhone } from '../users/users.service.js';
import type { OrgActor } from './onboarding.service.js';

/** One generic answer for every reason an invitation cannot be used. */
export const INVITATION_INVALID = 'Invalid or expired invitation.';
const ACCEPT_REFUSED = 'This invitation cannot be accepted.';

export type InvitationRejection = 'malformed' | 'unknown' | 'revoked' | 'consumed' | 'expired' | 'contact_mismatch';

interface InvitationRow {
  id: string;
  organizationId: string;
  platformId: string;
  invitationType: string;
  createdBy: string;
  expiresAt: Date;
  contactBound: boolean;
  organizationName: string;
  platformName: string;
  platformKey: string | null;
}

/**
 * Organization ADMIN INVITATIONS (ADR-0029): controlled, privileged provisioning. A different credential
 * from a join code, on purpose: random (60 bits), single use, revocable, server-expiring, audited, rate
 * limited, and stored only as an HMAC under its own domain label. It is NOT a license, a password or a
 * session; once consumed it is dead and the new administrator uses the normal session machinery, so the
 * invitation's lifetime never becomes a session lifetime.
 *
 * Consuming one creates a `kind=member` with an ACTIVE membership carrying the generic
 * organization-management capability plus an opaque, platform-defined label. What that label MEANS
 * (a platform's "admin", another platform's "manager") is the platform's business, not Auth's.
 */
@Injectable()
export class InvitationService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CentralAudit) private readonly central: CentralAudit,
    @Inject(StepUpService) private readonly stepUp: StepUpService,
    @Inject(PlatformAccessService) private readonly access: PlatformAccessService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  private hash(normalized: string) {
    return hashInvitationCode(this.cfg.secrets.joinCodePepper, normalized);
  }

  /** e-mail or phone -> canonical form -> HMAC (or throws 400). */
  private contactHash(contact: { email?: string; phone?: string }): string {
    if (contact.email) return hashInviteeContact(this.cfg.secrets.joinCodePepper, `email:${normalizeEmail(contact.email)}`);
    const phone = normalizePhone(contact.phone!);
    if (!PHONE_RE.test(phone)) throw authError(400, 'validation_error', 'Invalid phone number.');
    return hashInviteeContact(this.cfg.secrets.joinCodePepper, `phone:${phone}`);
  }

  private async guardGuessing(client: ClientInfo) {
    await this.throttle.hit('invitation_resolve_global', 'all');
    await this.throttle.hit('invitation_resolve_ip', client.ip);
  }

  /** Read-only lookup. The reason is for the audit trail only; callers always answer generically. */
  async lookup(rawCode: string, contactHash?: string, q: Queryable = this.db): Promise<{ row: InvitationRow } | { rejected: InvitationRejection }> {
    const normalized = normalizeInvitationCode(rawCode);
    if (!normalized) return { rejected: 'malformed' };
    const { rows } = await q.query(
      `SELECT i.id, i."organizationId", i."platformId", i."invitationType", i."createdBy", i."expiresAt",
              i."consumedAt", i."revokedAt", i."inviteeContactHash",
              o.name AS "organizationName", p.name AS "platformName", p.key AS "platformKey"
         FROM organization_admin_invitation i
         JOIN organization o ON o.id = i."organizationId"
         JOIN platform p ON p.id = i."platformId"
        WHERE i."codeHash" = $1`,
      [this.hash(normalized)],
    );
    const i = rows[0];
    if (!i) return { rejected: 'unknown' };
    if (i.consumedAt) return { rejected: 'consumed' };
    if (i.revokedAt) return { rejected: 'revoked' };
    if (i.expiresAt <= this.clock.now()) return { rejected: 'expired' };
    if (contactHash !== undefined && i.inviteeContactHash && i.inviteeContactHash !== contactHash) return { rejected: 'contact_mismatch' };
    return { row: { ...i, contactBound: !!i.inviteeContactHash } as InvitationRow };
  }

  /** POST /auth/onboarding/invitations/resolve — safe context; a bad invitation is one generic 404. */
  async resolve(rawCode: string, client: ClientInfo) {
    await this.guardGuessing(client);
    const r = await this.lookup(rawCode);
    if ('rejected' in r) {
      await this.audit.tryRecord({ type: 'onboarding.admin_invitation.resolve_failed', outcome: 'failure', ip: client.ip, metadata: { reason: r.rejected } });
      throw authError(404, 'invitation_invalid', INVITATION_INVALID);
    }
    const i = r.row;
    await this.audit.tryRecord({ type: 'onboarding.admin_invitation.resolved', outcome: 'success', targetId: i.id, ip: client.ip, metadata: { organizationId: i.organizationId } });
    return {
      platform: { id: i.platformId, key: i.platformKey, name: i.platformName },
      organization: { id: i.organizationId, name: i.organizationName },
      invitationType: i.invitationType,
      contactBound: i.contactBound,
      requiresVerification: this.cfg.onboarding.requireContactVerification,
      expiresAt: i.expiresAt,
    };
  }

  /**
   * POST /auth/onboarding/invitations/accept. One transaction: create the member, then consume the
   * invitation with ONE conditional UPDATE (unconsumed, unrevoked, unexpired, binding matches). Two
   * simultaneous accepts of the same invitation: one wins, the other updates zero rows and its user creation
   * rolls back. A contact mismatch is refused BEFORE anything is consumed. No license is asked (ADR-0029): an
   * organization needs a member before it can pay for a license (ADR-0007), so requiring one here would
   * deadlock the first administrator.
   */
  async accept(dto: { invitationCode: string; email?: string; phone?: string; password: string }, client: ClientInfo) {
    await this.throttle.hit('invitation_accept_ip', client.ip);
    await this.guardGuessing(client);
    if (!dto.email && !dto.phone) throw authError(400, 'validation_error', 'Provide an email or a phone number.');
    if (dto.email && dto.phone) throw authError(400, 'validation_error', 'Provide exactly one of email or phone.');
    const email = dto.email ? normalizeEmail(dto.email) : undefined;
    const phone = dto.phone ? normalizePhone(dto.phone) : undefined;
    if (phone && !PHONE_RE.test(phone)) throw authError(400, 'validation_error', 'Invalid phone number.');
    assertPasswordPolicy(dto.password);
    const contactHash = this.contactHash({ email, phone });

    const found = await this.lookup(dto.invitationCode, contactHash);
    if ('rejected' in found) {
      await this.audit.tryRecord({ type: 'onboarding.admin_invitation.resolve_failed', outcome: 'failure', ip: client.ip, metadata: { reason: found.rejected, stage: 'accept' } });
      throw authError(403, 'invitation_not_acceptable', ACCEPT_REFUSED);
    }
    const inv = found.row;
    const normalized = normalizeInvitationCode(dto.invitationCode)!;
    const passwordHash = await this.passwords.hash(dto.password);

    const result = await this.db.tx(async (q) => {
      const user = await this.users.createMember({ email, phone, passwordHash }, q);
      const now = this.clock.now();
      const { rows } = await q.query(
        `UPDATE organization_admin_invitation SET "consumedAt" = $2, "consumedBy" = $3
          WHERE "codeHash" = $1 AND "consumedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt" > $2
            AND ("inviteeContactHash" IS NULL OR "inviteeContactHash" = $4)
        RETURNING id, "organizationId"`,
        [this.hash(normalized), now, user.id, contactHash],
      );
      if (!rows[0]) throw authError(403, 'invitation_not_acceptable', ACCEPT_REFUSED); // lost the race, revoked, or expired meanwhile: rolls the user back
      const membership = await q.query(
        `INSERT INTO organization_membership("userId","organizationId",status,"invitationId",audience,"requestedAt","approvedAt","approvedBy","isOrganizationAdmin","createdAt","updatedAt")
         VALUES ($1,$2,'active',$3,$6,$4,$4,$5,true,$4,$4) RETURNING id, "organizationId"`,
        [user.id, inv.organizationId, inv.id, now, inv.createdBy, inv.invitationType],
      );
      await this.audit.record({
        type: 'onboarding.admin_invitation.consumed', outcome: 'success', actorId: user.id, targetId: inv.id, ip: client.ip,
        metadata: { organizationId: inv.organizationId, invitationType: inv.invitationType },
      }, q);
      // Stage 18.7.6: the central audit intent, same transaction. The actor is the member this acceptance just created (its kind from
      // the row); the organization and the invitation are the consumed invitation's and the new membership's, never a request value.
      await this.central.write(q, {
        action: 'membership.admin_provisioned', actor: userActor({ userId: user.id, kind: user.kind }), organizationId: membership.rows[0].organizationId,
        resource: { type: 'membership', id: membership.rows[0].id }, outcome: 'succeeded', changes: { invitation_id: rows[0].id },
      });
      return { user, tokens: await this.sessions.issue(q, user) };
    });
    const ts = this.clock.now().toISOString();
    this.bus.publish('user.registered', { userId: result.user.id, role: inv.invitationType, organizationId: inv.organizationId, timestamp: ts });
    this.bus.publish('membership.admin_provisioned', { userId: result.user.id, organizationId: inv.organizationId, invitationType: inv.invitationType, timestamp: ts });
    const { sid: _sid, ...tokens } = result.tokens;
    return {
      ...tokens,
      onboarding: {
        invitationType: inv.invitationType, membershipStatus: 'active' as const, isOrganizationAdmin: true,
        contactVerificationRequired: this.cfg.onboarding.requireContactVerification,
      },
    };
  }

  // ------------------------------------------------------------------------- administration
  /** Only an Owner of the organization's company or an existing organization admin. Operators are NOT allowed. */
  private async authorize(q: Queryable, actor: OrgActor, organizationId: string) {
    const authority = await this.access.organizationAuthority(actor.userId, organizationId, q);
    if (authority !== 'owner' && authority !== 'org_admin') throw notFound(); // collapsed 404
    return authority;
  }

  /** The client picks a DURATION; the server validates it and computes the absolute expiry. */
  private minutesFor(requested: number | undefined): number {
    const { minMinutes, defaultMinutes, maxMinutes } = this.cfg.onboarding.invitation;
    const minutes = requested ?? defaultMinutes;
    if (!Number.isInteger(minutes) || minutes < minMinutes || minutes > maxMinutes) {
      throw authError(400, 'validation_error', `expiresInMinutes must be between ${minMinutes} and ${maxMinutes}.`);
    }
    return minutes;
  }

  async create(
    actor: OrgActor, organizationId: string,
    dto: { invitationType: string; expiresInMinutes?: number; inviteeContact?: string },
    stepUpToken: string | undefined, ip: string,
  ) {
    const minutes = this.minutesFor(dto.expiresInMinutes);
    let bound: string | null = null;
    if (dto.inviteeContact) bound = this.contactHash(dto.inviteeContact.includes('@') ? { email: dto.inviteeContact } : { phone: dto.inviteeContact });
    await this.throttle.hit('invitation_manage_actor', actor.userId);
    return this.db.tx(async (q) => {
      const authority = await this.authorize(q, actor, organizationId);
      if (authority === 'owner') {
        await this.stepUp.consume(q, { ownerId: actor.userId, sid: actor.sid, purpose: 'admin_invitation.create', token: stepUpToken });
      }
      const p = await this.access.platformOfOrganization(organizationId, q);
      const code = generateInvitationCode();
      const now = this.clock.now();
      const expiresAt = new Date(now.getTime() + minutes * 60_000);
      try {
        const { rows } = await q.query(
          `INSERT INTO organization_admin_invitation("organizationId","platformId","codeHash","invitationType","inviteeContactHash","expiresAt","createdBy","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, "invitationType", "expiresAt", "createdAt", "organizationId"`,
          [organizationId, p!.platformId, this.hash(code.normalized), dto.invitationType, bound, expiresAt, actor.userId, now],
        );
        const { organizationId: persistedOrganization, ...created } = rows[0];
        await this.audit.record({
          type: 'onboarding.admin_invitation.created', outcome: 'success', actorId: actor.userId, targetId: rows[0].id, sessionFamilyId: actor.sid, ip,
          metadata: { organizationId, invitationType: dto.invitationType, authority, durationMinutes: minutes, contactBound: !!bound },
        }, q);
        await this.central.write(q, {
          action: 'admin_invitation.created', actor: userActor(actor), organizationId: persistedOrganization, resource: { type: 'admin_invitation', id: created.id },
          outcome: 'succeeded', changes: { authority },
        });
        return { ...created, contactBound: !!bound, code: code.display };
      } catch (e) {
        if (isUniqueViolation(e)) throw authError(409, 'conflict', 'Please try again.'); // a 60-bit collision is astronomically unlikely
        throw e;
      }
    });
  }

  async revoke(actor: OrgActor, organizationId: string, invitationId: string, stepUpToken: string | undefined, ip: string): Promise<void> {
    await this.throttle.hit('invitation_manage_actor', actor.userId);
    await this.db.tx(async (q) => {
      const authority = await this.authorize(q, actor, organizationId);
      if (authority === 'owner') {
        await this.stepUp.consume(q, { ownerId: actor.userId, sid: actor.sid, purpose: 'admin_invitation.revoke', token: stepUpToken });
      }
      const { rows } = await q.query(
        `UPDATE organization_admin_invitation SET "revokedAt" = $3, "revokedBy" = $4
          WHERE id = $1 AND "organizationId" = $2 AND "consumedAt" IS NULL AND "revokedAt" IS NULL RETURNING "organizationId"`,
        [invitationId, organizationId, this.clock.now(), actor.userId],
      );
      if (rows.length !== 1) throw notFound(); // nothing to revoke (already consumed/revoked): rolls back, step-up not burned
      await this.audit.record({ type: 'onboarding.admin_invitation.revoked', outcome: 'success', actorId: actor.userId, targetId: invitationId, sessionFamilyId: actor.sid, ip, metadata: { organizationId, authority } }, q);
      await this.central.write(q, {
        action: 'admin_invitation.revoked', actor: userActor(actor), organizationId: rows[0].organizationId, resource: { type: 'admin_invitation', id: invitationId },
        outcome: 'succeeded', changes: { authority },
      });
    });
  }

  /** Metadata and a DERIVED status only; the code cannot be shown again. */
  async list(actor: OrgActor, organizationId: string) {
    await this.authorize(this.db, actor, organizationId);
    const { rows } = await this.db.query(
      `SELECT id, "invitationType", ("inviteeContactHash" IS NOT NULL) AS "contactBound", "expiresAt", "createdBy", "createdAt", "consumedAt", "revokedAt",
              CASE WHEN "consumedAt" IS NOT NULL THEN 'consumed' WHEN "revokedAt" IS NOT NULL THEN 'revoked'
                   WHEN "expiresAt" <= $2 THEN 'expired' ELSE 'active' END AS status
         FROM organization_admin_invitation WHERE "organizationId" = $1 ORDER BY "createdAt" DESC`,
      [organizationId, this.clock.now()],
    );
    return rows;
  }
}
