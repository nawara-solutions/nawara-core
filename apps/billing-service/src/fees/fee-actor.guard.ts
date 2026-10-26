import { BadRequestException, CanActivate, ExecutionContext, HttpException, Inject, Injectable, Logger, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { hashServiceToken } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { notFound, operationNotPermitted } from '../domain/errors.js';
import { AuthDependencyError, OWNER_AUTHORITY, type OwnerAuthority, type VerifiedActor } from '../platforms/owner-authority.client.js';
import { isUuid } from './fee-input.js';

/** What the guard verified for this request. The bearer is kept only for the live Auth checks that follow; never logged or stored. */
export interface FeeActor extends VerifiedActor {
  bearer: string;
  /** ONE Auth budget for the whole request: every live check of this command shares it. */
  deadline: AbortSignal;
}
type FeeRequest = Request & { feeActor?: FeeActor };

const FEE_ACTOR_KIND = 'billing:fee-actor-kind';
/** Core V2 S3f: the Owner sets caps, delegates and decides; a delegated operator proposes and withdraws (S0 §1.1). */
export const FeeActorKind = (kind: 'owner' | 'operator') => SetMetadata(FEE_ACTOR_KIND, kind);

/**
 * Core V2 S3f (BIL-04 to BIL-07; A3): the human path of the fee commands. The caller's OWN bearer is verified live through Auth
 * (`/auth/grants`); its kind must be the route's. When the route names a Platform, Auth must also allow the caller on it right now
 * (`/auth/platform-access`): an Owner of its Company, or an operator with an active assignment — otherwise the collapsed 404. A service
 * token is never a human (401, never forwarded). Auth unavailable: 503, nothing written. Runs before body validation.
 */
@Injectable()
export class FeeActorGuard implements CanActivate {
  private readonly log = new Logger('BillingFeeAuthorization');
  private readonly serviceDigests: Buffer[];

  constructor(
    private readonly reflector: Reflector,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    @Inject(OWNER_AUTHORITY) private readonly auth: OwnerAuthority,
  ) {
    this.serviceDigests = config.serviceTokens.map((t) => Buffer.from(t.digest, 'hex'));
  }

  private isServiceToken(bearer: string): boolean {
    const presented = Buffer.from(hashServiceToken(bearer), 'hex');
    let match = false;
    for (const d of this.serviceDigests) if (d.length === presented.length && timingSafeEqual(presented, d)) match = true; // no early exit
    return match;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.get<'owner' | 'operator'>(FEE_ACTOR_KIND, ctx.getHandler()) ?? this.reflector.get<'owner' | 'operator'>(FEE_ACTOR_KIND, ctx.getClass());
    const req = ctx.switchToHttp().getRequest<FeeRequest>();
    const refuse = (reason: string, error: HttpException): never => {
      this.log.warn(`billing_fee_denied reason=${reason}`); // a reason class only: never the bearer, an identifier or Auth's answer
      throw error;
    };
    const match = typeof req.headers.authorization === 'string' ? /^Bearer (\S+)$/.exec(req.headers.authorization) : null;
    if (!match) return refuse('no_bearer', new UnauthorizedException());
    if (this.isServiceToken(match[1])) return refuse('service_credential', new UnauthorizedException());
    for (const p of ['platformId', 'id', 'delegationId']) {
      if (req.params[p] !== undefined && !isUuid(req.params[p] as string)) throw new BadRequestException('Validation failed (uuid is expected)'); // never sent to Auth
    }
    const deadline = AbortSignal.timeout(this.config.authTimeoutMs);
    try {
      const actor = await this.auth.actor(match[1], deadline);
      if (actor.kind !== kind) return refuse(`not_${kind}`, operationNotPermitted());
      const platformId = req.params.platformId as string | undefined;
      if (platformId !== undefined && !(await this.auth.platformAllowed(match[1], platformId.toLowerCase(), deadline))) return refuse('platform_not_allowed', notFound());
      req.feeActor = { ...actor, bearer: match[1], deadline };
      return true;
    } catch (e) {
      if (e instanceof AuthDependencyError) return refuse(e.failure, e);
      if (e instanceof UnauthorizedException) return refuse('auth_refused_bearer', e);
      throw e;
    }
  }
}

export const VerifiedFeeActor = createParamDecorator((_: unknown, ctx: ExecutionContext): FeeActor => ctx.switchToHttp().getRequest<FeeRequest>().feeActor!);
