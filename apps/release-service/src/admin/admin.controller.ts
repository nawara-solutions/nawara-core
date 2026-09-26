import { Body, Controller, Header, Headers, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { COMPONENT_KINDS, RELEASE_STATUSES } from '../domain/model.js';
import { CANONICAL_VERSION, MAX_VERSION_LENGTH } from '../domain/version.js';
import { AdminService } from './admin.service.js';
import { Owner, OwnerGuard, type VerifiedOwner } from './owner.guard.js';

const STEP_UP_HEADER = 'x-step-up-token';

/** The policy change: exactly the new minimum and the version the owner last saw. Any other field is refused (the kit DTO whitelist). */
export class ChangePolicyDto {
  @ApiProperty({ example: '2.0.0', maxLength: MAX_VERSION_LENGTH, description: 'A published, not withdrawn, STABLE release of this component. Canonical SemVer; never normalized.' })
  @IsString()
  @MaxLength(MAX_VERSION_LENGTH)
  @Matches(CANONICAL_VERSION)
  minimumVersion!: string;

  @ApiProperty({ example: 1, minimum: 0, description: 'The policyVersion you last read (0 when the component has no policy). A stale value is 409 policy_conflict: nothing is overwritten.' })
  @IsInt()
  @Min(0)
  @Max(2_147_483_646)
  expectedPolicyVersion!: number;
}

class WithdrawnDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() product!: string;
  @ApiProperty() component!: string;
  @ApiProperty({ enum: COMPONENT_KINDS }) kind!: string;
  @ApiProperty() version!: string;
  @ApiProperty({ enum: RELEASE_STATUSES }) status!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) publishedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) withdrawnAt!: string | null;
  @ApiProperty({ description: 'false: already withdrawn; nothing was written and no audit record was added.' }) changed!: boolean;
}

class PolicyDto {
  @ApiProperty() product!: string;
  @ApiProperty() component!: string;
  @ApiProperty({ enum: COMPONENT_KINDS.filter((k) => k !== 'backend') }) kind!: string;
  @ApiProperty() policyVersion!: number;
  @ApiProperty() minimumVersion!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ description: 'false: this minimum was already in effect; no policy version and no audit record were added.' }) changed!: boolean;
}

const PRODUCT = { name: 'product', description: 'Product registry key.', example: 'example-product' };
const COMPONENT = { name: 'component', description: 'Component registry key.', example: 'mobile-app' };
const AUTH_401 = { status: 401, description: 'no bearer, a bearer Auth refuses (expired, revoked, blocked), or a SERVICE token (CI is never a human; never forwarded to Auth)' };
const AUTH_403 = { status: 403, description: 'operation_not_allowed: not the owner of the operating Company (a member, an operator or another Company\'s owner: one answer) | step_up_required: no, invalid, expired, reused, wrong-purpose or wrong-session proof' };
const AUTH_503 = { status: 503, description: 'auth_timeout | auth_unavailable: Auth could not verify the caller or the step-up; nothing was changed' };

/**
 * Stage 20.4 (ADR-0051 decision 8): the owner's Release Management administration. Human only: the caller's own Auth bearer, verified live,
 * as the owner of the configured operating Company, plus a mandatory factor step-up per operation. No CI, operator or member route; no
 * public compatibility read (20.5).
 */
@ApiTags('owner administration')
@ApiBearerAuth()
@Controller('release/admin/products/:product/components/:component')
@UseGuards(OwnerGuard) // the verified owner BEFORE body validation
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Post('releases/:version/withdraw')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Withdraw a published release (owner of the operating Company, factor step-up "release.withdraw").',
    description: 'published → withdrawn. The release stays as history, is never latest again and is never republished; clients running it ' +
      'are required to update (20.5). Refused (409 would_break_minimum) when it would leave the minimum above the new latest: lower the ' +
      'minimum first. A registered, never published release is not withdrawable (409 invalid_transition). Already withdrawn: 200 with ' +
      '`changed: false`, nothing written (a valid step-up is still required and consumed). Records `release.withdrawn` with the owner as actor.',
  })
  @ApiParam(PRODUCT)
  @ApiParam(COMPONENT)
  @ApiParam({ name: 'version', example: '3.0.0' })
  @ApiHeader({ name: STEP_UP_HEADER, required: true, description: 'Step-up proof for purpose "release.withdraw" (POST /auth/admin/step-up, TOTP or passkey), consumed through Auth.' })
  @ApiResponse({ status: 200, type: WithdrawnDto })
  @ApiResponse({ status: 400, description: 'validation_error: malformed key or version' })
  @ApiResponse(AUTH_401)
  @ApiResponse(AUTH_403)
  @ApiResponse({ status: 404, description: 'release_not_found' })
  @ApiResponse({ status: 409, description: 'invalid_transition (registered, never published) | would_break_minimum' })
  @ApiResponse(AUTH_503)
  withdraw(@Owner() owner: VerifiedOwner, @Param('product') product: string, @Param('component') component: string, @Param('version') version: string,
    @Headers(STEP_UP_HEADER) stepUp: string | undefined) {
    return this.admin.withdraw(owner, product, component, version, stepUp);
  }

  @Post('compatibility-policy')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Change a client component\'s minimum supported version (owner of the operating Company, factor step-up "compatibility_policy.change").',
    description: 'Appends the next policy version (history is never rewritten). The minimum must be a published, not withdrawn, stable ' +
      'release of this component, so it never exceeds the latest (the database re-checks under the component lock). The same minimum ' +
      'again: 200 with `changed: false`, nothing written (a valid step-up is still required and consumed). Records ' +
      '`compatibility_policy.changed` with the owner as actor.',
  })
  @ApiParam(PRODUCT)
  @ApiParam(COMPONENT)
  @ApiBody({ type: ChangePolicyDto })
  @ApiHeader({ name: STEP_UP_HEADER, required: true, description: 'Step-up proof for purpose "compatibility_policy.change" (TOTP or passkey), consumed through Auth.' })
  @ApiResponse({ status: 200, type: PolicyDto })
  @ApiResponse({ status: 400, description: 'validation_error: malformed key, version, a pre-release minimum, a bad expectedPolicyVersion, or an unexpected field' })
  @ApiResponse(AUTH_401)
  @ApiResponse(AUTH_403)
  @ApiResponse({ status: 404, description: 'component_not_found' })
  @ApiResponse({ status: 409, description: 'policy_conflict (stale expectedPolicyVersion or a concurrent change) | invalid_minimum (not a published, not withdrawn release of this component) | minimum_above_latest | policy_not_applicable (backend)' })
  @ApiResponse(AUTH_503)
  changePolicy(@Owner() owner: VerifiedOwner, @Param('product') product: string, @Param('component') component: string, @Body() body: ChangePolicyDto,
    @Headers(STEP_UP_HEADER) stepUp: string | undefined) {
    return this.admin.changePolicy(owner, product, component, body, stepUp);
  }
}
