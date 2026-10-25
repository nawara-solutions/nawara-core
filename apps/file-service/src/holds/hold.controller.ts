import { Body, Controller, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import type { Request, Response } from 'express';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import { HoldService } from './hold.service.js';

export class HoldRefDto {
  @ApiProperty({ format: 'uuid', description: "The holder's reference of its preservation obligation (one hold per reference, for one file, for ever)." })
  @IsUUID()
  holdRef!: string;
}

const ORG_HEADER = { name: 'X-Organization-Id', required: false, description: "The file's organization, when it has one" };
const HOLD_VIEW = { description: '{ holdId, fileId, holdRef, organizationId, status (active | released), placedAt, releasedAt }' };

/**
 * Core V2 S2-File.3 (register FIL-04 / FIL-05): evidence-hold placement and release, service tokens only (`hold`), on the caller's OWN
 * files. No human, grantee or public route. While any hold is active, `DELETE /file/files/{id}` is `409 file_held` (FIL-06).
 */
@ApiTags('evidence-holds')
@Controller('file/files/:id/holds')
@UseGuards(ServiceTokenGuard)
@ApiBearerAuth()
export class HoldController {
  constructor(private readonly holds: HoldService) {}

  @Post()
  @ApiOperation({ summary: "Place an evidence hold on the caller's file (hold)", description: 'Owner service only; the file cannot be deleted by any path while any hold is active. Idempotent per holdRef; no expiry.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader(ORG_HEADER)
  @ApiResponse({ status: 201, ...HOLD_VIEW })
  @ApiResponse({ status: 200, description: 'The same holdRef on the same file, still active: the same hold' })
  @ApiResponse({ status: 400, description: 'validation_error' })
  @ApiResponse({ status: 401, description: 'no or unknown service token' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed | organization_not_allowed' })
  @ApiResponse({ status: 404, description: "file_not_found (also another owner's or organization's file)" })
  @ApiResponse({ status: 409, description: 'file_not_available | hold_ref_conflict (used for another file) | hold_released (never placed again)' })
  @ApiResponse({ status: 410, description: 'file_deleted' })
  async place(@CallerService() caller: string, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('id') id: string, @Body() dto: HoldRefDto) {
    const result = await this.holds.place(caller, req, id, dto.holdRef);
    res.status(result.created ? 201 : 200);
    return result.hold;
  }

  @Post('release')
  @HttpCode(200)
  @ApiOperation({ summary: "Release one of the caller's evidence holds on its file (hold)", description: 'Exactly the hold with this holdRef on this file, placed by the caller; final and idempotent (a repeat answers the first release). Other holds stay active.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader(ORG_HEADER)
  @ApiResponse({ status: 200, ...HOLD_VIEW })
  @ApiResponse({ status: 400, description: 'validation_error' })
  @ApiResponse({ status: 401, description: 'no or unknown service token' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed | organization_not_allowed' })
  @ApiResponse({ status: 404, description: "hold_not_found (also another service's hold, another file or organization)" })
  release(@CallerService() caller: string, @Req() req: Request, @Param('id') id: string, @Body() dto: HoldRefDto) {
    return this.holds.release(caller, req, id, dto.holdRef);
  }
}
