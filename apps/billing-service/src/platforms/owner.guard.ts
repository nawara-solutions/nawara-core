import { BadRequestException, CanActivate, ExecutionContext, HttpException, Inject, Injectable, Logger, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { hashServiceToken } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { AuthDependencyError, OWNER_AUTHORITY, type OwnerAuthority, type VerifiedPlatformOwner } from './owner-authority.client.js';

type OwnerRequest = Request & { verifiedPlatformOwner?: VerifiedPlatformOwner };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Core V2 S3d (register BIL-01, AUTH-07): the human path of the Platform configuration. The caller presents their OWN Auth bearer; Auth
 * says, live, that they are an Owner, which Company is theirs, and that the Platform in the path is in it. Nothing in the request names
 * the actor, their kind or their Company. A service token is never a human: one presented here is refused (401) WITHOUT being forwarded
 * to Auth. Runs before body validation, so a refused caller learns nothing more. No step-up (the Owner's Q11 decision for S3d).
 */
@Injectable()
export class PlatformOwnerGuard implements CanActivate {
  private readonly log = new Logger('BillingPlatformAuthorization');
  private readonly serviceDigests: Buffer[];

  constructor(
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    @Inject(OWNER_AUTHORITY) private readonly auth: OwnerAuthority,
  ) {
    this.serviceDigests = config.serviceTokens.map((t) => Buffer.from(t.digest, 'hex'));
  }

  private isServiceToken(bearer: string): boolean {
    const presented = Buffer.from(hashServiceToken(bearer), 'hex');
    let match = false;
    for (const d of this.serviceDigests) if (d.length === presented.length && timingSafeEqual(presented, d)) match = true; // every digest, no early exit
    return match;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<OwnerRequest>();
    const refuse = (reason: string, error: HttpException): never => {
      this.log.warn(`billing_platform_denied reason=${reason}`); // a reason class only: never the bearer, the Platform or Auth's answer
      throw error;
    };
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
    if (!match) return refuse('no_bearer', new UnauthorizedException());
    if (this.isServiceToken(match[1])) return refuse('service_credential', new UnauthorizedException()); // a service is never the Owner
    const platformId = req.params.platformId;
    if (typeof platformId !== 'string' || !UUID.test(platformId)) throw new BadRequestException('Validation failed (uuid is expected)'); // never sent to Auth
    try {
      req.verifiedPlatformOwner = await this.auth.verifyPlatformOwner(match[1], platformId.toLowerCase(), AbortSignal.timeout(this.config.authTimeoutMs));
      return true;
    } catch (e) {
      if (e instanceof AuthDependencyError) return refuse(e.failure, e);
      if (e instanceof UnauthorizedException) return refuse('auth_refused_bearer', e);
      if (e instanceof HttpException && e.getStatus() === 403) return refuse('not_an_owner', e);
      if (e instanceof HttpException && e.getStatus() === 404) return refuse('platform_not_in_company', e);
      throw e;
    }
  }
}

/** Parameter decorator: the Owner (and their Company) the guard verified for this request. */
export const PlatformOwner = createParamDecorator((_: unknown, ctx: ExecutionContext): VerifiedPlatformOwner => ctx.switchToHttp().getRequest<OwnerRequest>().verifiedPlatformOwner!);
