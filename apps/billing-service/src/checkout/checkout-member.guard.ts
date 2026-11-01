import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthIdentity } from '@nawara/service-kit';
import { MemberVerifier } from '../auth/verified-member.js';
import { billingError } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';

type CheckoutRequest = Request & { checkoutMember?: AuthIdentity };

/**
 * Core V2 S3f (BIL-10; FC-12; OD-01 as the Owner's B6; AUTH-07): the buyer is the caller's OWN bearer, verified LIVE through `/auth/me` on
 * every request (Billing's existing Auth client): an unknown or revoked bearer is 401; an inactive user, an Owner or an Operator (an admin
 * tier) is 403 `member_not_eligible`; Auth unavailable is 503 (the kit client fails closed). A service token is never a buyer (401, never
 * forwarded to Auth). Nothing in the request can name the buyer. The rule itself is `MemberVerifier`, shared with BIL-12.
 */
@Injectable()
export class CheckoutMemberGuard implements CanActivate {
  private readonly log = new Logger('BillingCheckoutAuthorization');

  constructor(private readonly members: MemberVerifier) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<CheckoutRequest>();
    const check = await this.members.check(req.headers.authorization);
    if (check.ok) {
      req.checkoutMember = check.identity;
      return true;
    }
    if (check.reason === 'no_bearer' || check.reason === 'unknown_bearer') throw new UnauthorizedException();
    this.log.warn(`billing_checkout_denied reason=${check.reason}`);
    if (check.reason === 'service_credential') throw new UnauthorizedException();
    throw billingError(403, 'member_not_eligible', BILLING_MESSAGES.memberNotEligible);
  }
}

export const CheckoutMember = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthIdentity => ctx.switchToHttp().getRequest<CheckoutRequest>().checkoutMember!);
