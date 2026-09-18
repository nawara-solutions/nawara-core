import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Actors, type AuthedRequest } from '../auth/auth.guard.js';
import { clientInfo } from '../common/client-info.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PasswordService } from '../crypto/password.js';
import { DbService } from '../db/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { RefreshTokenService } from '../tokens/refresh-token.service.js';
import { EnrollmentService } from './enrollment.service.js';
import { FactorService } from './factor.service.js';
import { OwnerAuthService } from './owner-auth.service.js';
import { RecoveryService } from './recovery.service.js';
import { SecretKeyService } from './secret-key.service.js';
import { StepUpService } from './step-up.service.js';
import {
  ChallengeTokenDto, ChangePasswordDto, ConfirmTotpDto, EnrollRegisterWebauthnDto, EnrollTokenDto, EnrollTotpConfirmDto,
  OwnerVerifyDto, RecoveryCompleteDto, RecoveryStartDto, RegisterWebauthnDto, StepUpDto, StepUpOptionsDto,
} from './dto.js';

const STEP_UP_HEADER = 'x-step-up-token';

/**
 * Owner authentication surface. Route classes (see docs/security):
 *   public+challenge  : login/owner/*, enroll/*, recovery/start|complete
 *   owner session     : factors/*, step-up, recovery/cancel
 *   owner + step-up   : secret-key/rotate, password/change, factors/:id (DELETE), factors confirm when a factor exists
 */
@ApiTags('owner-auth')
@Controller('auth/admin')
export class OwnerController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(DbService) private readonly db: DbService,
    @Inject(OwnerAuthService) private readonly ownerAuth: OwnerAuthService,
    @Inject(EnrollmentService) private readonly enroll: EnrollmentService,
    @Inject(FactorService) private readonly factors: FactorService,
    @Inject(StepUpService) private readonly stepUp: StepUpService,
    @Inject(SecretKeyService) private readonly secretKeys: SecretKeyService,
    @Inject(RecoveryService) private readonly recovery: RecoveryService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(RefreshTokenService) private readonly refresh: RefreshTokenService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private client(req: Request) {
    return clientInfo(req, this.cfg.trustProxy);
  }

  // ------------------------------------------------------------------ login (public + challenge)
  @Post('login/owner/webauthn-options')
  @HttpCode(200)
  @ApiOperation({ summary: 'Passkey login: get assertion options for a pending MFA challenge.' })
  webauthnLoginOptions(@Body() dto: ChallengeTokenDto, @Req() req: Request) {
    return this.ownerAuth.webauthnLoginOptions(dto.challengeToken, this.client(req).ip);
  }

  @Post('login/owner/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete owner login with a TOTP code or a passkey assertion.' })
  @ApiResponse({ status: 200, description: 'Tokens.' })
  @ApiResponse({ status: 401, description: 'Generic failure.' })
  verify(@Body() dto: OwnerVerifyDto, @Req() req: Request) {
    return this.ownerAuth.verify(dto, this.client(req));
  }

  // ------------------------------------------------------- first-factor enrollment (enrollment token)
  @Post('enroll/totp')
  @HttpCode(200)
  @ApiOperation({ summary: 'Begin TOTP enrollment with an enrollment token (bootstrap / post-recovery).' })
  async enrollTotp(@Body() dto: EnrollTokenDto) {
    return this.enroll.beginTotp(await this.enroll.fromToken(dto.enrollmentToken));
  }

  @Post('enroll/totp/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm the first TOTP factor; issues the first session.' })
  async enrollTotpConfirm(@Body() dto: EnrollTotpConfirmDto) {
    const r = await this.enroll.confirmTotp(await this.enroll.fromToken(dto.enrollmentToken), dto.factorId, dto.code);
    return r.session;
  }

  @Post('enroll/webauthn/options')
  @HttpCode(200)
  @ApiOperation({ summary: 'Passkey registration options with an enrollment token.' })
  async enrollWebauthnOptions(@Body() dto: EnrollTokenDto) {
    return this.enroll.webauthnOptions(await this.enroll.fromToken(dto.enrollmentToken));
  }

  @Post('enroll/webauthn')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register the first passkey; issues the first session.' })
  async enrollWebauthn(@Body() dto: EnrollRegisterWebauthnDto) {
    const r = await this.enroll.registerWebauthn(await this.enroll.fromToken(dto.enrollmentToken), dto.challengeId, dto.response);
    return r.session;
  }

  // ------------------------------------------------------------------- factor management (session)
  @Get('factors')
  @Actors('owner')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List the owner’s enrolled factors (no secrets).' })
  list(@Req() req: AuthedRequest) {
    return this.factors.list(req.actor.userId);
  }

  @Post('factors/totp')
  @HttpCode(200)
  @Actors('owner')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Begin adding a TOTP factor (unusable until confirmed with a step-up).' })
  beginTotp(@Req() req: AuthedRequest) {
    return this.enroll.beginTotp({ ownerId: req.actor.userId, sid: req.actor.sid });
  }

  @Post('factors/totp/confirm')
  @HttpCode(200)
  @Actors('owner')
  @ApiBearerAuth()
  @ApiHeader({ name: STEP_UP_HEADER, required: false })
  @ApiOperation({ summary: 'Confirm a new TOTP factor. Needs step-up owner.factor.enroll once a factor exists.' })
  async confirmTotp(@Body() dto: ConfirmTotpDto, @Req() req: AuthedRequest, @Headers(STEP_UP_HEADER) su?: string) {
    await this.enroll.confirmTotp({ ownerId: req.actor.userId, sid: req.actor.sid }, dto.factorId, dto.code, su);
  }

  @Post('factors/webauthn/options')
  @HttpCode(200)
  @Actors('owner')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Passkey registration options (bound to this session).' })
  webauthnOptions(@Req() req: AuthedRequest) {
    return this.enroll.webauthnOptions({ ownerId: req.actor.userId, sid: req.actor.sid });
  }

  @Post('factors/webauthn')
  @HttpCode(200)
  @Actors('owner')
  @ApiBearerAuth()
  @ApiHeader({ name: STEP_UP_HEADER, required: false })
  @ApiOperation({ summary: 'Register a passkey. Needs step-up owner.factor.enroll once a factor exists.' })
  async registerWebauthn(@Body() dto: RegisterWebauthnDto, @Req() req: AuthedRequest, @Headers(STEP_UP_HEADER) su?: string) {
    await this.enroll.registerWebauthn({ ownerId: req.actor.userId, sid: req.actor.sid }, dto.challengeId, dto.response, su);
  }

  @Delete('factors/:id')
  @HttpCode(204)
  @Actors('owner')
  @ApiBearerAuth()
  @ApiHeader({ name: STEP_UP_HEADER, required: true })
  @ApiOperation({ summary: 'Remove a factor (step-up owner.factor.remove; never the last one).' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest, @Headers(STEP_UP_HEADER) su?: string) {
    await this.db.tx(async (q) => {
      await this.stepUp.consume(q, { ownerId: req.actor.userId, sid: req.actor.sid, purpose: 'owner.factor.remove', token: su });
      await this.factors.removeSafely(q, req.actor.userId, id);
      await this.audit.record({ type: 'owner.factor.removed', outcome: 'success', actorId: req.actor.userId, targetId: id, sessionFamilyId: req.actor.sid }, q);
    });
  }

  // ------------------------------------------------------------------------------------- step-up
  @Post('step-up/webauthn-options')
  @HttpCode(200)
  @Actors('owner')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Passkey step-up: get assertion options for a purpose.' })
  stepUpOptions(@Body() dto: StepUpOptionsDto, @Req() req: AuthedRequest) {
    return this.stepUp.webauthnOptions(req.actor.userId, req.actor.sid, dto.purpose, this.client(req).ip);
  }

  @Post('step-up')
  @HttpCode(200)
  @Actors('owner')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Re-verify (TOTP / passkey / secret key) for one sensitive purpose.' })
  @ApiResponse({ status: 200, description: '{ stepUpToken, expiresAt } — single use, ≤ 15 minutes, this session and purpose only.' })
  issueStepUp(@Body() dto: StepUpDto, @Req() req: AuthedRequest) {
    return this.stepUp.issue({ ownerId: req.actor.userId, sid: req.actor.sid, purpose: dto.purpose, method: dto.method, code: dto.code, secretKey: dto.secretKey, challengeId: dto.challengeId, assertion: dto.assertion }, this.client(req).ip);
  }

  // ------------------------------------------------------------------ secret key / password (step-up)
  @Post('secret-key/rotate')
  @HttpCode(200)
  @Actors('owner')
  @ApiBearerAuth()
  @ApiHeader({ name: STEP_UP_HEADER, required: true })
  @ApiOperation({ summary: 'Issue/rotate the secret key (step-up owner.secret_key.rotate, factor only). Returned once.' })
  rotate(@Req() req: AuthedRequest, @Headers(STEP_UP_HEADER) su?: string) {
    return this.db.tx(async (q) => {
      await this.stepUp.consume(q, { ownerId: req.actor.userId, sid: req.actor.sid, purpose: 'owner.secret_key.rotate', token: su });
      const r = await this.secretKeys.issue(q, req.actor.userId);
      await this.audit.record({ type: 'owner.secret_key.rotated', outcome: 'success', actorId: req.actor.userId, sessionFamilyId: req.actor.sid, ip: this.client(req).ip }, q);
      return r;
    });
  }

  @Post('password/change')
  @HttpCode(204)
  @Actors('owner')
  @ApiBearerAuth()
  @ApiHeader({ name: STEP_UP_HEADER, required: true })
  @ApiOperation({ summary: 'Change the password (step-up owner.password.change). Ends all OTHER sessions.' })
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: AuthedRequest, @Headers(STEP_UP_HEADER) su?: string) {
    const hash = await this.passwords.hash(dto.newPassword);
    await this.db.tx(async (q) => {
      await this.stepUp.consume(q, { ownerId: req.actor.userId, sid: req.actor.sid, purpose: 'owner.password.change', token: su });
      await q.query(`UPDATE "user" SET "passwordHash"=$2, "updatedAt"=now() WHERE id=$1`, [req.actor.userId, hash]);
      await this.refresh.revokeAllForUser(q, req.actor.userId, req.actor.sid);
      await this.audit.record({ type: 'owner.password.changed', outcome: 'success', actorId: req.actor.userId, sessionFamilyId: req.actor.sid, ip: this.client(req).ip }, q);
    });
  }

  // ---------------------------------------------------------------------------------------- recovery
  @Post('recovery/start')
  @HttpCode(202)
  @ApiOperation({ summary: 'Start owner recovery (password + secret key). Begins a cool-down; changes nothing yet.' })
  recoveryStart(@Body() dto: RecoveryStartDto, @Req() req: Request) {
    return this.recovery.start(dto, this.client(req));
  }

  @Post('recovery/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete recovery after the cool-down. Returns an enrollment token — never a session.' })
  recoveryComplete(@Body() dto: RecoveryCompleteDto, @Req() req: Request) {
    return this.recovery.complete(dto, this.client(req));
  }

  @Post('recovery/cancel')
  @HttpCode(204)
  @Actors('owner')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel a pending recovery request (from a session that still has a working factor).' })
  async recoveryCancel(@Req() req: AuthedRequest) {
    await this.recovery.cancel(req.actor.userId, req.actor.sid, this.client(req).ip);
  }
}
