import { Controller, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Actors, type AuthedRequest } from '../auth/auth.guard.js';
import { clientInfo } from '../common/client-info.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { ReferenceRepairResponseDto } from './dto.js';
import { ReferenceRepairService } from './reference-repair.service.js';

/**
 * Hierarchy reference repair (ADR-0061; A5.4-A3). Any authenticated user reaches the handler: the Owner check, the source and marker
 * check and the validation are the service's, in the accepted order, so that a refused non-Owner can be recorded (A5.4-A3 O11). With
 * Auth's hierarchy source `local`, or the authority marker `local`, the route answers the collapsed 404 and does nothing.
 */
@ApiTags('hierarchy-reference-repair')
@Controller('auth/admin/hierarchy-references')
export class ReferenceRepairController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(ReferenceRepairService) private readonly repairs: ReferenceRepairService,
  ) {}

  @Post(':kind/:id/repair')
  @HttpCode(200)
  @Actors()
  @ApiBearerAuth()
  @ApiHeader({ name: 'x-step-up-token', required: true, description: 'A fresh, factor-only step-up issued for the reference repair purpose.' })
  @ApiOperation({ summary: "The active Company Owner repairs a missing hierarchy reference (a Platform or an Organization of the Owner's Company), with a fresh step-up consumed once per attempt. Only when Organization Service is the hierarchy authority." })
  @ApiResponse({ status: 200, type: ReferenceRepairResponseDto, description: 'The reference is present; placed says whether this request inserted it.' })
  @ApiResponse({ status: 400, description: 'Malformed kind or id.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  @ApiResponse({ status: 403, description: 'Not the active Company Owner, or no valid step-up.' })
  @ApiResponse({ status: 404, description: 'Not found, not yours, or the repair is not available (collapsed).' })
  @ApiResponse({ status: 429, description: 'Too many attempts.' })
  @ApiResponse({ status: 503, description: 'The hierarchy is temporarily unavailable.' })
  repair(@Param('kind') kind: string, @Param('id') id: string, @Req() req: AuthedRequest, @Headers('x-step-up-token') stepUpToken?: string): Promise<ReferenceRepairResponseDto> {
    return this.repairs.repair(req.actor, kind, id, stepUpToken, clientInfo(req, this.cfg.trustProxyHops).ip);
  }
}
