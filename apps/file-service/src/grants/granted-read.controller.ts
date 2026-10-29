import { Body, Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import { IssueDownloadTicketDto } from '../download/download.controller.js';
import { GrantedReadService } from './granted-read.service.js';

const PARAMS = [{ name: 'grantId', format: 'uuid' }, { name: 'fileId', format: 'uuid' }] as const;
const BYTES = { description: 'The file bytes, streamed (Content-Type = the verified type; attachment; no-store; nosniff)', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
const REFUSED = "file_not_found: anything else (not the caller's grant, another file, a purpose outside readPurposes, revoked, expired, the file no longer AVAILABLE or the grantor's, the grantor no longer allowed)";

/**
 * Core V2 S2-File.2 (register FIL-02 / FIL-03): a grantee service's reads of ONE file through ONE of its evidence grants, service tokens
 * only (`read_granted`). The grant and the file are both named; nothing is taken from headers (no X-Organization-Id: the organization is
 * the grant's). Every authorized access is recorded (`file.granted_read`). The owner-only routes are unchanged.
 */
@ApiTags('evidence-grants')
@Controller('file/evidence-grants/:grantId/files/:fileId')
@UseGuards(ServiceTokenGuard)
@ApiBearerAuth()
export class GrantedReadController {
  constructor(private readonly reads: GrantedReadService) {}

  @Get()
  @ApiOperation({ summary: 'Metadata of a file granted to the caller (read_granted)', description: 'Through an active evidence grant naming the caller and this file; recorded as access=metadata.' })
  @ApiParam(PARAMS[0])
  @ApiParam(PARAMS[1])
  @ApiResponse({ status: 200, description: 'The file, and (Core V2 S6e-D) `grant: { id, purpose, caseRef, expiresAt }`: the grant this read went through' })
  @ApiResponse({ status: 401, description: 'no or unknown service token' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed (no read_granted)' })
  @ApiResponse({ status: 404, description: REFUSED })
  metadata(@CallerService() caller: string, @Param('grantId') grantId: string, @Param('fileId') fileId: string) {
    return this.reads.metadata(caller, grantId, fileId);
  }

  @Get('content')
  @ApiOperation({ summary: 'Content of a file granted to the caller (read_granted)', description: 'Authorized and recorded (access=content_authorized: not proof of delivery) before the store is opened; a revocation after that cannot recall the stream.' })
  @ApiParam(PARAMS[0])
  @ApiParam(PARAMS[1])
  @ApiResponse({ status: 200, ...BYTES })
  @ApiResponse({ status: 401, description: 'no or unknown service token' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed (no read_granted)' })
  @ApiResponse({ status: 404, description: REFUSED })
  @ApiResponse({ status: 429, description: 'rate_limited (service reads per caller, F32)' })
  @ApiResponse({ status: 500, description: 'file_content_missing | storage_error' })
  @ApiResponse({ status: 503, description: 'storage_unavailable | download_busy (nothing authorized or recorded)' })
  async content(@CallerService() caller: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.reads.content(caller, req, res, req.params.grantId as string, req.params.fileId as string);
  }

  @Post('tickets')
  @HttpCode(201)
  @ApiOperation({ summary: 'Issue a download ticket for a file granted to the caller (read_granted)', description: 'Bound to the grant, its file and organization; expires at the earlier of the ticket lifetime and the grant\'s expiry; redemption re-checks the grant; revoking the grant revokes the ticket. Recorded as access=ticket_issued.' })
  @ApiParam(PARAMS[0])
  @ApiParam(PARAMS[1])
  @ApiResponse({ status: 201, description: '{ ticketId, url, expiresAt }' })
  @ApiResponse({ status: 400, description: 'validation_error' })
  @ApiResponse({ status: 401, description: 'no or unknown service token' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed (no read_granted)' })
  @ApiResponse({ status: 404, description: REFUSED })
  @ApiResponse({ status: 409, description: 'grant_expiring (the grant ends within the minimum ticket lifetime)' })
  @ApiResponse({ status: 422, description: 'disposition_not_allowed' })
  @ApiResponse({ status: 429, description: 'rate_limited (ticket issuance per caller, F32)' })
  issueTicket(@CallerService() caller: string, @Param('grantId') grantId: string, @Param('fileId') fileId: string, @Body() dto: IssueDownloadTicketDto) {
    return this.reads.issueTicket(caller, grantId, fileId, dto);
  }
}
