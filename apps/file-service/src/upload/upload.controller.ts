import { Body, Controller, HttpCode, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import { FILE_MAX_BYTES_BOUND } from '../config/file-config.js';
import { FILE_MEDIA_TYPES, type FileMediaType } from '../policy/media-types.js';
import { UploadService } from './upload.service.js';

export class IssueUploadTicketDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'The organization the new file belongs to (callers with organizations=request only); omitted = a platform file.' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ minimum: 1, maximum: FILE_MAX_BYTES_BOUND, description: 'The largest file this ticket accepts (≤ the caller\'s policy maxBytes).' })
  @IsInt()
  @Min(1)
  @Max(FILE_MAX_BYTES_BOUND)
  maxBytes!: number;

  @ApiProperty({ enum: FILE_MEDIA_TYPES, isArray: true, description: 'The types the upload may be (⊆ the caller\'s policy); decided from the bytes, never the declaration.' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(FILE_MEDIA_TYPES.length)
  @IsIn(FILE_MEDIA_TYPES, { each: true })
  mediaTypes!: FileMediaType[];

  @ApiPropertyOptional({ default: false, description: 'Attach the created file when the upload completes (otherwise the owner attaches it before its deadline).' })
  @IsOptional()
  @IsBoolean()
  attach?: boolean;
}

const FILE_VIEW = {
  description: 'The file (never its storage location).',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' }, status: { type: 'string' }, organizationId: { type: 'string', nullable: true },
      originalName: { type: 'string', nullable: true }, mediaType: { type: 'string', nullable: true }, sizeBytes: { type: 'integer', nullable: true },
      sha256: { type: 'string', nullable: true }, attachedAt: { type: 'string', nullable: true }, attachDeadline: { type: 'string', nullable: true },
      createdAt: { type: 'string' }, availableAt: { type: 'string', nullable: true },
    },
  },
};
const RAW_BODY = { schema: { type: 'string', format: 'binary' }, description: 'The raw file bytes (not multipart). Content-Length is required.' };

/**
 * Stage 17.5 routes (SDD §13). Service routes require a service token and the caller policy; the ticket route requires nothing but the
 * ticket in its path (the uploader is untrusted and never authenticates to File Service; no user token, no call to Auth).
 */
@ApiTags('uploads')
@Controller('file')
export class UploadController {
  constructor(private readonly uploads: UploadService) {}

  @Post('uploads/tickets')
  @HttpCode(201)
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Issue a short-lived, single-use upload ticket (issue_ticket)', description: 'The owner is the authenticated caller. The ticket URL is returned once; only its SHA-256 digest is stored. Not idempotent: each call issues a new ticket (an unused ticket creates nothing and expires).' })
  @ApiResponse({ status: 201, description: '{ ticketId, url, expiresAt }' })
  @ApiResponse({ status: 400, description: 'validation_error' })
  @ApiResponse({ status: 401, description: 'no or unknown service token' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed | organization_not_allowed | max_bytes_not_allowed | media_type_not_allowed' })
  @ApiResponse({ status: 429, description: 'rate_limited (ticket issuance per caller / per organization, F32)' })
  issueTicket(@CallerService() caller: string, @Body() dto: IssueUploadTicketDto) {
    return this.uploads.issueUploadTicket(caller, dto);
  }

  @Post('files')
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upload a file as the calling service (upload), streamed', description: 'Idempotent: the same Idempotency-Key and declaration return the same file (200) without storing the bytes again.' })
  @ApiConsumes('application/octet-stream')
  @ApiBody(RAW_BODY)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Organization-Id', required: false, description: 'UUID (organizations=request callers only)' })
  @ApiHeader({ name: 'X-File-Name', required: false, description: 'Percent-encoded UTF-8; presentation only' })
  @ApiHeader({ name: 'Content-Digest', required: false, description: 'sha-256=:<base64>: (RFC 9530): enforced before the file is stored' })
  @ApiHeader({ name: 'X-Attach', required: false, description: 'true: create the file already attached' })
  @ApiResponse({ status: 201, ...FILE_VIEW })
  @ApiResponse({ status: 200, description: 'Idempotent replay: the same file' })
  @ApiResponse({ status: 409, description: 'upload_in_progress' })
  @ApiResponse({ status: 411, description: 'length_required' })
  @ApiResponse({ status: 413, description: 'file_too_large' })
  @ApiResponse({ status: 415, description: 'unsupported_media_type' })
  @ApiResponse({ status: 422, description: 'media_type_mismatch | checksum_mismatch | idempotency_key_reused' })
  @ApiResponse({ status: 429, description: 'rate_limited (uploads per caller / per organization, F32; replays count)' })
  @ApiResponse({ status: 503, description: 'storage_unavailable | upload_busy (too many uploads in progress; retry)' })
  async upload(@CallerService() caller: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.uploads.serviceUpload(caller, req);
    res.status(result.created ? 201 : 200);
    return result.file;
  }

  @Post('files/:id/attach')
  @HttpCode(200)
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark the caller\'s file attached (attach), idempotently' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader({ name: 'X-Organization-Id', required: false, description: 'The file\'s organization, when it has one' })
  @ApiResponse({ status: 200, ...FILE_VIEW })
  @ApiResponse({ status: 404, description: 'file_not_found (also for another owner\'s or organization\'s file)' })
  @ApiResponse({ status: 409, description: 'file_not_available' })
  attach(@CallerService() caller: string, @Req() req: Request, @Param('id') id: string) {
    return this.uploads.attach(caller, req, id);
  }

  @Put('t/:token')
  @ApiOperation({ summary: 'Redeem an upload ticket: stream the file (ticket holders; no authentication)', description: 'Single-use. A retry after completion returns the created file (200). Every invalid, expired, used, revoked or unknown ticket is the same ticket_invalid. The path is never logged.' })
  @ApiConsumes('application/octet-stream')
  @ApiBody(RAW_BODY)
  @ApiParam({ name: 'token', description: 'The opaque ticket (from the issuing service)' })
  @ApiHeader({ name: 'X-File-Name', required: false, description: 'Percent-encoded UTF-8; presentation only' })
  @ApiResponse({ status: 201, ...FILE_VIEW })
  @ApiResponse({ status: 200, description: 'Retry of a completed upload: the same file' })
  @ApiResponse({ status: 404, description: 'ticket_invalid' })
  @ApiResponse({ status: 409, description: 'upload_in_progress' })
  @ApiResponse({ status: 411, description: 'length_required' })
  @ApiResponse({ status: 413, description: 'file_too_large' })
  @ApiResponse({ status: 415, description: 'unsupported_media_type' })
  @ApiResponse({ status: 422, description: 'media_type_mismatch' })
  @ApiResponse({ status: 429, description: 'rate_limited' })
  @ApiResponse({ status: 503, description: 'storage_unavailable | upload_busy (too many uploads in progress; the ticket is not consumed)' })
  async redeem(@Param('token') token: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.uploads.redeemUploadTicket(token, req);
    res.status(result.created ? 201 : 200);
    return result.file;
  }
}
