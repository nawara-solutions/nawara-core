import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { ReleaseConfig } from '../config/release-config.js';
import { RELEASE_CONFIG } from '../config/release-config.token.js';
import { CompatibilityService } from './compatibility.service.js';

class DecisionDto {
  @ApiProperty({ enum: ['required', 'available', 'none'], description: 'required: stop using this build (withdrawn or below the minimum); available: a newer release exists (optional); none: up to date. Supported ⟺ update ≠ required (derived; never sent).' })
  update!: string;

  @ApiPropertyOptional({ enum: ['withdrawn', 'below_minimum'], description: 'Present only with update = required. withdrawn wins when both hold.' })
  reason?: string;

  @ApiProperty({ nullable: true, type: String, description: 'The highest published, not withdrawn, stable release (null when none). NEVER a downgrade target: an installed client updates only to a version above its own.' })
  latestVersion!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'The current minimum supported version (null when the component has no policy).' })
  minimumVersion!: string | null;
}

/**
 * Stage 20.5 (ADR-0051 decisions 7, 10): the public, read-only compatibility decision for web, desktop, iOS and Android components. No
 * authentication (clients may be pre-login); no user, device or organization input; rate-limited per client address; cacheable for a short,
 * bounded time with a strong ETag. Release Management states compatibility truth; it never updates, reloads, downloads or deploys.
 */
@ApiTags('compatibility')
@Controller('release/products/:product/components/:component/compatibility')
export class CompatibilityController {
  constructor(
    @Inject(CompatibilityService) private readonly compatibility: CompatibilityService,
    @Inject(RELEASE_CONFIG) private readonly config: ReleaseConfig,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Compatibility decision for a client build (public, read-only).',
    description: 'Is this registered release of this client component still usable? update = required | available | none. Input errors ' +
      '(invalid_version, unknown_component, unknown_release) are never a decision: a client treats them as "cannot verify this build". ' +
      'A decision carries Cache-Control: public, max-age (short, bounded) and a strong ETag; If-None-Match answers 304 while the relevant ' +
      'state (the release status, the current minimum, the latest release) is unchanged.',
  })
  @ApiParam({ name: 'product', example: 'example-product' })
  @ApiParam({ name: 'component', example: 'web-app', description: 'A web, desktop, mobile_ios or mobile_android component (a backend is not a client component).' })
  @ApiQuery({ name: 'version', required: true, example: '2.5.0', description: 'The client build\'s canonical version (SemVer, optional pre-release, no build metadata). The only query parameter.' })
  @ApiHeader({ name: 'If-None-Match', required: false, description: 'An ETag from an earlier decision: 304 while it still holds.' })
  @ApiOkResponse({ type: DecisionDto, description: 'The decision. Headers: ETag, Cache-Control: public, max-age=<RELEASE_COMPATIBILITY_MAX_AGE_S>.' })
  @ApiResponse({ status: 304, description: 'Not modified: the cached decision (same ETag) still holds.' })
  @ApiResponse({ status: 400, description: 'invalid_version (malformed or non-canonical) | validation_error (a query parameter other than version)' })
  @ApiResponse({ status: 404, description: 'unknown_component (no such product/component, or not a client component) | unknown_release (a well-formed version that is not a registered release of the component)' })
  @ApiResponse({ status: 429, description: 'rate_limited: too many requests from this client address in the current 60 s window. Not a decision.' })
  async decision(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('product') product: string, @Param('component') component: string) {
    res.setHeader('Cache-Control', 'no-store'); // an error (input, rate limit, failure) is never cached; a decision replaces this below
    const answer = await this.compatibility.answer(req, product, component);
    res.setHeader('ETag', answer.etag);
    res.setHeader('Cache-Control', `public, max-age=${this.config.compatibility.maxAgeS}`);
    if (answer.kind === 'not_modified') {
      res.status(304);
      return undefined;
    }
    return answer.decision;
  }
}
