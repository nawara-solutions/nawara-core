import { Body, Controller, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Actors, type AuthedRequest } from '../auth/auth.guard.js';
import { clientInfo } from '../common/client-info.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { CreateOperatorDto, OperatorCodeDto, OperatorRequestCodeDto } from './dto.js';
import { OperatorAdminService } from './operator-admin.service.js';
import { OperatorCodeService } from './operator-code.service.js';

/**
 * Route classes:
 *   public            : login/operator/request-code, login/operator/verify-code, operators/confirm
 *   owner + step-up   : POST operators
 *   owner (emergency) : POST operators/:id/block|unblock   (deliberately no step-up)
 * Operators have no password; none of these routes accepts one.
 */
@ApiTags('operator-auth')
@Controller('auth/admin')
export class OperatorController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(OperatorCodeService) private readonly codes: OperatorCodeService,
    @Inject(OperatorAdminService) private readonly admin: OperatorAdminService,
  ) {}

  private client(req: Request) {
    return clientInfo(req, this.cfg.trustProxy);
  }

  @Post('login/operator/request-code')
  @HttpCode(204)
  @ApiOperation({ summary: 'Ask for today’s working code. Always 204: reveals nothing about the account.' })
  async requestCode(@Body() dto: OperatorRequestCodeDto, @Req() req: Request) {
    await this.codes.requestLoginCode(dto, this.client(req));
  }

  @Post('login/operator/verify-code')
  @HttpCode(200)
  @ApiOperation({ summary: 'Redeem the working code for a temporary session (bounded by the shift ceiling).' })
  @ApiResponse({ status: 200, description: 'Tokens.' })
  @ApiResponse({ status: 401, description: 'Generic failure (wrong, expired, used, locked, unknown).' })
  verifyCode(@Body() dto: OperatorCodeDto, @Req() req: Request) {
    return this.codes.verifyLogin(dto, this.client(req));
  }

  @Post('operators/confirm')
  @HttpCode(204)
  @ApiOperation({ summary: 'Confirm an operator’s contact with the confirmation code.' })
  async confirm(@Body() dto: OperatorCodeDto, @Req() req: Request) {
    await this.codes.confirm(dto, this.client(req));
  }

  @Post('operators')
  @Actors('owner')
  @ApiBearerAuth()
  @ApiHeader({ name: 'x-step-up-token', required: true })
  @ApiOperation({ summary: 'Create an operator in the owner’s company (step-up operator.create).' })
  create(@Body() dto: CreateOperatorDto, @Req() req: AuthedRequest, @Headers('x-step-up-token') su?: string) {
    return this.admin.create({ userId: req.actor.userId, sid: req.actor.sid }, dto, su, this.client(req).ip);
  }

  @Post('operators/:id/block')
  @HttpCode(204)
  @Actors('owner')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Block an operator: ends all their sessions now.' })
  block(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.admin.setBlocked({ userId: req.actor.userId, sid: req.actor.sid }, id, true, this.client(req).ip);
  }

  @Post('operators/:id/unblock')
  @HttpCode(204)
  @Actors('owner')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Unblock an operator.' })
  unblock(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.admin.setBlocked({ userId: req.actor.userId, sid: req.actor.sid }, id, false, this.client(req).ip);
  }
}
