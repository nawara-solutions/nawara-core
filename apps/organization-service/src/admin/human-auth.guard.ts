import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthGrantFacts, AuthGrantsClient } from './auth-grants-client.js';

export const AUTH_GRANTS_CLIENT = Symbol('AUTH_GRANTS_CLIENT');

/** Request augmented by the guard. `humanBearer` is kept only for the (optional) step-up call that follows authorization. */
export type HumanAuthedRequest = Request & { humanActor?: AuthGrantFacts; humanBearer?: string };

/**
 * Authenticates a human caller of the admin module by forwarding their OWN bearer to Auth (ADR-0042
 * decision 6). This never accepts, and never becomes, a service credential: it is the opposite guard
 * from ServiceTokenGuard, deliberately kept in its own module so the rest of the service — every other
 * controller — stays exactly as boundary.spec.ts already requires (no user-token handling anywhere else).
 */
@Injectable()
export class HumanAuthGuard implements CanActivate {
  constructor(@Inject(AUTH_GRANTS_CLIENT) private readonly grants: AuthGrantsClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<HumanAuthedRequest>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
    if (!match) throw new UnauthorizedException();
    req.humanActor = await this.grants.grantsFor(match[1]);
    req.humanBearer = match[1];
    return true;
  }
}

/** Parameter decorator: the server-derived grant facts the guard obtained from Auth for this caller. */
export const HumanActor = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthGrantFacts =>
  ctx.switchToHttp().getRequest<HumanAuthedRequest>().humanActor!,
);

/** Parameter decorator: the caller's own bearer, forwarded only to Auth's step-up verify endpoint — never logged, never persisted. */
export const HumanBearer = createParamDecorator((_: unknown, ctx: ExecutionContext): string =>
  ctx.switchToHttp().getRequest<HumanAuthedRequest>().humanBearer!,
);
