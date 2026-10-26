import { CanActivate, ExecutionContext, Inject, Injectable, Logger, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AUTH_CLIENT, hashServiceToken, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { billingError } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';

type CheckoutRequest = Request & { checkoutMember?: AuthIdentity };

/**
 * Core V2 S3f (BIL-10; FC-12; OD-01 as the Owner's B6; AUTH-07): the buyer is the caller's OWN bearer, verified LIVE through `/auth/me` on
 * every request (Billing's existing Auth client): an unknown or revoked bearer is 401; an inactive user, an Owner or an Operator (an admin
 * tier) is 403 `member_not_eligible`; Auth unavailable is 503 (the kit client fails closed). A service token is never a buyer (401, never
 * forwarded to Auth). Nothing in the request can name the buyer.
 */
@Injectable()
export class CheckoutMemberGuard implements CanActivate {
  private readonly log = new Logger('BillingCheckoutAuthorization');
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
    const req = ctx.switchToHttp().getRequest<CheckoutRequest>();
    const match = typeof req.headers.authorization === 'string' ? /^Bearer (\S+)$/.exec(req.headers.authorization) : null;
    if (!match) throw new UnauthorizedException();
    if (this.isServiceToken(match[1])) {
      this.log.warn('billing_checkout_denied reason=service_credential');
      throw new UnauthorizedException();
    }
    const identity = await this.auth.getIdentity(match[1]);
    if (!identity) throw new UnauthorizedException();
    if (!identity.isActive || identity.adminTier !== null) {
      this.log.warn(`billing_checkout_denied reason=${identity.isActive ? 'not_a_member' : 'inactive'}`);
      throw billingError(403, 'member_not_eligible', BILLING_MESSAGES.memberNotEligible);
    }
    req.checkoutMember = identity;
    return true;
  }
}

export const CheckoutMember = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthIdentity => ctx.switchToHttp().getRequest<CheckoutRequest>().checkoutMember!);
