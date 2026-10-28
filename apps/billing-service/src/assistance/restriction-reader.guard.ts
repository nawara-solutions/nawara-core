import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AUTH_CLIENT, hashServiceToken, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';

/** Who reads an Organization's restrictions: a service (its policy name) or a human with their own live identity and bearer. */
export type RestrictionReader = { kind: 'service'; service: string } | { kind: 'user'; identity: AuthIdentity; bearer: string };

type ReaderRequest = Request & { serviceCaller?: string; caller?: { kind: 'user' }; restrictionReader?: RestrictionReader };

/**
 * Core V2 S5d (register BIL-26; S5D-6): authenticates the two caller kinds of the restriction read, before anything is read.
 *   - a SERVICE token (compared against every registered digest, no early exit) names its caller; the kit's `ServiceOperationGuard` that
 *     follows admits it only with the exact `restriction.read` operation in its explicit policy (no wildcard, no prefix);
 *   - any other bearer is the caller's OWN, verified live through `/auth/me` (unknown or revoked: 401; Auth unavailable: 503, nothing read).
 *     What that human may read (an Owner of the Platform, the Organization actor, or nothing) is decided per request by the service.
 */
@Injectable()
export class RestrictionReaderGuard implements CanActivate {
  private readonly services: Array<{ caller: string; digest: Buffer }>;

  constructor(
    @Inject(BILLING_CONFIG) config: BillingConfig,
    @Inject(AUTH_CLIENT) private readonly auth: AuthClient,
  ) {
    this.services = config.serviceTokens.map((t) => ({ caller: t.caller, digest: Buffer.from(t.digest, 'hex') }));
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ReaderRequest>();
    const match = typeof req.headers.authorization === 'string' ? /^Bearer (\S+)$/.exec(req.headers.authorization) : null;
    if (!match) throw new UnauthorizedException();
    const presented = Buffer.from(hashServiceToken(match[1]), 'hex');
    let service: string | undefined;
    for (const s of this.services) if (s.digest.length === presented.length && timingSafeEqual(presented, s.digest)) service = s.caller;
    if (service) {
      req.serviceCaller = service;
      req.restrictionReader = { kind: 'service', service };
      return true;
    }
    const identity = await this.auth.getIdentity(match[1]);
    if (!identity) throw new UnauthorizedException();
    req.caller = { kind: 'user' }; // the kit's ServiceOperationGuard admits a human; the service decides their relation
    req.restrictionReader = { kind: 'user', identity, bearer: match[1] };
    return true;
  }
}

export const Reader = createParamDecorator((_: unknown, ctx: ExecutionContext): RestrictionReader => ctx.switchToHttp().getRequest<ReaderRequest>().restrictionReader!);
