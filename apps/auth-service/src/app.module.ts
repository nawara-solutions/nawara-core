import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HealthModule as KitHealthModule, type EventBus } from '@nawara/service-kit';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuditService } from './audit/audit.service.js';
import { AuditRelayModule } from './audit/central-audit.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { GrantsService } from './auth/grants.service.js';
import { SessionService } from './auth/session.service.js';
import { CLOCK, DOMAIN_EVENTS, SystemClock } from './common/ports.js';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';
import { PasswordService } from './crypto/password.js';
import { TotpSecretCipher } from './crypto/totp-cipher.js';
import { CodeEventPurge } from './events/code-event-purge.js';
import { HierarchyReference, ORGANIZATION_DIRECTORY, OrganizationDirectoryClient } from './hierarchy/hierarchy-reference.js';
import { OutboxDomainEvents } from './events/domain-events.js';
import { HealthController } from './health/health.controller.js';
import { MemberSecurityController } from './members/member-security.controller.js';
import { MemberSecurityCounters, MemberSecurityReporter } from './members/member-security.counters.js';
import { MemberSecurityService } from './members/member-security.service.js';
import { OrganizationController } from './membership/organization.controller.js';
import { MembershipService } from './membership/membership.service.js';
import { ContactVerificationService } from './onboarding/contact-verification.service.js';
import { InvitationService } from './onboarding/invitation.service.js';
import { OnboardingController } from './onboarding/onboarding.controller.js';
import { OnboardingService } from './onboarding/onboarding.service.js';
import { OperatorAvailabilityService } from './operator/availability.service.js';
import { OperatorAdminService } from './operator/operator-admin.service.js';
import { OperatorCodeService } from './operator/operator-code.service.js';
import { OperatorController } from './operator/operator.controller.js';
import { AdminDeviceService } from './owner/admin-device.service.js';
import { ChallengeService } from './owner/challenge.service.js';
import { EnrollmentService } from './owner/enrollment.service.js';
import { FactorService } from './owner/factor.service.js';
import { OwnerAuthService } from './owner/owner-auth.service.js';
import { OwnerController } from './owner/owner.controller.js';
import { RecoveryService } from './owner/recovery.service.js';
import { SecretKeyService } from './owner/secret-key.service.js';
import { StepUpService } from './owner/step-up.service.js';
import { WebAuthnService } from './owner/webauthn.service.js';
import { AssignmentService } from './platform/assignment.service.js';
import { PlatformAccessService } from './platform/platform-access.service.js';
import { PlatformController } from './platform/platform.controller.js';
import { ThrottleService } from './throttle/throttle.service.js';
import { RefreshTokenService } from './tokens/refresh-token.service.js';
import { TokenService } from './tokens/token.service.js';
import { UsersService } from './users/users.service.js';

/**
 * The whole module graph, built from the ALREADY-VALIDATED configuration (`loadConfig`): `main.ts`, the CLI and the test
 * suites all go through `AppModule.register(cfg)`, so no module reads `process.env` on its own.
 */
@Module({
  controllers: [AppController, HealthController, AuthController, OnboardingController, OrganizationController, OwnerController, OperatorController, PlatformController, MemberSecurityController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: CLOCK, useClass: SystemClock },
    // Stage 21.C.2 (ADR-0052 decision 4): domain events through Auth's transactional outbox (the one kit relay publishes them).
    { provide: DOMAIN_EVENTS, useClass: OutboxDomainEvents },
    // Stage 21.C.2 (ADR-0040 decision 1): the reference-cache protocol and Auth's own Organization Service client (absent: no credential).
    { provide: ORGANIZATION_DIRECTORY, useFactory: (c: AppConfig) => (c.hierarchy.client ? new OrganizationDirectoryClient(c.hierarchy.client) : null), inject: [APP_CONFIG] },
    HierarchyReference,
    { provide: PasswordService, useFactory: (c: AppConfig) => new PasswordService(c.bcryptCost), inject: [APP_CONFIG] },
    { provide: TotpSecretCipher, useFactory: (c: AppConfig) => new TotpSecretCipher(c.secrets.totpKeys, c.secrets.totpActiveKeyId), inject: [APP_CONFIG] },
    AuditService, ThrottleService, UsersService, TokenService, RefreshTokenService, SessionService,
    ChallengeService, WebAuthnService, FactorService, SecretKeyService, AdminDeviceService, StepUpService,
    OwnerAuthService, EnrollmentService, RecoveryService,
    OperatorAvailabilityService, OperatorCodeService, OperatorAdminService, MemberSecurityService, MemberSecurityCounters,
    PlatformAccessService, AssignmentService, OnboardingService, ContactVerificationService, InvitationService, MembershipService, AuthService, GrantsService, AuthGuard,
  ],
})
export class AppModule {
  /**
   * `auditBus`: TEST FIXTURES ONLY, the bus the audit relay publishes to (production builds it from RABBITMQ_URL). `auditRelay: false`: the
   * operator CLI, which writes to the outbox (if ever) but never runs a relay or connects to the broker.
   */
  static register(cfg: AppConfig, auditBus?: EventBus, opts: { auditRelay?: boolean } = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // Coarse per-IP baseline for every route. The security-relevant limits are the bucketed,
        // DB-backed ones in ThrottleService (per identifier / per operator / global), not this.
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: cfg.baselineRateLimitPerMinute }]),
        // Adds root GET /health (pure liveness) and GET /ready (ReadinessRegistry, DB check registered by
        // DbService below) alongside Auth's own existing GET /auth/health, which is unchanged and stays the
        // route production deploy tooling and Compose already poll (Stage 13.2: additive, not a replacement).
        KitHealthModule.forRoot({ checkTimeoutMs: 1500, httpDrainTimeoutMs: cfg.httpDrainTimeoutMs }), // Stage 15.5: bounded HTTP drain
        // Stage 18.7.5: Auth's pool (DbService) and the durable central audit path (the kit outbox + relay), independent of AUTH_EVENTS.
        AuditRelayModule.forRoot(cfg, auditBus, { relay: opts.auditRelay }),
      ],
      // Stage 19.5: the member-security snapshot line runs in the service, never in the operator CLI (auditRelay: false).
      // Stage 21.C.2: the code-row purge runs in the service only, like the relay (never in the operator CLI).
      providers: [{ provide: APP_CONFIG, useValue: cfg }, ...(opts.auditRelay === false ? [] : [MemberSecurityReporter, CodeEventPurge])],
    };
  }
}
