import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ServiceTokenGuard } from '@nawara/service-kit';
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
  constructor(private readonly effectiveAccess: EffectiveAccessService) {}

  @Get(':organizationId/entitlement')
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Effective commercial access for an Organization (service-to-service only). No Subscription, a pending/expired/terminated one, or an ' +
      'elapsed grace window are all normal outcomes (`valid: false`), never a 404 or a transport error. `valid: true` while inside grace or ' +
      'before an early termination boundary reflects the same derivation Stage 12.3 already proves exhaustively; this endpoint only exposes it.',
  })
  @ApiResponse({ status: 200, description: '{ valid: boolean, expiresAt: string | null } — the ONLY shape; never the underlying Subscription.' })
  @ApiResponse({ status: 401 })
  async get(@Param('organizationId', new ParseUUIDPipe()) organizationId: string) {
    const entitlement = await this.effectiveAccess.getEffectiveAccess(organizationId, new Date());
    return representEntitlement(entitlement);
  }
}
