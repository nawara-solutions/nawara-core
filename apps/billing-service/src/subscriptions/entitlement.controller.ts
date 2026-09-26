import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CallerService, ServiceTokenGuard, RequireServiceOperation, ServiceOperationGuard } from '@nawara/service-kit';
import { OrganizationScopeService } from '../admission/organization-scope.service.js';
import { EffectiveAccessService } from './effective-access.service.js';
import { representEntitlement } from './entitlement.representation.js';

/**
 * Stage 12.5: Billing's effective-access contract (ADR-0038's "entitlement-status API"). Internal, service-to-service
 * only (SDD/ADR-0033 service tokens) — this is not a user-facing route: a product backend establishes its own
 * authenticated user, membership and authorization first, and asks Billing only for the commercial answer. This
 * answers "does this Organization currently have effective commercial access", never "can user X do Y" (section 5) —
 * authorization and entitlement remain two separate concerns a caller composes itself.
 */
@ApiTags('entitlement')
@Controller('billing/organizations')
export class EntitlementController {
  constructor(private readonly effectiveAccess: EffectiveAccessService, private readonly organizationScope: OrganizationScopeService) {}

  @Get(':organizationId/entitlement')
  @UseGuards(ServiceTokenGuard, ServiceOperationGuard)
  @RequireServiceOperation('entitlement.read')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Effective commercial access for an Organization (service-to-service only). No Subscription, a pending/expired/terminated one, or an ' +
      'elapsed grace window are all normal outcomes (`valid: false`), never a 404 or a transport error. `valid: true` while inside grace or ' +
      'before an early termination boundary reflects the same derivation Stage 12.3 already proves exhaustively; this endpoint only exposes it.',
  })
  @ApiResponse({ status: 200, description: '{ valid: boolean, expiresAt: string | null } — the ONLY shape; never the underlying Subscription.' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted / organization_not_permitted (unknown or outside the caller\'s Platform scope: one answer)' })
  @ApiResponse({ status: 503, description: 'hierarchy_unavailable: the organization\'s Platform could not be verified. Treat as UNKNOWN, never as entitled' })
  async get(@CallerService() caller: string, @Param('organizationId', new ParseUUIDPipe()) organizationId: string) {
    // Stage 21.C.2 (ADR-0052 decision 3, Q5): the Organization is a caller-supplied path value, not a record the caller owns, so its
    // Platform must be resolved and inside the caller's scope before any commercial state is disclosed (fails closed).
    await this.organizationScope.assertInScope(caller, organizationId);
    const entitlement = await this.effectiveAccess.getEffectiveAccess(organizationId, new Date());
    return representEntitlement(entitlement);
  }
}
