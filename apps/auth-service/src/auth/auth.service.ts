import { HttpException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { ClientInfo } from '../common/client-info.js';
import { DOMAIN_EVENTS, CLOCK, type Clock, type DomainEvents } from '../common/ports.js';
import { PasswordService, assertPasswordPolicy } from '../crypto/password.js';
import { DbService, isUniqueViolation } from '../db/db.service.js';
import { authError } from '../errors.js';
import { MembershipService } from '../membership/membership.service.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';
import { OwnerAuthService } from '../owner/owner-auth.service.js';
import { ThrottleService } from '../throttle/throttle.service.js';
import { RefreshTokenService } from '../tokens/refresh-token.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { UsersService, normalizeEmail, normalizePhone, PHONE_RE, toIdentifier } from '../users/users.service.js';
import { SessionService } from './session.service.js';

const INVALID_CREDENTIALS = 'Invalid credentials.';
/** One answer for a bad, expired, revoked or exhausted code, so none of those reasons is revealed. */
const REGISTRATION_REFUSED = 'Registration is not available with this code. Please contact your organization.';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(RefreshTokenService) private readonly refresh: RefreshTokenService,
    @Inject(OwnerAuthService) private readonly ownerAuth: OwnerAuthService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DOMAIN_EVENTS) private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
    @Inject(MembershipService) private readonly memberships: MembershipService,
  ) {}

  /**
   * Member registration through an ORGANIZATION JOIN CODE (ADR-0028). The client supplies the code and
   * its own credentials, nothing else: organization, platform, audience and the approval/subscription
   * flags are resolved server-side from the code and can be neither chosen nor changed by the caller
   * (unknown body properties are rejected by the validation pipe).
   *
   * One transaction: spend one use of the code (atomic, so maxUses holds under concurrency), create the
   * user (always kind=member, no organization and no business role on it), create the membership (which carries the
   * opaque audience label) (`pending` when
   * the code requires approval, else `active`). A pending member is authenticated but NOT admitted.
   * Registration has no commercial dependency: identity and membership creation never check subscription,
   * license or entitlement state (Stage 11/12 decoupling). A bad, expired, revoked or exhausted code is the
   * only reason registration is refused here.
   */
  async register(dto: { email?: string; phone?: string; password: string; joinCode: string }, client: ClientInfo) {
    await this.throttle.hit('register_ip', client.ip);
    await this.onboarding.guardGuessing(client);
    if (!dto.email && !dto.phone) throw authError(400, 'validation_error', 'Provide an email or a phone number.');
    const email = dto.email ? normalizeEmail(dto.email) : undefined;
    const phone = dto.phone ? normalizePhone(dto.phone) : undefined;
    if (phone && !PHONE_RE.test(phone)) throw authError(400, 'validation_error', 'Invalid phone number.');
    assertPasswordPolicy(dto.password);

    const found = await this.onboarding.lookup(dto.joinCode);
    if ('rejected' in found) {
      await this.audit.tryRecord({ type: 'onboarding.join_code.resolve_failed', outcome: 'failure', ip: client.ip, metadata: { reason: found.rejected, stage: 'register' } });
      throw authError(403, 'registration_refused', REGISTRATION_REFUSED);
    }

    const passwordHash = await this.passwords.hash(dto.password);
    const result = await this.db.tx(async (q) => {
      const code = await this.onboarding.redeem(q, dto.joinCode); // atomic; refuses a code that just ran out or was revoked
      const user = await this.users.createMember({ email, phone, passwordHash }, q);
      const status = await this.memberships.createForRegistration(q, { userId: user.id, organizationId: code.organizationId, joinCodeId: code.id, audience: code.audience, requiresApproval: code.requiresApproval });
      await this.audit.record({ type: 'onboarding.join_code.used', outcome: 'success', actorId: user.id, targetId: code.id, ip: client.ip, metadata: { organizationId: code.organizationId, audience: code.audience } }, q);
      if (status === 'pending') {
        await this.audit.record({ type: 'membership.requested', outcome: 'success', actorId: user.id, targetId: user.id, ip: client.ip, metadata: { organizationId: code.organizationId, audience: code.audience } }, q);
      }
      // Stage 21.C.2 (ADR-0052 decision 4): the domain events in the SAME transaction (outbox), relayed after the commit.
      const now = this.clock.now().toISOString();
      await this.events.emit(q, 'user.registered', { userId: user.id, role: code.audience, organizationId: code.organizationId, timestamp: now });
      if (status === 'pending') await this.events.emit(q, 'membership.requested', { userId: user.id, organizationId: code.organizationId, audience: code.audience, timestamp: now });
      return { user, code, status, tokens: await this.sessions.issue(q, user) };
    });
    const { sid: _sid, ...tokens } = result.tokens;
    return {
      ...tokens,
      onboarding: {
        audience: result.code.audience,
        membershipStatus: result.status,
        requiresSubscription: result.code.requiresSubscription,
        contactVerificationRequired: this.cfg.onboarding.requireContactVerification,
      },
    };
  }

  /**
   * An EXISTING member joins another organization with a join code (one identity, many organizations, possibly on
   * different platforms). Same rules as registration: the code is re-resolved server-side, one use is spent
   * atomically, and the membership is `pending` or `active` per the code. No commercial check runs here either
   * (Stage 11/12 decoupling). It creates NO account and changes nothing about the user's other memberships or
   * sessions. A second membership in the SAME organization is refused (409) and spends no use of the code.
   */
  async join(userId: string, dto: { joinCode: string }, client: ClientInfo) {
    await this.throttle.hit('membership_join_user', userId);
    await this.onboarding.guardGuessing(client);
    const found = await this.onboarding.lookup(dto.joinCode);
    if ('rejected' in found) {
      await this.audit.tryRecord({ type: 'onboarding.join_code.resolve_failed', outcome: 'failure', actorId: userId, ip: client.ip, metadata: { reason: found.rejected, stage: 'join' } });
      throw authError(403, 'registration_refused', REGISTRATION_REFUSED);
    }

    const result = await this.db.tx(async (q) => {
      const code = await this.onboarding.redeem(q, dto.joinCode);
      let status;
      try {
        status = await this.memberships.createForRegistration(q, { userId, organizationId: code.organizationId, joinCodeId: code.id, audience: code.audience, requiresApproval: code.requiresApproval });
      } catch (e) {
        if (isUniqueViolation(e, 'membership_user_org_uk')) throw authError(409, 'membership_conflict', 'You already have a membership in this organization.'); // rolls the spent use back
        throw e;
      }
      await this.audit.record({ type: 'onboarding.join_code.used', outcome: 'success', actorId: userId, targetId: code.id, ip: client.ip, metadata: { organizationId: code.organizationId, audience: code.audience, existingAccount: true } }, q);
      if (status === 'pending') {
        await this.audit.record({ type: 'membership.requested', outcome: 'success', actorId: userId, targetId: userId, ip: client.ip, metadata: { organizationId: code.organizationId, audience: code.audience } }, q);
      }
      if (status === 'pending') {
        await this.events.emit(q, 'membership.requested', { userId, organizationId: code.organizationId, audience: code.audience, timestamp: this.clock.now().toISOString() });
      }
      return { code, status };
    });
    return {
      onboarding: {
        audience: result.code.audience,
        membershipStatus: result.status,
        requiresSubscription: result.code.requiresSubscription,
        contactVerificationRequired: this.cfg.onboarding.requireContactVerification,
      },
      organizationId: result.code.organizationId,
    };
  }

  /**
   * Password login. Members get tokens. An owner NEVER gets tokens from a password alone: they get a
   * second-factor (or first-enrollment) challenge. Operators have no password and cannot log in here.
   * No commercial check runs here (ADR-0026; Stage 11/12 decoupling). Every failure is the same generic 401.
   */
  async login(dto: { email?: string; phone?: string; password: string }, client: ClientInfo) {
    const id = toIdentifier(dto);
    await this.throttle.hit('login_ip', client.ip);
    await this.throttle.hit('login_identifier', 'email' in id ? id.email : id.phone);
    const user = await this.users.findByIdentifier(dto);
    const passwordOk = await this.passwords.verify(user?.passwordHash, dto.password);
    if (!user || !passwordOk || !user.isActive) {
      await this.audit.tryRecord({ type: 'auth.login', outcome: 'failure', ip: client.ip, actorId: user?.id });
      throw authError(401, 'invalid_credentials', INVALID_CREDENTIALS);
    }
    if (user.kind === 'owner') {
      await this.audit.tryRecord({ type: 'owner.login.password', outcome: 'success', actorId: user.id, ip: client.ip });
      return this.ownerAuth.beginLogin(user);
    }
    if (user.kind !== 'member') throw authError(401, 'invalid_credentials', INVALID_CREDENTIALS);
    await this.throttle.reset('login_identifier', 'email' in id ? id.email : id.phone);
    const s = await this.db.tx(async (q) => {
      const t = await this.sessions.issue(q, user);
      await this.audit.record({ type: 'auth.login', outcome: 'success', actorId: user.id, sessionFamilyId: t.sid, ip: client.ip }, q);
      return t;
    });
    const { sid: _sid, ...tokens } = s;
    return tokens;
  }

  async refreshSession(rawToken: string, client: ClientInfo) {
    await this.throttle.hit('refresh_ip', client.ip);
    const r = await this.refresh.rotate(rawToken, client.ip);
    if (!r.ok) {
      if (r.reason === 'session_ceiling_reached') {
        throw new HttpException(
          { reason: 'session_ceiling_reached', message: 'Your session has ended. Please request a new login code to continue.', code: 'session_ceiling_reached' },
          401,
        );
      }
      throw authError(401, 'invalid_refresh_token', 'Invalid refresh token.');
    }
    const user = await this.users.findById(r.userId);
    if (!user || !user.isActive) throw authError(401, 'invalid_refresh_token', 'Invalid refresh token.');
    const { accessToken, expiresIn } = await this.sessions.access(user, r.familyId, r.sessionExpiresAt);
    return { accessToken, refreshToken: r.raw, expiresIn };
  }

  async logout(userId: string, rawToken: string) {
    await this.refresh.revokeByRaw(rawToken, userId);
  }

  async me(userId: string) {
    const u = await this.users.findById(userId);
    const { rows } = await this.db.query(`SELECT ("contactVerifiedAt" IS NOT NULL) AS "contactVerified" FROM "user" WHERE id = $1`, [userId]);
    return {
      id: u!.id, email: u!.email, phone: u!.phone,
      adminTier: u!.kind === 'member' ? null : u!.kind, isActive: u!.isActive,
      contactVerified: rows[0].contactVerified as boolean,
      contactVerificationRequired: this.cfg.onboarding.requireContactVerification,
      // Members: EVERY organization relationship (a user can have many). Never a token claim, always current rows.
      // The platform-specific business role is the platform's concern; `audience` is only the opaque onboarding label.
      memberships: u!.kind === 'member' ? await this.memberships.list(userId) : [],
    };
  }
}
