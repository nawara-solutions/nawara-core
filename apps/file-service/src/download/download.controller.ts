import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import type { Request, Response } from 'express';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import { DownloadService } from './download.service.js';

export class IssueDownloadTicketDto {
  @ApiProperty({ enum: ['download'], description: 'The only operation a file ticket grants here (upload tickets are issued by POST /file/uploads/tickets).' })
  @IsIn(['download'])
  operation!: 'download';

  @ApiPropertyOptional({ enum: ['attachment', 'inline'], default: 'attachment', description: '`inline` is allowed for images only.' })
  @IsOptional()
  @IsIn(['attachment', 'inline'])
  disposition?: 'attachment' | 'inline';

  @ApiPropertyOptional({ default: false, description: 'Single use (the default is reusable until the ticket expires).' })
  @IsOptional()
  @IsBoolean()
  singleUse?: boolean;
}

const ORG_HEADER = { name: 'X-Organization-Id', required: false, description: "The file's organization, when it has one" };
const BYTES = { description: 'The file bytes, streamed (Content-Type = the verified type; attachment; no-store; nosniff)', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };

/**
 * Stage 17.6 routes (SDD §13). Service routes: a service token and the caller policy, on the caller's OWN files only. The ticket route:
 * the ticket in the path is the only authority (no user token, no service token, no call to Auth); it serves exactly the bound file.
 */
@ApiTags('downloads')
@Controller('file')
export class DownloadController {
  constructor(private readonly downloads: DownloadService) {}

  @Get('files/:id')
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Metadata of the caller\'s file (read)', description: 'Never the storage location. Another owner\'s or organization\'s file is 404, like a missing one.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader(ORG_HEADER)
  @ApiResponse({ status: 200, description: 'The file' })
  @ApiResponse({ status: 400, description: 'validation_error (X-Organization-Id)' })
  @ApiResponse({ status: 401, description: 'no or unknown service token' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed | organization_not_allowed' })
  @ApiResponse({ status: 404, description: 'file_not_found' })
  metadata(@CallerService() caller: string, @Req() req: Request, @Param('id') id: string) {
    return this.downloads.metadata(caller, req, id);
  }

  @Get('files/:id/content')
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Stream the caller\'s file (read)', description: 'For trusted services (for example a worker attaching a file). AVAILABLE files only. No Range, no HEAD.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader(ORG_HEADER)
  @ApiResponse({ status: 200, ...BYTES })
  @ApiResponse({ status: 400, description: 'validation_error (X-Organization-Id)' })
  @ApiResponse({ status: 401, description: 'no or unknown service token' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed | organization_not_allowed' })
  @ApiResponse({ status: 404, description: 'file_not_found' })
  @ApiResponse({ status: 409, description: 'file_not_available' })
  @ApiResponse({ status: 410, description: 'file_deleted' })
  @ApiResponse({ status: 429, description: 'rate_limited (service reads per caller / per organization, F32)' })
  @ApiResponse({ status: 500, description: 'file_content_missing (the stored object is missing or contradicts the record: an integrity incident) | storage_error' })
  @ApiResponse({ status: 503, description: 'storage_unavailable | download_busy (too many downloads in progress in this process; retry, nothing consumed)' })
  async content(@CallerService() caller: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.downloads.serviceContent(caller, req, res, req.params.id as string);
  }

  @Post('files/:id/tickets')
  @HttpCode(201)
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Issue a short-lived download ticket for the caller\'s file (issue_ticket)', description: 'After the product\'s own authorization of its user. Bound to this file, this owner and organization; reusable until it expires (at most FILE_TICKET_MAX_DOWNLOADS uses) unless singleUse. Returned once; only its digest is stored.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader(ORG_HEADER)
  @ApiResponse({ status: 201, description: '{ ticketId, url, expiresAt }' })
  @ApiResponse({ status: 400, description: 'validation_error' })
  @ApiResponse({ status: 401, description: 'no or unknown service token' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed | organization_not_allowed' })
  @ApiResponse({ status: 404, description: 'file_not_found' })
  @ApiResponse({ status: 409, description: 'file_not_available' })
  @ApiResponse({ status: 410, description: 'file_deleted' })
  @ApiResponse({ status: 422, description: 'disposition_not_allowed' })
  @ApiResponse({ status: 429, description: 'rate_limited (ticket issuance per caller / per organization, F32)' })
  issueTicket(@CallerService() caller: string, @Req() req: Request, @Param('id') id: string, @Body() dto: IssueDownloadTicketDto) {
    return this.downloads.issueDownloadTicket(caller, req, id, dto);
  }

  @Delete('tickets/:ticketId')
  @HttpCode(204)
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke one of the caller\'s tickets (issue_ticket)', description: 'Idempotent. Future redemptions fail; a download already streaming may complete.' })
  @ApiParam({ name: 'ticketId', format: 'uuid' })
  @ApiHeader(ORG_HEADER)
  @ApiResponse({ status: 204, description: 'Revoked' })
  @ApiResponse({ status: 401, description: 'no or unknown service token' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed | organization_not_allowed' })
  @ApiResponse({ status: 404, description: 'ticket_not_found (also another caller\'s ticket)' })
  async revoke(@CallerService() caller: string, @Req() req: Request, @Param('ticketId') ticketId: string): Promise<void> {
    await this.downloads.revokeTicket(caller, req, ticketId);
  }

  @Get('t/:token')
  @ApiOperation({ summary: 'Redeem a download ticket (ticket holders; no authentication)', description: 'Streams exactly the bound file. A reusable ticket serves at most FILE_TICKET_MAX_DOWNLOADS times. Every unusable ticket is the same ticket_invalid. The path is never logged. No Range, no HEAD. The body is verified against the recorded SHA-256 while streaming; a mismatch ends the connection before the last bytes.' })
  @ApiParam({ name: 'token', description: 'The opaque ticket (from the issuing service)' })
  @ApiResponse({ status: 200, ...BYTES })
  @ApiResponse({ status: 404, description: 'ticket_invalid' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  @ApiResponse({ status: 500, description: 'file_content_missing (an integrity incident) | storage_error' })
  @ApiResponse({ status: 503, description: 'storage_unavailable | download_busy (too many downloads in progress in this process; retry, nothing consumed)' })
  async redeem(@Param('token') token: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.downloads.redeem(token, req, res);
  }
}
