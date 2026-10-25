import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CallerService, ServiceTokenGuard, RequireServiceOperation, ServiceOperationGuard } from '@nawara/service-kit';
import { OrganizationScopeService } from '../admission/organization-scope.service.js';
import { notFound } from '../domain/errors.js';
import { representEntitlement } from './entitlement.representation.js';
import { PersonalSubscriptionRepository } from './personal-subscription.repository.js';

/**
 * Core V2 S3c (ADR-0044 B6; register BIL-11, frozen): a user's Personal Subscription entitlement to one Platform's personal product.
 * Service-to-service only, like the Organization read: the product backend has established its own authenticated user first and asks
 * Billing only for the commercial answer. The Platform is the caller's own (its explicit `allowedPlatforms`); the product must be a
 * personal subscription product of that Platform (anything else is the one `404 not_found`). A user with no purchase, or with no period
 * covering now, is `{ valid: false, expiresAt: null }`. Consumers treat an unavailable answer as not entitled. No Personal grace (B13.2).
 */
@ApiTags('entitlement')
@Controller('billing/users')
export class PersonalEntitlementController {
  constructor(private readonly personal: PersonalSubscriptionRepository, private readonly scope: OrganizationScopeService) {}

  @Get(':userId/platforms/:platformId/products/:productId/entitlement')
  @UseGuards(ServiceTokenGuard, ServiceOperationGuard)
  @RequireServiceOperation('entitlement.read')
  @ApiBearerAuth()
  @ApiOperation({ summary: "A user's Personal Subscription entitlement to one Platform's personal product (service-to-service only)" })
  @ApiParam({ name: 'userId', description: 'The Auth user (the beneficiary)' })
  @ApiParam({ name: 'platformId', format: 'uuid' })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiResponse({ status: 200, description: '{ valid: boolean, expiresAt: string | null } — the ONLY shape' })
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403, description: 'operation_not_permitted / platform_not_permitted (the Platform is not the caller\'s)' })
  @ApiResponse({ status: 404, description: 'not_found: not a personal subscription product of that Platform' })
  async get(
    @CallerService() caller: string,
    @Param('userId') userId: string,
    @Param('platformId', new ParseUUIDPipe()) platformId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
  ) {
    this.scope.assertPlatformInScope(caller, platformId.toLowerCase());
    if (!(await this.personal.isPersonalProduct(platformId.toLowerCase(), productId.toLowerCase()))) throw notFound();
    return representEntitlement(await this.personal.entitlement(userId, platformId.toLowerCase(), productId.toLowerCase(), new Date()));
  }
}
