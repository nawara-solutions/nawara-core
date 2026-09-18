import { BadRequestException, ForbiddenException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { ClientInfo } from '../common/client-info.js';
import { EVENT_BUS, CLOCK, type Clock, type EventBus } from '../common/ports.js';
import { PasswordService, assertPasswordPolicy } from '../crypto/password.js';
import { DbService } from '../db/db.service.js';
import { OwnerAuthService } from '../owner/owner-auth.service.js';
import { PAYMENT_CLIENT, type PaymentClient } from '../payment/payment-client.js';
import { ThrottleService } from '../throttle/throttle.service.js';
import { RefreshTokenService } from '../tokens/refresh-token.service.js';
import { UsersService, normalizeEmail, normalizePhone, PHONE_RE, toIdentifier } from '../users/users.service.js';
import { SessionService } from './session.service.js';

const INVALID_CREDENTIALS = 'Invalid credentials.';
const NO_LICENSE = 'Your organization does not have a valid license. Please contact your organization.';
const ROLE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

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
    @Inject(PAYMENT_CLIENT) private readonly payment: PaymentClient,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Member self-registration. Always creates kind=member (no request can create an owner/operator);
   * `admin` is a reserved role value. The organization must exist in this database AND payment-service
   * must confirm a valid license (fail closed). Both failures return the same generic 403 so
   * organization existence is not revealed. This is the ONLY entitlement question auth ever asks.
   */
  async register(dto: { email?: string; phone?: string; password: string; role: string; organizationId: string }, client: ClientInfo) {
    await this.throttle.hit('register_ip', client.ip);
    if (!dto.email && !dto.phone) throw new BadRequestException('Provide an email or a phone number.');
    const role = dto.role.trim().toLowerCase();
    if (role === 'admin' || !ROLE_RE.test(role)) throw new BadRequestException('Invalid role.');
    const email = dto.email ? normalizeEmail(dto.email) : undefined;
    const phone = dto.phone ? normalizePhone(dto.phone) : undefined;
    if (phone && !PHONE_RE.test(phone)) throw new BadRequestException('Invalid phone number.');
    assertPasswordPolicy(dto.password);

    const { rowCount } = await this.db.query(`SELECT 1 FROM organization WHERE id=$1`, [dto.organizationId]);
    if (!rowCount) throw new ForbiddenException(NO_LICENSE);
    let licensed: boolean;
    try {
      licensed = await this.payment.isOrganizationLicensed(dto.organizationId);
    } catch {
      throw new ServiceUnavailableException(); // fail CLOSED whatever the client implementation throws
    }
    if (!licensed) throw new ForbiddenException(NO_LICENSE);

    const passwordHash = await this.passwords.hash(dto.password);
    const session = await this.db.tx(async (q) => {
      const user = await this.users.createMember({ email, phone, passwordHash, role, organizationId: dto.organizationId }, q);
      this.bus.publish('user.registered', { userId: user.id, role, organizationId: dto.organizationId, timestamp: this.clock.now().toISOString() });
      return { user, tokens: await this.sessions.issue(q, user) };
    });
    const { sid: _sid, ...tokens } = session.tokens;
    return tokens;
  }

  /**
   * Password login. Members get tokens. An owner NEVER gets tokens from a password alone: they get a
   * second-factor (or first-enrollment) challenge. Operators have no password and cannot log in here.
   * There is NO payment-service call (ADR-0026). Every failure is the same generic 401.
   */
  async login(dto: { email?: string; phone?: string; password: string }, client: ClientInfo) {
    const id = toIdentifier(dto);
    await this.throttle.hit('login_ip', client.ip);
    await this.throttle.hit('login_identifier', 'email' in id ? id.email : id.phone);
    const user = await this.users.findByIdentifier(dto);
    const passwordOk = await this.passwords.verify(user?.passwordHash, dto.password);
    if (!user || !passwordOk || !user.isActive) {
      await this.audit.tryRecord({ type: 'auth.login', outcome: 'failure', ip: client.ip, actorId: user?.id });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    if (user.kind === 'owner') {
      await this.audit.tryRecord({ type: 'owner.login.password', outcome: 'success', actorId: user.id, ip: client.ip });
      return this.ownerAuth.beginLogin(user);
    }
    if (user.kind !== 'member') throw new UnauthorizedException(INVALID_CREDENTIALS);
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
        throw new UnauthorizedException({ reason: 'session_ceiling_reached', message: 'Your session has ended. Please request a new login code to continue.' });
      }
      throw new UnauthorizedException('Invalid refresh token.');
    }
    const user = await this.users.findById(r.userId);
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid refresh token.');
    const { accessToken, expiresIn } = await this.sessions.access(user, r.familyId, r.sessionExpiresAt);
    return { accessToken, refreshToken: r.raw, expiresIn };
  }

  async logout(userId: string, rawToken: string) {
    await this.refresh.revokeByRaw(rawToken, userId);
  }

  async me(userId: string) {
    const u = await this.users.findById(userId);
    return { id: u!.id, email: u!.email, phone: u!.phone, role: u!.role, organizationId: u!.organizationId, adminTier: u!.kind === 'member' ? null : u!.kind, isActive: u!.isActive };
  }
}
