import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ServiceTokenGuard } from '@nawara/service-kit';
import { RequireCapability, Scope, type ServiceScope } from '../authorization/capability.js';
import { PlatformScopeService } from '../authorization/platform-scope.service.js';
import { ServicePolicyGuard } from '../authorization/service-policy.guard.js';
import { inScope } from '../authorization/service-policy.js';
import { notFound } from '../domain/errors.js';

/**
 * The reference read (ADR-0042 decision 5): ids and parents ONLY. It is how Billing and Payment learn, server-side, which Platform an
 * asserted organization belongs to. Organization Service resolves organization -> platform from its own hierarchy and answers only when
 * that Platform is inside the caller's EXPLICIT scope; anything else is a collapsed 404, so the endpoint is no existence oracle. No name,
 * tax code, address or key is ever returned here.
 */
@ApiTags('reference')
@ApiBearerAuth()
@UseGuards(ServiceTokenGuard, ServicePolicyGuard)
@Controller('organization/reference')
export class ReferenceController {
  constructor(private readonly scope: PlatformScopeService) {}

  @Get('organizations/:id')
  @RequireCapability('hierarchy.reference.read')
  @ApiOperation({ summary: 'Resolve an organization to its platform and company (ids only), inside the caller\'s Platform scope.' })
  @ApiResponse({ status: 200, description: '{ organizationId, platformId, companyId }' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'the caller is not admitted for the reference read' })
  @ApiResponse({ status: 404, description: 'collapsed: unknown, or outside the caller\'s Platform scope' })
  @ApiResponse({ status: 409, description: 'not_authoritative: reference reads open once organization-service is authoritative' })
  async organization(@Param('id', new ParseUUIDPipe()) id: string, @Scope() scope: ServiceScope) {
    const r = await this.scope.resolveOrganization(id);
    if (!r || !inScope(scope.allowedPlatforms, r.platformId)) throw notFound();
    return r;
  }
}
