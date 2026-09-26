import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Logger, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { hashServiceToken } from '@nawara/service-kit';
import type { ReleaseConfig } from '../config/release-config.js';
import { RELEASE_CONFIG } from '../config/release-config.token.js';
import { AuthDependencyError, OWNER_AUTHORITY, type OwnerAuthority } from './owner-authority.client.js';

/** What the guard established for this request. The bearer is kept only for the step-up call that follows; never logged or stored. */
export interface VerifiedOwner {
  userId: string;
  bearer: string;
  /** ONE Auth budget for the whole request (Stage 19.5): the owner check and the step-up share it. */
  deadline: AbortSignal;
}
type OwnerRequest = Request & { verifiedOwner?: VerifiedOwner };

/**
 * Stage 20.4 (ADR-0051 decision 8, ADR-0050 decision 1): the human path. The caller presents their OWN Auth bearer; Auth says, from live
 * state, who they are and whether they own a Company; only the owner of the configured operating Company passes. Nothing in the request
 * (a header, a body field, a path value) can name the actor, their kind or their Company. A service token is never a human: one presented
 * here is refused (401) WITHOUT being forwarded to Auth. Runs before body validation, so a refused caller learns nothing more.
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  private readonly log = new Logger('ReleaseAdminAuthorization');
  private readonly serviceDigests: Buffer[];

  constructor(
    @Inject(RELEASE_CONFIG) private readonly config: ReleaseConfig,
    @Inject(OWNER_AUTHORITY) private readonly auth: OwnerAuthority,
  ) {
    this.serviceDigests = config.serviceTokens.map((t) => Buffer.from(t.digest, 'hex'));
  }

  private isServiceToken(bearer: string): boolean {
    const presented = Buffer.from(hashServiceToken(bearer), 'hex');
    let match = false;
    for (const d of this.serviceDigests) if (timingSafeEqual(presented, d)) match = true; // every digest, no early exit
    return match;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<OwnerRequest>();
    const operation = String(ctx.getHandler().name) === 'withdraw' ? 'withdraw' : 'policy_change';
    const refuse = (outcome: string, reason: string, error: HttpException): never => {
      this.log.warn(`release_admin_denied operation=${operation} outcome=${outcome} reason=${reason}`);
      throw error;
    };
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
    if (!match) return refuse('unauthenticated', 'no_bearer', new UnauthorizedException());
    if (this.isServiceToken(match[1])) return refuse('unauthenticated', 'service_credential', new UnauthorizedException()); // CI is never a human
    const admin = this.config.ownerAdmin!;
    const deadline = AbortSignal.timeout(admin.authTimeoutMs);
    try {
      const userId = await this.auth.verifyOperatingOwner(match[1], admin.operatingCompanyId, deadline);
      req.verifiedOwner = { userId, bearer: match[1], deadline };
      return true;
    } catch (e) {
      if (e instanceof AuthDependencyError) return refuse(e.failure, e.failure, e);
      if (e instanceof UnauthorizedException) return refuse('unauthenticated', 'auth_refused_bearer', e);
      if (e instanceof HttpException && e.getStatus() === 403) return refuse('authority_denied', 'not_operating_owner', e);
      throw e;
    }
  }
}

/** Parameter decorator: the owner the guard verified for this request. */
export const Owner = createParamDecorator((_: unknown, ctx: ExecutionContext): VerifiedOwner => ctx.switchToHttp().getRequest<OwnerRequest>().verifiedOwner!);
