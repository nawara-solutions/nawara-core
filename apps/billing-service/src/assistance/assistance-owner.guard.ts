import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Logger, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { hashServiceToken } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import { operationNotPermitted } from '../domain/errors.js';
import { AuthDependencyError, OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import type { VerifiedAssistanceOwner } from './assistance-resolution.service.js';

type OwnerRequest = Request & { assistanceOwner?: VerifiedAssistanceOwner };

/**
 * Core V2 S5c (register BIL-19, BIL-22; the Owner's H-6): the Owner path of assistance corrections and dispute resolutions. The caller
 * presents their OWN Auth bearer; Auth says, live (`/auth/grants`), that they are an Owner. An operator or a member is 403
 * `operation_not_permitted` (no Operator exercises this authority); a service token is never a human (401, never forwarded to Auth); Auth
 * unanswerable is 503. Runs before any body is read. The request's Platform (live `/auth/platform-access`) and the step-up are checked per
 * command by `AssistanceResolutionService`.
 */
@Injectable()
export class AssistanceOwnerGuard implements CanActivate {
  private readonly log = new Logger('BillingAssistanceAuthorization');
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
      this.log.warn(`billing_assistance_owner_denied reason=${reason}`); // a reason class only: never the bearer or Auth's answer
      throw error;
    };
    const match = typeof req.headers.authorization === 'string' ? /^Bearer (\S+)$/.exec(req.headers.authorization) : null;
    if (!match) return refuse('no_bearer', new UnauthorizedException());
    if (this.isServiceToken(match[1])) return refuse('service_credential', new UnauthorizedException());
    try {
      const actor = await this.auth.actor(match[1], AbortSignal.timeout(this.config.authTimeoutMs));
      if (actor.kind !== 'owner') return refuse('not_an_owner', operationNotPermitted());
      req.assistanceOwner = { userId: actor.userId, bearer: match[1] };
      return true;
    } catch (e) {
      if (e instanceof AuthDependencyError) return refuse(e.failure, e);
      if (e instanceof UnauthorizedException) return refuse('auth_refused_bearer', e);
      throw e;
    }
  }
}

/** Parameter decorator: the Owner the guard verified for this request. */
export const AssistanceOwner = createParamDecorator((_: unknown, ctx: ExecutionContext): VerifiedAssistanceOwner => ctx.switchToHttp().getRequest<OwnerRequest>().assistanceOwner!);
