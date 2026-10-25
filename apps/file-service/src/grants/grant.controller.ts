import { Body, Controller, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import { GRANT_LIFETIME_DEFAULT_SECONDS, GRANT_LIFETIME_MAX_SECONDS, GRANT_LIFETIME_MIN_SECONDS } from '../persistence/grant.repository.js';
import { EVIDENCE_PURPOSES, type EvidencePurpose } from './evidence-purposes.js';
import { GrantService } from './grant.service.js';

export class IssueEvidenceGrantDto {
  @ApiProperty({ enum: EVIDENCE_PURPOSES, description: 'The evidence purpose; it fixes the grantee (dispute_evidence: payment-service; surplus_evidence and settlement_evidence: billing-service).' })
  @IsIn(EVIDENCE_PURPOSES)
  purpose!: EvidencePurpose;

  @ApiProperty({ format: 'uuid', description: "The grantor's opaque reference of the case the evidence belongs to." })
  @IsUUID()
  caseRef!: string;

  @ApiPropertyOptional({ minimum: GRANT_LIFETIME_MIN_SECONDS, maximum: GRANT_LIFETIME_MAX_SECONDS, default: GRANT_LIFETIME_DEFAULT_SECONDS, description: 'Lifetime in seconds; never extended (renewal = a new grant).' })
  @IsOptional()
  @IsInt()
  @Min(GRANT_LIFETIME_MIN_SECONDS)
  @Max(GRANT_LIFETIME_MAX_SECONDS)
  expiresInSeconds?: number;
}

const ORG_HEADER = { name: 'X-Organization-Id', required: false, description: "The file's organization, when it has one" };
const GRANT_VIEW = { description: '{ grantId, fileId, purpose, grantee, caseRef, organizationId, status (active | expired | revoked), expiresAt, revokedAt, createdAt }' };

/**
 * Core V2 S2-File.1 (register FIL-01): evidence-grant issuance and revocation, service tokens only (`grant`), on the caller's OWN files.
 * No human, public or grantee route: nothing here lets a grantee read a file (granted reads are S2-File.2).
 */
@ApiTags('evidence-grants')
@Controller('file')
export class GrantController {
  constructor(private readonly grants: GrantService) {}

  @Post('files/:id/evidence-grants')
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Grant another Core service the time-bounded use of the caller's file as evidence of one case (grant)", description: 'Owner service only; the grantee is fixed by the purpose; the grant is bound to this file, its organization, the purpose and the case. Idempotent by Idempotency-Key. Granted reads are not yet available.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader(ORG_HEADER)
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '1-255 printable characters' })
  @ApiResponse({ status: 201, ...GRANT_VIEW })
  @ApiResponse({ status: 200, description: 'Idempotent replay: the same grant (whatever its state now)' })
  @ApiResponse({ status: 400, description: 'validation_error' })
  @ApiResponse({ status: 401, description: 'no or unknown service token' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed | organization_not_allowed | purpose_not_allowed' })
  @ApiResponse({ status: 404, description: "file_not_found (also another owner's or organization's file)" })
  @ApiResponse({ status: 409, description: 'file_not_grantable (not AVAILABLE and attached)' })
  @ApiResponse({ status: 410, description: 'file_deleted' })
  @ApiResponse({ status: 422, description: 'idempotency_key_reused' })
  async issue(@CallerService() caller: string, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('id') id: string, @Body() dto: IssueEvidenceGrantDto) {
    const result = await this.grants.issue(caller, req, id, dto);
    res.status(result.created ? 201 : 200);
    return result.grant;
  }

  @Post('evidence-grants/:grantId/revoke')
  @HttpCode(200)
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke one of the caller's evidence grants (grant)", description: 'Terminal and idempotent: a revoked grant answers its first revocation. The grant record is kept.' })
  @ApiParam({ name: 'grantId', format: 'uuid' })
  @ApiHeader(ORG_HEADER)
  @ApiResponse({ status: 200, ...GRANT_VIEW })
  @ApiResponse({ status: 400, description: 'validation_error (X-Organization-Id)' })
  @ApiResponse({ status: 401, description: 'no or unknown service token' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed | organization_not_allowed' })
  @ApiResponse({ status: 404, description: "grant_not_found (also another service's or organization's grant)" })
  revoke(@CallerService() caller: string, @Req() req: Request, @Param('grantId') grantId: string) {
    return this.grants.revoke(caller, req, grantId);
  }
}
