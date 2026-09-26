import { Body, Controller, Header, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { Actors, type AuthedRequest } from '../auth/auth.guard.js';
import { clientInfo } from '../common/client-info.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { MemberSecurityService, SUSPENSION_REASONS, type SuspensionReason } from './member-security.service.js';

export class SuspendMemberDto {
  @ApiProperty({ enum: SUSPENSION_REASONS, description: 'Closed reason code (ADR-0050 D6). Free text is refused.' })
  @IsIn(SUSPENSION_REASONS)
  reason!: SuspensionReason;
}

class MemberSecurityStateDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() suspended!: boolean;
  @ApiProperty({ description: 'false: the account was already in this state; nothing was written.' }) changed!: boolean;
}

/**
 * Route class: owner + FACTOR step-up (Stage 19.2, ADR-0050 decision 5). Operators and members are refused by the guard (403): this is
 * not an operator capability until an operator step-up exists (D7). The Company and the actor are never taken from the request.
 */
@ApiTags('member-security')
@Controller('auth/admin/members')
export class MemberSecurityController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(MemberSecurityService) private readonly members: MemberSecurityService,
  ) {}

  @Post(':id/suspend')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Actors('owner')
  @ApiBearerAuth()
  @ApiHeader({ name: 'x-step-up-token', required: true, description: 'Factor step-up (TOTP or passkey) for purpose "account.suspend".' })
  @ApiOperation({ summary: 'Suspend a member of the owner\'s Company: disables the identity and ends every session now. Idempotent.' })
  @ApiResponse({ status: 200, type: MemberSecurityStateDto })
  @ApiResponse({ status: 403, description: 'Not an owner, or no valid step-up.' })
  @ApiResponse({ status: 404, description: 'No such member, not of your Company, or also a member under another Company — indistinguishable.' })
  suspend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SuspendMemberDto, @Req() req: AuthedRequest, @Headers('x-step-up-token') su?: string) {
    return this.members.suspend({ userId: req.actor.userId, sid: req.actor.sid }, id, dto.reason, su, clientInfo(req, this.cfg.trustProxy).ip);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Actors('owner')
  @ApiBearerAuth()
  @ApiHeader({ name: 'x-step-up-token', required: true, description: 'Factor step-up (TOTP or passkey) for purpose "account.restore".' })
  @ApiOperation({ summary: 'Restore a suspended member of the owner\'s Company. Sessions are not recreated. Idempotent.' })
  @ApiResponse({ status: 200, type: MemberSecurityStateDto })
  @ApiResponse({ status: 403, description: 'Not an owner, or no valid step-up.' })
  @ApiResponse({ status: 404, description: 'No such member, not of your Company, or also a member under another Company — indistinguishable.' })
  restore(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest, @Headers('x-step-up-token') su?: string) {
    return this.members.restore({ userId: req.actor.userId, sid: req.actor.sid }, id, su, clientInfo(req, this.cfg.trustProxy).ip);
  }
}
