import { Body, Controller, Header, HttpCode, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import { BUILD_ID, COMPONENT_KINDS, NOTES_REF, RELEASE_STATUSES, SOURCE_REVISION, type ComponentKind } from '../domain/model.js';
import { CANONICAL_VERSION, MAX_VERSION_LENGTH } from '../domain/version.js';
import { RequireCapability, ReleasePolicyGuard } from '../policy/release-policy.guard.js';
import { AutomationService, type AutomationResult } from './automation.service.js';

/**
 * The registration body: exactly the Stage 20.2 release identity plus the component's kind. Any other field (an environment, a channel,
 * an artifact, a signing key, an organization, a user, a flag…) is refused by the kit's DTO whitelist (400).
 */
export class RegisterReleaseDto {
  @ApiProperty({ enum: COMPONENT_KINDS, description: 'The component\'s kind. Fixed when the component is first registered; a different kind later is 409 component_kind_conflict.' })
  @IsIn(COMPONENT_KINDS)
  kind!: ComponentKind;

  @ApiProperty({ example: '1.4.0', maxLength: MAX_VERSION_LENGTH, description: 'Canonical SemVer 2.0, optional pre-release, NO build metadata, no leading "v" or zeros. Never normalized.' })
  @IsString()
  @MaxLength(MAX_VERSION_LENGTH)
  @Matches(CANONICAL_VERSION)
  version!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 128, example: '1400', description: 'Native build identity (iOS build number, Android versionCode, CI build number). Stored, never compared.' })
  @IsOptional()
  @IsString()
  @Matches(BUILD_ID)
  buildId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'a1b2c3d4e5f6', description: 'Source revision (lowercase hexadecimal commit id, 7–64). Traceability only.' })
  @IsOptional()
  @IsString()
  @Matches(SOURCE_REVISION)
  sourceRevision?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 512, description: 'Reference to release notes (URL or document id). Never fetched.' })
  @IsOptional()
  @IsString()
  @Matches(NOTES_REF)
  notesRef?: string | null;
}

class ReleaseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'example-product' }) product!: string;
  @ApiProperty({ example: 'mobile-app' }) component!: string;
  @ApiProperty({ enum: COMPONENT_KINDS }) kind!: string;
  @ApiProperty({ example: '1.4.0' }) version!: string;
  @ApiProperty({ nullable: true, type: String }) buildId!: string | null;
  @ApiProperty({ nullable: true, type: String }) sourceRevision!: string | null;
  @ApiProperty({ nullable: true, type: String }) notesRef!: string | null;
  @ApiProperty({ enum: RELEASE_STATUSES }) status!: string;
  @ApiProperty({ format: 'date-time' }) registeredAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) publishedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) withdrawnAt!: string | null;
}

const PRODUCT = { name: 'product', description: 'Product registry key. The caller\'s policy must grant the capability for THIS product.', example: 'example-product' };
const COMPONENT = { name: 'component', description: 'Component registry key (`^[a-z][a-z0-9-]{0,62}$`).', example: 'mobile-app' };
const REPLAYED = { name: 'Idempotent-Replayed', description: '`true` when the request changed nothing (a retry): no audit record was written.' };

/**
 * Stage 20.3 (ADR-0051 §8): the CI automation API. Service token only (ADR-0033); the per-product policy (ADR-0042) decides. There is no
 * list, read-all, withdrawal, minimum-version, public compatibility or deployment route here (20.4 / 20.5 / never).
 */
@ApiTags('automation')
@ApiBearerAuth()
@Controller('release/products/:product/components/:component/releases')
@UseGuards(ServiceTokenGuard, ReleasePolicyGuard) // authentication, then the per-product policy, then (the kit pipe) body validation
export class AutomationController {
  constructor(@Inject(AutomationService) private readonly automation: AutomationService) {}

  @Post()
  @RequireCapability('release.register')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Register a release (capability release.register for the product). Idempotent on (component, version).',
    description: 'Declares that a build exists: status `registered`, not yet offered to clients. The component is created on its first ' +
      'registration with the given kind. The same identity again answers 200 with `Idempotent-Replayed: true` and writes nothing; the ' +
      'same version with a different buildId / sourceRevision / notesRef is 409 and never overwrites. First registration records the ' +
      'audit action `release.registered` (actor: this service) in the same transaction.',
  })
  @ApiParam(PRODUCT)
  @ApiParam(COMPONENT)
  @ApiBody({ type: RegisterReleaseDto })
  @ApiResponse({ status: 201, type: ReleaseDto, description: 'Registered now.' })
  @ApiResponse({ status: 200, type: ReleaseDto, description: 'Already registered with the same identity (in any status): nothing changed.', headers: { [REPLAYED.name]: { description: REPLAYED.description } } })
  @ApiResponse({ status: 400, description: 'validation_error: malformed key, kind, version, build id, revision, notes reference, or an unexpected field' })
  @ApiResponse({ status: 401, description: 'no, malformed or unknown service token (a user bearer is never a service token)' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed (no release.register at all) | product_not_allowed (not for this product; unknown products answer the same)' })
  @ApiResponse({ status: 409, description: 'component_kind_conflict | release_conflict (this version exists with a different identity)' })
  async register(
    @CallerService() caller: string, @Param('product') product: string, @Param('component') component: string, @Body() body: RegisterReleaseDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.automation.register(caller, product, component, body), 201);
  }

  @Post(':version/publish')
  @RequireCapability('release.publish')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Publish a registered release (capability release.publish for the product). Idempotent.',
    description: 'registered → published: the release may become the latest version clients are offered. Publishing an already ' +
      'published release answers 200 with `Idempotent-Replayed: true` and writes nothing; a withdrawn release is never republished ' +
      '(409). Records the audit action `release.published` (actor: this service) in the same transaction.',
  })
  @ApiParam(PRODUCT)
  @ApiParam(COMPONENT)
  @ApiParam({ name: 'version', description: 'The registered canonical version.', example: '1.4.0' })
  @ApiResponse({ status: 200, type: ReleaseDto, description: 'Published (now, or already: see Idempotent-Replayed).', headers: { [REPLAYED.name]: { description: REPLAYED.description } } })
  @ApiResponse({ status: 400, description: 'validation_error: malformed component key or version' })
  @ApiResponse({ status: 401, description: 'no, malformed or unknown service token' })
  @ApiResponse({ status: 403, description: 'operation_not_allowed (no release.publish at all) | product_not_allowed (not for this product; unknown products answer the same)' })
  @ApiResponse({ status: 404, description: 'release_not_found: no such component or version in this product' })
  @ApiResponse({ status: 409, description: 'invalid_transition: the release is withdrawn' })
  async publish(
    @CallerService() caller: string, @Param('product') product: string, @Param('component') component: string, @Param('version') version: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.automation.publish(caller, product, component, version), 200);
  }
}

function reply(res: Response, result: AutomationResult, changedStatus: number) {
  res.status(result.changed ? changedStatus : 200);
  if (!result.changed) res.setHeader('Idempotent-Replayed', 'true');
  return result.release;
}
