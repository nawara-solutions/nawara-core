import { CanActivate, ExecutionContext, Inject, Injectable, Logger, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AUTH_CLIENT, hashServiceToken, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';

type AssistanceRequestContext = Request & { assistanceUser?: AuthIdentity };

/**
 * Core V2 S5a (D-2, D-5, D-10): every assistance route acts for the caller's OWN bearer, verified LIVE through `/auth/me` on every request:
 * an unknown or revoked bearer is 401; Auth unavailable is 503 (the kit client fails closed, nothing is read or written). A service token
 * is never an assistance actor (401, never forwarded to Auth). The guard only establishes WHO calls; what they may do (beneficiary,
 * Organization actor, nothing) is decided per request by `AssistanceAuthority` from this live identity, so an Owner or Operator reaches
 * the same collapsed answers as any other caller without a relation.
 */
@Injectable()
export class AssistanceUserGuard implements CanActivate {
  private readonly log = new Logger('BillingAssistanceAuthorization');
  private readonly serviceDigests: Buffer[];

  constructor(
    @Inject(BILLING_CONFIG) config: BillingConfig,
    @Inject(AUTH_CLIENT) private readonly auth: AuthClient,
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
    const req = ctx.switchToHttp().getRequest<AssistanceRequestContext>();
    const match = typeof req.headers.authorization === 'string' ? /^Bearer (\S+)$/.exec(req.headers.authorization) : null;
    if (!match) throw new UnauthorizedException();
    if (this.isServiceToken(match[1])) {
      this.log.warn('billing_assistance_denied reason=service_credential');
      throw new UnauthorizedException();
    }
    const identity = await this.auth.getIdentity(match[1]);
    if (!identity) throw new UnauthorizedException();
    req.assistanceUser = identity;
    return true;
  }
}

export const AssistanceUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthIdentity => ctx.switchToHttp().getRequest<AssistanceRequestContext>().assistanceUser!);
