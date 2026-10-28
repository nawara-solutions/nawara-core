import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Logger, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { hashServiceToken } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { operationNotPermitted } from '../domain/errors.js';
import { AuthDependencyError, OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';

/** The Owner Auth verified live for this request: their Company, and their own bearer for the per-case Platform check. */
export interface VerifiedRefundOwner {
  userId: string;
  companyId: string;
  bearer: string;
}

type OwnerRequest = Request & { refundOwner?: VerifiedRefundOwner };

/**
 * Core V2 S6a (register BIL-23, BIL-25; R6A-2): the refund-case routes are the Owner's only. The caller presents their OWN Auth bearer;
 * Auth says, live (`/auth/grants`), that they are an Owner and which Company is theirs. An operator or a member (an Organization
 * administrator included) is 403 `operation_not_permitted`; a service token is never a human (401, never forwarded to Auth); Auth
 * unanswerable is 503. No step-up (R6A-7): refund authorization is the separate, factor-only refund-authorization step-up (Auth's own purpose, S6b) (S6b). The case's
 * seller Company and Platform are checked per request by `RefundCaseService`.
 */
@Injectable()
export class RefundOwnerGuard implements CanActivate {
  private readonly log = new Logger('BillingRefundAuthorization');
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
    for (const d of this.serviceDigests) if (d.length === presented.length && timingSafeEqual(presented, d)) match = true; // no early exit
    return match;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<OwnerRequest>();
    const refuse = (reason: string, error: HttpException): never => {
      this.log.warn(`billing_refund_owner_denied reason=${reason}`); // a reason class only: never the bearer or Auth's answer
      throw error;
    };
    const match = typeof req.headers.authorization === 'string' ? /^Bearer (\S+)$/.exec(req.headers.authorization) : null;
    if (!match) return refuse('no_bearer', new UnauthorizedException());
    if (this.isServiceToken(match[1])) return refuse('service_credential', new UnauthorizedException());
    try {
      const actor = await this.auth.actor(match[1], AbortSignal.timeout(this.config.authTimeoutMs));
      if (actor.kind !== 'owner' || !actor.companyId) return refuse('not_an_owner', operationNotPermitted());
      req.refundOwner = { userId: actor.userId, companyId: actor.companyId, bearer: match[1] };
      return true;
    } catch (e) {
      if (e instanceof AuthDependencyError) return refuse(e.failure, e);
      if (e instanceof UnauthorizedException) return refuse('auth_refused_bearer', e);
      throw e;
    }
  }
}

export const RefundOwner = createParamDecorator((_: unknown, ctx: ExecutionContext): VerifiedRefundOwner => ctx.switchToHttp().getRequest<OwnerRequest>().refundOwner!);
