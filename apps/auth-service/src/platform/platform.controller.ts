import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Actors, type AuthedRequest } from '../auth/auth.guard.js';
import { clientInfo } from '../common/client-info.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { GrantAssignmentDto } from '../operator/dto.js';
import { AssignmentService } from './assignment.service.js';
import { PlatformAccessService, isAllowed } from './platform-access.service.js';

/**
 * Route classes:
 *   owner|operator (live) : GET platform-access/:platformId, GET admin/organizations/:id
 *   owner + step-up       : POST/DELETE operators/:id/platform-assignments
 *   owner                 : GET operators/:id/platform-assignments
 * Deny = the same collapsed 404 for "no such thing", "not yours" and "not assigned".
 */
@ApiTags('platform-access')
@Controller('auth')
export class PlatformController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PlatformAccessService) private readonly access: PlatformAccessService,
    @Inject(AssignmentService) private readonly assignments: AssignmentService,
  ) {}

  private ip(req: Request) {
    return clientInfo(req, this.cfg.trustProxy).ip;
  }

  @Get('platform-access/:platformId')
  @Actors('owner', 'operator')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Live check: may the caller act on this platform right now? 200 or 404.' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Unknown, other company, or not assigned — indistinguishable.' })
  async platformAccess(@Param('platformId', ParseUUIDPipe) platformId: string, @Req() req: AuthedRequest) {
    if (!isAllowed(await this.access.check(req.actor.userId, platformId))) throw new NotFoundException();
    return { platformId, allowed: true };
  }

  /** The platform is DERIVED from the organization row, never taken from the client. */
  @Get('admin/organizations/:id')
  @Actors('owner', 'operator')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Organization lookup, authorized via resource -> organization -> platform -> caller.' })
  async organization(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    const p = await this.access.platformOfOrganization(id);
    if (!p || !isAllowed(await this.access.check(req.actor.userId, p.platformId))) throw new NotFoundException();
    return { id, platformId: p.platformId };
  }

  @Post('admin/operators/:id/platform-assignments')
  @Actors('owner')
  @ApiBearerAuth()
  @ApiHeader({ name: 'x-step-up-token', required: true })
  @ApiOperation({ summary: 'Grant an operator a platform (step-up platform_assignment.grant). assignedBy is derived.' })
  grant(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GrantAssignmentDto, @Req() req: AuthedRequest, @Headers('x-step-up-token') su?: string) {
    return this.assignments.grant({ userId: req.actor.userId, sid: req.actor.sid }, id, dto.platformId, su, this.ip(req));
  }

  @Delete('admin/operators/:id/platform-assignments/:platformId')
  @HttpCode(204)
  @Actors('owner')
  @ApiBearerAuth()
  @ApiHeader({ name: 'x-step-up-token', required: true })
  @ApiOperation({ summary: 'Revoke an assignment (step-up platform_assignment.revoke). revokedBy is derived.' })
  revoke(@Param('id', ParseUUIDPipe) id: string, @Param('platformId', ParseUUIDPipe) platformId: string, @Req() req: AuthedRequest, @Headers('x-step-up-token') su?: string) {
    return this.assignments.revoke({ userId: req.actor.userId, sid: req.actor.sid }, id, platformId, su, this.ip(req));
  }

  @Get('admin/operators/:id/platform-assignments')
  @Actors('owner')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Full assignment history (active and revoked).' })
  history(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.assignments.history({ userId: req.actor.userId, sid: req.actor.sid }, id);
  }
}
