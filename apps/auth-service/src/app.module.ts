import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { SessionService } from './auth/session.service.js';
import { CLOCK, EVENT_BUS, NoopEventBus, SystemClock } from './common/ports.js';
import { APP_CONFIG, loadConfig, type AppConfig } from './config/app-config.js';
import { PasswordService } from './crypto/password.js';
import { TotpSecretCipher } from './crypto/totp-cipher.js';
import { DbService } from './db/db.service.js';
import { EventsModule } from './events/events.module.js';
import { EventsPublisherService } from './events/events-publisher.service.js';
import { HealthController } from './health/health.controller.js';
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
import { PAYMENT_CLIENT, HttpPaymentClient } from './payment/payment-client.js';
import { AssignmentService } from './platform/assignment.service.js';
import { PlatformAccessService } from './platform/platform-access.service.js';
import { PlatformController } from './platform/platform.controller.js';
import { ThrottleService } from './throttle/throttle.service.js';
import { RefreshTokenService } from './tokens/refresh-token.service.js';
import { TokenService } from './tokens/token.service.js';
import { UsersService } from './users/users.service.js';

// Broker wiring can be switched off (tests, local runs without RabbitMQ): AUTH_EVENTS=off.
const eventsEnabled = process.env.AUTH_EVENTS !== 'off';

@Module({
  imports: [
    // Coarse per-IP baseline for every route. The security-relevant limits are the bucketed,
    // DB-backed ones in ThrottleService (per identifier / per operator / global), not this.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.BASELINE_RATE_LIMIT_PER_MINUTE ?? 100) }]),
    ...(eventsEnabled ? [EventsModule] : []),
  ],
  controllers: [AppController, HealthController, AuthController, OnboardingController, OrganizationController, OwnerController, OperatorController, PlatformController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() },
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: EVENT_BUS,
      useFactory: (pub?: EventsPublisherService) => pub ?? new NoopEventBus(),
      inject: [{ token: EventsPublisherService, optional: true }],
    },
    { provide: PasswordService, useFactory: (c: AppConfig) => new PasswordService(c.bcryptCost), inject: [APP_CONFIG] },
    { provide: TotpSecretCipher, useFactory: (c: AppConfig) => new TotpSecretCipher(c.secrets.totpKeys, c.secrets.totpActiveKeyId), inject: [APP_CONFIG] },
    { provide: PAYMENT_CLIENT, useClass: HttpPaymentClient },
    DbService, AuditService, ThrottleService, UsersService, TokenService, RefreshTokenService, SessionService,
    ChallengeService, WebAuthnService, FactorService, SecretKeyService, AdminDeviceService, StepUpService,
    OwnerAuthService, EnrollmentService, RecoveryService,
    OperatorAvailabilityService, OperatorCodeService, OperatorAdminService,
    PlatformAccessService, AssignmentService, OnboardingService, ContactVerificationService, InvitationService, MembershipService, AuthService, AuthGuard,
  ],
})
export class AppModule {}
