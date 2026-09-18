import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { clientInfo } from '../common/client-info.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { NotFoundException } from '@nestjs/common';
import { PlatformAccessService } from '../platform/platform-access.service.js';
import { Actors, type AuthedRequest } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { LoginDto, RefreshDto, RegisterDto } from './dto.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PlatformAccessService) private readonly access: PlatformAccessService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private client(req: Request) {
    return clientInfo(req, this.cfg.trustProxy);
  }

  /** public */
  @Post('register')
  @ApiOperation({ summary: 'Register a member (public). Always kind=member; role "admin" is reserved.' })
  @ApiResponse({ status: 201, description: 'Tokens.' })
  @ApiResponse({ status: 403, description: 'Organization unknown or not licensed (same response for both).' })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, this.client(req));
  }

  /** public */
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email/phone + password. Members get tokens; owners get a second-factor challenge.' })
  @ApiResponse({ status: 200, description: 'Tokens, or an owner mfa_required / enrollment_required challenge.' })
  @ApiResponse({ status: 401, description: 'Generic failure.' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, this.client(req));
  }

  /** public (the refresh token is the credential) */
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate a refresh token. Reuse of a rotated token revokes the whole session.' })
  @ApiResponse({ status: 200, description: 'New token pair.' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refreshSession(dto.refreshToken, this.client(req));
  }

  /** authenticated (any kind) */
  @Post('logout')
  @HttpCode(204)
  @Actors()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the session of the given refresh token.' })
  async logout(@Body() dto: RefreshDto, @Req() req: AuthedRequest) {
    await this.auth.logout(req.actor.userId, dto.refreshToken);
  }

  /** authenticated (any kind) */
  @Get('me')
  @Actors()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The authenticated identity.' })
  me(@Req() req: AuthedRequest) {
    return this.auth.me(req.actor.userId);
  }

  /** authenticated member: tenancy check other services can rely on */
  @Get('organizations/:id/membership')
  @HttpCode(204)
  @Actors('member')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Does the calling member belong to this organization? 204, else 404.' })
  async membership(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    if (!(await this.access.memberBelongsTo(req.actor.userId, id))) throw new NotFoundException();
  }
}
